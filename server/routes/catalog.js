'use strict';

const { badRequest, notFound, conflict, toInt, toText, toBool, toColor } = require('../http');
const { nowLocal } = require('../time');
const { applyStockMovement } = require('../stock');

const MAX_PRICE = 100_000_000;
const MAX_STOCK = 1_000_000;
const MAX_IMAGE_BYTES = 1_000_000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
// Photo d'un produit : image du serveur, fichier de l'artefact claude.ai, ou image intégrée (démo).
const IMAGE_URL = /^(\/api\/images\/\d+|\/_blob\/[0-9a-f]{32}|data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+)$/;

/** Décode une image transmise en « data URL ». */
function decodeImage(value) {
  const m = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/=]+)$/.exec(typeof value === 'string' ? value : '');
  if (!m || !IMAGE_TYPES.includes(m[1])) throw badRequest('Image invalide (formats acceptés : JPEG, PNG, WebP).');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length === 0) throw badRequest('Image vide.');
  if (bytes.length > MAX_IMAGE_BYTES) throw badRequest('Image trop lourde (1 Mo maximum).');
  return { mime: m[1], data: m[2] };
}

/** null pour retirer la photo, undefined pour ne pas y toucher. */
function imageUrlInput(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 1_400_000 || !IMAGE_URL.test(value)) throw badRequest('Photo invalide.');
  return value;
}

/** Texte facultatif qu'on peut effacer : null pour vider, undefined pour ne pas y toucher. */
function clearableText(value, field, max) {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === '') return null;
  return toText(value, field, { max });
}

// Quantités déjà commandées sur des commandes ouvertes (réservées, pas encore déduites du stock).
const RESERVED_SQL = `
  COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE oi.product_id = p.id AND o.status = 'open'), 0)`;

module.exports = function catalogRoutes(app, db, { requireAdmin }) {
  // ================= Familles =================
  const getFamily = (id) => db.get('SELECT * FROM families WHERE id = ? AND archived = 0', id);

  app.get('/api/families', async (req, res) => {
    res.json(await db.all(`
      SELECT f.id, f.name, f.color, f.icon, f.position,
        (SELECT COUNT(*) FROM products p WHERE p.family_id = f.id AND p.archived = 0) AS product_count
      FROM families f WHERE f.archived = 0 ORDER BY f.position, f.name`));
  });

  function familyInput(body, partial) {
    return {
      name: toText(body?.name, 'nom', { max: 60, optional: partial }),
      color: toColor(body?.color, { optional: true }),
      icon: toText(body?.icon, 'icône', { max: 8, optional: true }),
      position: toInt(body?.position, 'position', { min: 0, max: 10_000, optional: true }),
    };
  }

  async function assertUniqueFamilyName(name, exceptId = 0) {
    const dup = await db.get(
      'SELECT id FROM families WHERE archived = 0 AND lower(name) = lower(?) AND id <> ?', name, exceptId);
    if (dup) throw conflict('Une famille porte déjà ce nom.');
  }

  app.post('/api/families', requireAdmin, async (req, res) => {
    const f = familyInput(req.body, false);
    await assertUniqueFamilyName(f.name);
    const position = f.position ?? (await db.get('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM families')).p;
    const r = await db.run('INSERT INTO families (name, color, icon, position) VALUES (?, ?, ?, ?)',
      f.name, f.color ?? '#2563eb', f.icon ?? '🍹', position);
    res.status(201).json(await getFamily(r.lastInsertRowid));
  });

  app.put('/api/families/:id', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const current = await getFamily(id);
    if (!current) throw notFound('Famille introuvable.');
    const f = familyInput(req.body, true);
    if (f.name !== undefined) await assertUniqueFamilyName(f.name, id);
    await db.run('UPDATE families SET name = ?, color = ?, icon = ?, position = ? WHERE id = ?',
      f.name ?? current.name, f.color ?? current.color, f.icon ?? current.icon, f.position ?? current.position, id);
    res.json(await getFamily(id));
  });

  app.delete('/api/families/:id', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    if (!(await getFamily(id))) throw notFound('Famille introuvable.');
    const { n } = await db.get('SELECT COUNT(*) AS n FROM products WHERE family_id = ? AND archived = 0', id);
    if (n > 0) throw conflict(`Impossible de supprimer : cette famille contient encore ${n} produit(s).`);
    await db.run('UPDATE families SET archived = 1 WHERE id = ?', id);
    res.json({ ok: true });
  });

  // ================= Produits =================
  const productSelect = `
    SELECT p.id, p.family_id, f.name AS family_name, p.name, p.format, p.image_url, p.price, p.cost_price,
      p.track_stock, p.stock, p.alert_threshold, p.available,
      ${RESERVED_SQL} AS reserved
    FROM products p JOIN families f ON f.id = p.family_id`;
  const getProduct = (id) => db.get(`${productSelect} WHERE p.id = ? AND p.archived = 0`, id);

  app.get('/api/products', async (req, res) => {
    const familyId = toInt(req.query.family_id, 'famille', { optional: true });
    const rows = familyId
      ? await db.all(`${productSelect} WHERE p.archived = 0 AND p.family_id = ? ORDER BY p.name`, familyId)
      : await db.all(`${productSelect} WHERE p.archived = 0 AND f.archived = 0 ORDER BY f.position, f.name, p.name`);
    res.json(rows);
  });

  function productInput(body, partial) {
    return {
      family_id: toInt(body?.family_id, 'famille', { min: 1, optional: partial }),
      name: toText(body?.name, 'nom', { max: 80, optional: partial }),
      price: toInt(body?.price, 'prix', { min: 0, max: MAX_PRICE, optional: partial }),
      cost_price: toInt(body?.cost_price, "prix d'achat", { min: 0, max: MAX_PRICE, optional: true }),
      alert_threshold: toInt(body?.alert_threshold, "seuil d'alerte", { min: 0, max: MAX_STOCK, optional: true }),
      track_stock: toBool(body?.track_stock, 'suivi du stock', { optional: true }),
      stock: toInt(body?.stock, 'stock', { min: 0, max: MAX_STOCK, optional: true }),
      available: toBool(body?.available, 'disponible', { optional: true }),
      format: clearableText(body?.format, 'format', 30),
      image_url: imageUrlInput(body?.image_url),
    };
  }

  /** Supprime une photo du serveur qu'aucun produit n'utilise plus (un produit dupliqué partage la photo). */
  async function releaseImage(q, url) {
    const m = /^\/api\/images\/(\d+)$/.exec(url ?? '');
    if (!m) return;
    const { n } = await q.get('SELECT COUNT(*) AS n FROM products WHERE image_url = ?', url);
    if (n === 0) await q.run('DELETE FROM images WHERE id = ?', Number(m[1]));
  }

  async function assertUniqueProductName(familyId, name, exceptId = 0, q = db) {
    const dup = await q.get(
      'SELECT id FROM products WHERE archived = 0 AND family_id = ? AND lower(name) = lower(?) AND id <> ?',
      familyId, name, exceptId);
    if (dup) throw conflict('Un produit porte déjà ce nom dans cette famille.');
  }

  app.post('/api/products', requireAdmin, async (req, res) => {
    const p = productInput(req.body, false);
    if (!(await getFamily(p.family_id))) throw badRequest('Famille introuvable.');
    await assertUniqueProductName(p.family_id, p.name);
    const now = req.now;
    const id = await db.transaction(async (tx) => {
      const r = await tx.run(`INSERT INTO products
        (family_id, name, format, image_url, price, cost_price, alert_threshold, track_stock, stock, available,
         created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        p.family_id, p.name, p.format ?? null, p.image_url ?? null, p.price, p.cost_price ?? 0, p.alert_threshold ?? 0,
        p.track_stock ? 1 : 0, p.available === false ? 0 : 1, now, now);
      const productId = Number(r.lastInsertRowid);
      if (p.stock) {
        await applyStockMovement(tx, {
          productId, type: 'entree', delta: p.stock, unitCost: p.cost_price ?? null, note: 'Stock initial',
          userId: req.user.id, at: now,
        });
      }
      return productId;
    });
    res.status(201).json(await getProduct(id));
  });

  app.put('/api/products/:id', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const p = productInput(req.body, true);
    if (p.family_id !== undefined && !(await getFamily(p.family_id))) throw badRequest('Famille introuvable.');
    // Le changement de prix ne modifie pas les commandes déjà saisies (prix figé à la saisie).
    await db.transaction(async (tx) => {
      const current = await tx.get('SELECT * FROM products WHERE id = ? AND archived = 0', id);
      if (!current) throw notFound('Produit introuvable.');
      const merged = {
        family_id: p.family_id ?? current.family_id,
        name: p.name ?? current.name,
        format: p.format === undefined ? current.format : p.format,
        image_url: p.image_url === undefined ? current.image_url : p.image_url,
        price: p.price ?? current.price,
        cost_price: p.cost_price ?? current.cost_price,
        alert_threshold: p.alert_threshold ?? current.alert_threshold,
        track_stock: p.track_stock === undefined ? current.track_stock : (p.track_stock ? 1 : 0),
        stock: p.stock ?? current.stock,
        available: p.available === undefined ? current.available : (p.available ? 1 : 0),
      };
      await assertUniqueProductName(merged.family_id, merged.name, id, tx);
      const now = req.now;
      await tx.run(`UPDATE products SET family_id = ?, name = ?, format = ?, image_url = ?, price = ?, cost_price = ?,
        alert_threshold = ?, track_stock = ?, available = ?, updated_at = ? WHERE id = ?`,
        merged.family_id, merged.name, merged.format, merged.image_url, merged.price, merged.cost_price,
        merged.alert_threshold, merged.track_stock, merged.available, now, id);
      if (current.image_url && merged.image_url !== current.image_url) await releaseImage(tx, current.image_url);
      // Toute correction directe du stock est tracée comme un ajustement.
      if (merged.stock !== current.stock) {
        await applyStockMovement(tx, {
          productId: id, type: 'ajustement', delta: merged.stock - current.stock,
          note: 'Correction depuis la fiche produit', userId: req.user.id, at: now,
        });
      }
    });
    res.json(await getProduct(id));
  });

  app.delete('/api/products/:id', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const product = await getProduct(id);
    if (!product) throw notFound('Produit introuvable.');
    if (product.reserved > 0) throw conflict('Ce produit figure sur une commande ouverte. Clôturez-la avant de le supprimer.');
    // Archivage : l'historique des ventes reste intact.
    await db.run('UPDATE products SET archived = 1, available = 0, updated_at = ? WHERE id = ?', nowLocal(), id);
    res.json({ ok: true });
  });

  // ================= Photos des produits =================
  app.post('/api/images', requireAdmin, async (req, res) => {
    const { mime, data } = decodeImage(req.body?.data);
    const r = await db.run('INSERT INTO images (mime, data, created_at) VALUES (?, ?, ?)', mime, data, nowLocal());
    res.status(201).json({ url: `/api/images/${r.lastInsertRowid}` });
  });

  app.get('/api/images/:id', async (req, res) => {
    const img = await db.get('SELECT mime, data FROM images WHERE id = ?', toInt(req.params.id, 'id'));
    if (!img) throw notFound('Image introuvable.');
    // Une image ne change jamais (une nouvelle photo reçoit un nouvel identifiant).
    res.set({ 'Content-Type': img.mime, 'Cache-Control': 'private, max-age=31536000, immutable' });
    res.send(Buffer.from(img.data, 'base64'));
  });

  // ================= Tables =================
  const tableSelect = `
    SELECT t.id, t.name, t.position,
      o.id AS order_id, o.number AS order_number, o.total AS order_total, o.paid_amount AS order_paid,
      o.created_at AS order_created_at, o.customer_id AS order_customer_id, o.customer_name AS order_customer_name
    FROM bar_tables t LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'open'`;
  const getTable = (id) => db.get(`${tableSelect} WHERE t.id = ? AND t.archived = 0`, id);

  app.get('/api/tables', async (req, res) => {
    res.json(await db.all(`${tableSelect} WHERE t.archived = 0 ORDER BY t.position, t.name`));
  });

  async function assertUniqueTableName(name, exceptId = 0) {
    const dup = await db.get(
      'SELECT id FROM bar_tables WHERE archived = 0 AND lower(name) = lower(?) AND id <> ?', name, exceptId);
    if (dup) throw conflict('Une table porte déjà ce nom.');
  }

  app.post('/api/tables', requireAdmin, async (req, res) => {
    const name = toText(req.body?.name, 'nom', { max: 40 });
    await assertUniqueTableName(name);
    const position = toInt(req.body?.position, 'position', { min: 0, max: 10_000, optional: true })
      ?? (await db.get('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM bar_tables')).p;
    const r = await db.run('INSERT INTO bar_tables (name, position) VALUES (?, ?)', name, position);
    res.status(201).json(await getTable(r.lastInsertRowid));
  });

  app.put('/api/tables/:id', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const current = await getTable(id);
    if (!current) throw notFound('Table introuvable.');
    const name = toText(req.body?.name, 'nom', { max: 40, optional: true }) ?? current.name;
    const position = toInt(req.body?.position, 'position', { min: 0, max: 10_000, optional: true }) ?? current.position;
    await assertUniqueTableName(name, id);
    await db.transaction(async (tx) => {
      await tx.run('UPDATE bar_tables SET name = ?, position = ? WHERE id = ?', name, position, id);
      await tx.run("UPDATE orders SET table_name = ? WHERE table_id = ? AND status = 'open'", name, id);
    });
    res.json(await getTable(id));
  });

  app.delete('/api/tables/:id', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const table = await getTable(id);
    if (!table) throw notFound('Table introuvable.');
    if (table.order_id) throw conflict('Cette table a une commande ouverte.');
    await db.run('UPDATE bar_tables SET archived = 1 WHERE id = ?', id);
    res.json({ ok: true });
  });

  // ================= Moyens de paiement =================
  const getMethod = (id) => db.get('SELECT * FROM payment_methods WHERE id = ? AND archived = 0', id);
  const METHOD_TYPES = ['cash', 'mobile_money', 'other'];

  app.get('/api/payment-methods', async (req, res) => {
    res.json(await db.all('SELECT id, name, type, position FROM payment_methods WHERE archived = 0 ORDER BY position, name'));
  });

  function methodType(value, optional) {
    if (value === undefined && optional) return undefined;
    if (!METHOD_TYPES.includes(value)) throw badRequest('Type de paiement invalide (cash, mobile_money ou other).');
    return value;
  }

  app.post('/api/payment-methods', requireAdmin, async (req, res) => {
    const name = toText(req.body?.name, 'nom', { max: 40 });
    const type = methodType(req.body?.type, false);
    const { p: position } = await db.get('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM payment_methods');
    const r = await db.run('INSERT INTO payment_methods (name, type, position) VALUES (?, ?, ?)', name, type, position);
    res.status(201).json(await getMethod(r.lastInsertRowid));
  });

  app.put('/api/payment-methods/:id', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const current = await getMethod(id);
    if (!current) throw notFound('Moyen de paiement introuvable.');
    const name = toText(req.body?.name, 'nom', { max: 40, optional: true }) ?? current.name;
    const type = methodType(req.body?.type, true) ?? current.type;
    await db.run('UPDATE payment_methods SET name = ?, type = ? WHERE id = ?', name, type, id);
    res.json(await getMethod(id));
  });

  app.delete('/api/payment-methods/:id', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    if (!(await getMethod(id))) throw notFound('Moyen de paiement introuvable.');
    await db.run('UPDATE payment_methods SET archived = 1 WHERE id = ?', id);
    res.json({ ok: true });
  });
};
