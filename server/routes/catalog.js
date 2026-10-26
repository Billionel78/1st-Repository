'use strict';

const { badRequest, notFound, conflict, toInt, toText, toBool, toColor } = require('../http');
const { nowLocal } = require('../time');
const { transaction } = require('../db');
const { applyStockMovement } = require('../stock');

const MAX_PRICE = 100_000_000;
const MAX_STOCK = 1_000_000;

// Quantités déjà commandées sur des commandes ouvertes (réservées, pas encore déduites du stock).
const RESERVED_SQL = `
  COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE oi.product_id = p.id AND o.status = 'open'), 0)`;

module.exports = function catalogRoutes(app, db, { requireAdmin }) {
  // ================= Familles =================
  const getFamily = (id) => db.prepare('SELECT * FROM families WHERE id = ? AND archived = 0').get(id);

  app.get('/api/families', (req, res) => {
    res.json(db.prepare(`
      SELECT f.id, f.name, f.color, f.icon, f.position,
        (SELECT COUNT(*) FROM products p WHERE p.family_id = f.id AND p.archived = 0) AS product_count
      FROM families f WHERE f.archived = 0 ORDER BY f.position, f.name`).all());
  });

  function familyInput(body, partial) {
    return {
      name: toText(body?.name, 'nom', { max: 60, optional: partial }),
      color: toColor(body?.color, { optional: true }),
      icon: toText(body?.icon, 'icône', { max: 8, optional: true }),
      position: toInt(body?.position, 'position', { min: 0, max: 10_000, optional: true }),
    };
  }

  function assertUniqueFamilyName(name, exceptId = 0) {
    const dup = db.prepare(
      'SELECT id FROM families WHERE archived = 0 AND name = ? COLLATE NOCASE AND id <> ?'
    ).get(name, exceptId);
    if (dup) throw conflict('Une famille porte déjà ce nom.');
  }

  app.post('/api/families', requireAdmin, (req, res) => {
    const f = familyInput(req.body, false);
    assertUniqueFamilyName(f.name);
    const position = f.position ?? db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM families').get().p;
    const r = db.prepare('INSERT INTO families (name, color, icon, position) VALUES (?, ?, ?, ?)')
      .run(f.name, f.color ?? '#2563eb', f.icon ?? '🍹', position);
    res.status(201).json(getFamily(r.lastInsertRowid));
  });

  app.put('/api/families/:id', requireAdmin, (req, res) => {
    const id = toInt(req.params.id, 'id');
    const current = getFamily(id);
    if (!current) throw notFound('Famille introuvable.');
    const f = familyInput(req.body, true);
    if (f.name !== undefined) assertUniqueFamilyName(f.name, id);
    db.prepare('UPDATE families SET name = ?, color = ?, icon = ?, position = ? WHERE id = ?').run(
      f.name ?? current.name, f.color ?? current.color, f.icon ?? current.icon, f.position ?? current.position, id
    );
    res.json(getFamily(id));
  });

  app.delete('/api/families/:id', requireAdmin, (req, res) => {
    const id = toInt(req.params.id, 'id');
    if (!getFamily(id)) throw notFound('Famille introuvable.');
    const n = db.prepare('SELECT COUNT(*) AS n FROM products WHERE family_id = ? AND archived = 0').get(id).n;
    if (n > 0) throw conflict(`Impossible de supprimer : cette famille contient encore ${n} produit(s).`);
    db.prepare('UPDATE families SET archived = 1 WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // ================= Produits =================
  const productSelect = `
    SELECT p.id, p.family_id, f.name AS family_name, p.name, p.price, p.cost_price, p.track_stock, p.stock,
      p.alert_threshold, p.available,
      ${RESERVED_SQL} AS reserved
    FROM products p JOIN families f ON f.id = p.family_id`;
  const getProduct = (id) => db.prepare(`${productSelect} WHERE p.id = ? AND p.archived = 0`).get(id);

  app.get('/api/products', (req, res) => {
    const familyId = toInt(req.query.family_id, 'famille', { optional: true });
    const rows = familyId
      ? db.prepare(`${productSelect} WHERE p.archived = 0 AND p.family_id = ? ORDER BY p.name`).all(familyId)
      : db.prepare(`${productSelect} WHERE p.archived = 0 AND f.archived = 0 ORDER BY f.position, f.name, p.name`).all();
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
    };
  }

  function assertUniqueProductName(familyId, name, exceptId = 0) {
    const dup = db.prepare(
      'SELECT id FROM products WHERE archived = 0 AND family_id = ? AND name = ? COLLATE NOCASE AND id <> ?'
    ).get(familyId, name, exceptId);
    if (dup) throw conflict('Un produit porte déjà ce nom dans cette famille.');
  }

  app.post('/api/products', requireAdmin, (req, res) => {
    const p = productInput(req.body, false);
    if (!getFamily(p.family_id)) throw badRequest('Famille introuvable.');
    assertUniqueProductName(p.family_id, p.name);
    const now = nowLocal();
    const id = transaction(db, () => {
      const r = db.prepare(`INSERT INTO products
        (family_id, name, price, cost_price, alert_threshold, track_stock, stock, available, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`).run(
        p.family_id, p.name, p.price, p.cost_price ?? 0, p.alert_threshold ?? 0, p.track_stock ? 1 : 0,
        p.available === false ? 0 : 1, now, now
      );
      const productId = Number(r.lastInsertRowid);
      if (p.stock) {
        applyStockMovement(db, {
          productId, type: 'entree', delta: p.stock, unitCost: p.cost_price ?? null, note: 'Stock initial',
          userId: req.user.id, at: now,
        });
      }
      return productId;
    });
    res.status(201).json(getProduct(id));
  });

  app.put('/api/products/:id', requireAdmin, (req, res) => {
    const id = toInt(req.params.id, 'id');
    const current = db.prepare('SELECT * FROM products WHERE id = ? AND archived = 0').get(id);
    if (!current) throw notFound('Produit introuvable.');
    const p = productInput(req.body, true);
    if (p.family_id !== undefined && !getFamily(p.family_id)) throw badRequest('Famille introuvable.');
    const merged = {
      family_id: p.family_id ?? current.family_id,
      name: p.name ?? current.name,
      price: p.price ?? current.price,
      cost_price: p.cost_price ?? current.cost_price,
      alert_threshold: p.alert_threshold ?? current.alert_threshold,
      track_stock: p.track_stock === undefined ? current.track_stock : (p.track_stock ? 1 : 0),
      stock: p.stock ?? current.stock,
      available: p.available === undefined ? current.available : (p.available ? 1 : 0),
    };
    assertUniqueProductName(merged.family_id, merged.name, id);
    // Le changement de prix ne modifie pas les commandes déjà saisies (prix figé à la saisie).
    transaction(db, () => {
      const now = nowLocal();
      db.prepare(`UPDATE products SET family_id = ?, name = ?, price = ?, cost_price = ?, alert_threshold = ?,
        track_stock = ?, available = ?, updated_at = ? WHERE id = ?`).run(
        merged.family_id, merged.name, merged.price, merged.cost_price, merged.alert_threshold,
        merged.track_stock, merged.available, now, id
      );
      // Toute correction directe du stock est tracée comme un ajustement.
      if (merged.stock !== current.stock) {
        applyStockMovement(db, {
          productId: id, type: 'ajustement', delta: merged.stock - current.stock,
          note: 'Correction depuis la fiche produit', userId: req.user.id, at: now,
        });
      }
    });
    res.json(getProduct(id));
  });

  app.delete('/api/products/:id', requireAdmin, (req, res) => {
    const id = toInt(req.params.id, 'id');
    const product = getProduct(id);
    if (!product) throw notFound('Produit introuvable.');
    if (product.reserved > 0) throw conflict('Ce produit figure sur une commande ouverte. Clôturez-la avant de le supprimer.');
    // Archivage : l'historique des ventes reste intact.
    db.prepare('UPDATE products SET archived = 1, available = 0, updated_at = ? WHERE id = ?').run(nowLocal(), id);
    res.json({ ok: true });
  });

  // ================= Tables =================
  const tableSelect = `
    SELECT t.id, t.name, t.position,
      o.id AS order_id, o.number AS order_number, o.total AS order_total, o.paid_amount AS order_paid,
      o.created_at AS order_created_at
    FROM bar_tables t LEFT JOIN orders o ON o.table_id = t.id AND o.status = 'open'`;
  const getTable = (id) => db.prepare(`${tableSelect} WHERE t.id = ? AND t.archived = 0`).get(id);

  app.get('/api/tables', (req, res) => {
    res.json(db.prepare(`${tableSelect} WHERE t.archived = 0 ORDER BY t.position, t.name`).all());
  });

  function assertUniqueTableName(name, exceptId = 0) {
    const dup = db.prepare(
      'SELECT id FROM bar_tables WHERE archived = 0 AND name = ? COLLATE NOCASE AND id <> ?'
    ).get(name, exceptId);
    if (dup) throw conflict('Une table porte déjà ce nom.');
  }

  app.post('/api/tables', requireAdmin, (req, res) => {
    const name = toText(req.body?.name, 'nom', { max: 40 });
    assertUniqueTableName(name);
    const position = toInt(req.body?.position, 'position', { min: 0, max: 10_000, optional: true })
      ?? db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM bar_tables').get().p;
    const r = db.prepare('INSERT INTO bar_tables (name, position) VALUES (?, ?)').run(name, position);
    res.status(201).json(getTable(r.lastInsertRowid));
  });

  app.put('/api/tables/:id', requireAdmin, (req, res) => {
    const id = toInt(req.params.id, 'id');
    const current = getTable(id);
    if (!current) throw notFound('Table introuvable.');
    const name = toText(req.body?.name, 'nom', { max: 40, optional: true }) ?? current.name;
    const position = toInt(req.body?.position, 'position', { min: 0, max: 10_000, optional: true }) ?? current.position;
    assertUniqueTableName(name, id);
    db.prepare('UPDATE bar_tables SET name = ?, position = ? WHERE id = ?').run(name, position, id);
    db.prepare("UPDATE orders SET table_name = ? WHERE table_id = ? AND status = 'open'").run(name, id);
    res.json(getTable(id));
  });

  app.delete('/api/tables/:id', requireAdmin, (req, res) => {
    const id = toInt(req.params.id, 'id');
    const table = getTable(id);
    if (!table) throw notFound('Table introuvable.');
    if (table.order_id) throw conflict('Cette table a une commande ouverte.');
    db.prepare('UPDATE bar_tables SET archived = 1 WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // ================= Moyens de paiement =================
  const getMethod = (id) => db.prepare('SELECT * FROM payment_methods WHERE id = ? AND archived = 0').get(id);
  const METHOD_TYPES = ['cash', 'mobile_money', 'other'];

  app.get('/api/payment-methods', (req, res) => {
    res.json(db.prepare(
      'SELECT id, name, type, position FROM payment_methods WHERE archived = 0 ORDER BY position, name'
    ).all());
  });

  function methodType(value, optional) {
    if (value === undefined && optional) return undefined;
    if (!METHOD_TYPES.includes(value)) throw badRequest('Type de paiement invalide (cash, mobile_money ou other).');
    return value;
  }

  app.post('/api/payment-methods', requireAdmin, (req, res) => {
    const name = toText(req.body?.name, 'nom', { max: 40 });
    const type = methodType(req.body?.type, false);
    const position = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM payment_methods').get().p;
    const r = db.prepare('INSERT INTO payment_methods (name, type, position) VALUES (?, ?, ?)').run(name, type, position);
    res.status(201).json(getMethod(r.lastInsertRowid));
  });

  app.put('/api/payment-methods/:id', requireAdmin, (req, res) => {
    const id = toInt(req.params.id, 'id');
    const current = getMethod(id);
    if (!current) throw notFound('Moyen de paiement introuvable.');
    const name = toText(req.body?.name, 'nom', { max: 40, optional: true }) ?? current.name;
    const type = methodType(req.body?.type, true) ?? current.type;
    db.prepare('UPDATE payment_methods SET name = ?, type = ? WHERE id = ?').run(name, type, id);
    res.json(getMethod(id));
  });

  app.delete('/api/payment-methods/:id', requireAdmin, (req, res) => {
    const id = toInt(req.params.id, 'id');
    if (!getMethod(id)) throw notFound('Moyen de paiement introuvable.');
    db.prepare('UPDATE payment_methods SET archived = 1 WHERE id = ?').run(id);
    res.json({ ok: true });
  });
};
