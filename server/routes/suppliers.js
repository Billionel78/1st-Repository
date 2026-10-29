'use strict';

const { badRequest, notFound, conflict, toInt, toText, toBool } = require('../http');
const { applyStockMovement } = require('../stock');
const { isIsoDate } = require('../time');

const MAX_PRICE = 100_000_000;
const MAX_PACKS = 100_000;

/** Texte facultatif qu'on peut effacer : null pour vider, undefined pour ne pas y toucher. */
function clearable(value, field, max) {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === '') return null;
  return toText(value, field, { max });
}

// Coût d'achat d'une unité (bouteille, verre…) à partir du prix du conditionnement.
const unitCost = (packPrice, packSize) => Math.round(packPrice / packSize);

const SUPPLIER_SELECT = `
  SELECT s.id, s.name, s.contact, s.phone, s.address, s.notes, s.created_at,
    (SELECT COUNT(*) FROM supplier_prices sp JOIN products p ON p.id = sp.product_id
      WHERE sp.supplier_id = s.id AND p.archived = 0) AS products_count,
    (SELECT COUNT(*) FROM purchases pu WHERE pu.supplier_id = s.id AND pu.status = 'received') AS purchases_count,
    COALESCE((SELECT SUM(pu.total) FROM purchases pu WHERE pu.supplier_id = s.id AND pu.status = 'received'), 0) AS total_purchased,
    COALESCE((SELECT SUM(pu.total - pu.paid_amount) FROM purchases pu
      WHERE pu.supplier_id = s.id AND pu.status = 'received'), 0) AS balance_due,
    (SELECT MAX(pu.created_at) FROM purchases pu WHERE pu.supplier_id = s.id AND pu.status = 'received') AS last_purchase
  FROM suppliers s`;

const PURCHASE_SELECT = `
  SELECT pu.id, pu.number, pu.supplier_id, pu.supplier_name, pu.status, pu.total, pu.paid_amount,
    pu.total - pu.paid_amount AS remaining, pu.note, pu.cancel_reason, pu.created_at, pu.updated_at,
    u.full_name AS created_by_name
  FROM purchases pu LEFT JOIN users u ON u.id = pu.created_by`;

async function nextPurchaseNumber(q, at) {
  const prefix = `ACH-${at.slice(0, 10).replaceAll('-', '')}-`;
  const last = await q.get('SELECT number FROM purchases WHERE number LIKE ? ORDER BY number DESC LIMIT 1', `${prefix}%`);
  const seq = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

module.exports = function supplierRoutes(app, db, { requireAdmin }) {
  // ---------- Fournisseurs ----------
  const getSupplier = (id, q = db) => q.get(`${SUPPLIER_SELECT} WHERE s.id = ? AND s.archived = 0`, id);

  function input(body, partial) {
    return {
      name: toText(body?.name, 'nom', { max: 80, optional: partial }),
      contact: clearable(body?.contact, 'contact', 80),
      phone: clearable(body?.phone, 'téléphone', 30),
      address: clearable(body?.address, 'adresse', 200),
      notes: clearable(body?.notes, 'notes', 300),
    };
  }

  async function assertUniqueName(name, exceptId, q = db) {
    const dup = await q.get('SELECT id FROM suppliers WHERE lower(name) = lower(?) AND archived = 0 AND id <> ?', name, exceptId ?? 0);
    if (dup) throw conflict(`Un fournisseur « ${name} » existe déjà.`);
  }

  app.get('/api/suppliers', requireAdmin, async (req, res) => {
    res.json(await db.all(`${SUPPLIER_SELECT} WHERE s.archived = 0 ORDER BY lower(s.name)`));
  });

  app.get('/api/suppliers/:id', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const supplier = await getSupplier(id);
    if (!supplier) throw notFound('Fournisseur introuvable.');
    supplier.prices = await db.all(`
      SELECT sp.product_id, p.name AS product_name, p.format, p.image_url, f.name AS family_name,
        sp.pack_size, sp.pack_price, p.cost_price, p.price, p.stock, p.track_stock, sp.updated_at
      FROM supplier_prices sp JOIN products p ON p.id = sp.product_id JOIN families f ON f.id = p.family_id
      WHERE sp.supplier_id = ? AND p.archived = 0
      ORDER BY f.position, f.name, p.name`, id);
    for (const r of supplier.prices) r.unit_cost = unitCost(r.pack_price, r.pack_size);
    supplier.purchases = await db.all(`${PURCHASE_SELECT} WHERE pu.supplier_id = ?
      ORDER BY pu.created_at DESC, pu.id DESC LIMIT 200`, id);
    res.json(supplier);
  });

  app.post('/api/suppliers', requireAdmin, async (req, res) => {
    const s = input(req.body, false);
    await assertUniqueName(s.name);
    const r = await db.run(`INSERT INTO suppliers (name, contact, phone, address, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`, s.name, s.contact ?? null, s.phone ?? null, s.address ?? null, s.notes ?? null,
    req.now, req.now);
    res.status(201).json(await getSupplier(r.lastInsertRowid));
  });

  app.put('/api/suppliers/:id', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const current = await db.get('SELECT * FROM suppliers WHERE id = ? AND archived = 0', id);
    if (!current) throw notFound('Fournisseur introuvable.');
    const s = input(req.body, true);
    const name = s.name ?? current.name;
    await assertUniqueName(name, id);
    const keep = (k) => (s[k] === undefined ? current[k] : s[k]);
    await db.run(`UPDATE suppliers SET name = ?, contact = ?, phone = ?, address = ?, notes = ?, updated_at = ?
      WHERE id = ?`, name, keep('contact'), keep('phone'), keep('address'), keep('notes'), req.now, id);
    res.json(await getSupplier(id));
  });

  // Archivage : l'historique des approvisionnements est conservé.
  app.delete('/api/suppliers/:id', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const r = await db.run('UPDATE suppliers SET archived = 1, updated_at = ? WHERE id = ? AND archived = 0', req.now, id);
    if (!r.changes) throw notFound('Fournisseur introuvable.');
    res.json({ ok: true });
  });

  // ---------- Catalogue de prix ----------
  /** Prix d'un produit chez ce fournisseur : prix du conditionnement (casier, carton…) et nombre d'unités. */
  app.put('/api/suppliers/:id/prices/:productId', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const productId = toInt(req.params.productId, 'produit');
    const packSize = toInt(req.body?.pack_size, 'unités par conditionnement', { min: 1, max: 10_000, optional: true }) ?? 1;
    const packPrice = toInt(req.body?.pack_price, "prix d'achat", { min: 0, max: MAX_PRICE });
    if (!(await getSupplier(id))) throw notFound('Fournisseur introuvable.');
    const p = await db.get('SELECT id FROM products WHERE id = ? AND archived = 0', productId);
    if (!p) throw badRequest('Produit introuvable.');
    await db.run(`INSERT INTO supplier_prices (supplier_id, product_id, pack_size, pack_price, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (supplier_id, product_id) DO UPDATE SET pack_size = excluded.pack_size,
        pack_price = excluded.pack_price, updated_at = excluded.updated_at`, id, productId, packSize, packPrice, req.now);
    res.json({ product_id: productId, pack_size: packSize, pack_price: packPrice, unit_cost: unitCost(packPrice, packSize) });
  });

  app.delete('/api/suppliers/:id/prices/:productId', requireAdmin, async (req, res) => {
    const r = await db.run('DELETE FROM supplier_prices WHERE supplier_id = ? AND product_id = ?',
      toInt(req.params.id, 'id'), toInt(req.params.productId, 'produit'));
    if (!r.changes) throw notFound('Ce produit n’est pas dans le catalogue du fournisseur.');
    res.json({ ok: true });
  });

  // Comparaison des prix : pour chaque produit, les fournisseurs qui le proposent (du moins cher au plus cher).
  app.get('/api/supplier-prices', requireAdmin, async (req, res) => {
    const rows = await db.all(`
      SELECT sp.product_id, p.name AS product_name, sp.supplier_id, s.name AS supplier_name, sp.pack_size, sp.pack_price
      FROM supplier_prices sp JOIN suppliers s ON s.id = sp.supplier_id JOIN products p ON p.id = sp.product_id
      WHERE s.archived = 0 AND p.archived = 0 ${req.query.product_id !== undefined ? 'AND sp.product_id = ?' : ''}
      ORDER BY p.name, sp.product_id`,
    ...(req.query.product_id !== undefined ? [toInt(req.query.product_id, 'produit')] : []));
    for (const r of rows) r.unit_cost = unitCost(r.pack_price, r.pack_size);
    rows.sort((a, b) => a.product_id - b.product_id || a.unit_cost - b.unit_cost);
    res.json(rows);
  });

  // ---------- Approvisionnements ----------
  const getPurchase = async (id, q = db) => {
    const purchase = await q.get(`${PURCHASE_SELECT} WHERE pu.id = ?`, id);
    if (purchase) {
      purchase.items = await q.all(`SELECT pi.*, p.track_stock FROM purchase_items pi
        JOIN products p ON p.id = pi.product_id WHERE pi.purchase_id = ? ORDER BY pi.id`, id);
    }
    return purchase;
  };

  app.get('/api/purchases', requireAdmin, async (req, res) => {
    const where = [];
    const params = [];
    if (req.query.supplier_id !== undefined) {
      where.push('pu.supplier_id = ?');
      params.push(toInt(req.query.supplier_id, 'fournisseur'));
    }
    for (const [key, op] of [['from', '>='], ['to', '<=']]) {
      if (req.query[key] === undefined) continue;
      if (!isIsoDate(req.query[key])) throw badRequest('Date invalide (format AAAA-MM-JJ).');
      where.push(`substr(pu.created_at, 1, 10) ${op} ?`);
      params.push(req.query[key]);
    }
    if (req.query.unpaid !== undefined) where.push("pu.status = 'received' AND pu.paid_amount < pu.total");
    res.json(await db.all(`${PURCHASE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY pu.created_at DESC, pu.id DESC LIMIT 500`, ...params));
  });

  app.get('/api/purchases/:id', requireAdmin, async (req, res) => {
    const purchase = await getPurchase(toInt(req.params.id, 'id'));
    if (!purchase) throw notFound('Approvisionnement introuvable.');
    res.json(purchase);
  });

  /**
   * Réception d'une livraison : les quantités entrent en stock, le prix d'achat des produits est mis à jour
   * et (par défaut) le catalogue du fournisseur garde le dernier prix payé.
   * Lignes : { product_id, packs, pack_size?, pack_price? } — sans prix, celui du catalogue est utilisé.
   */
  app.post('/api/purchases', requireAdmin, async (req, res) => {
    const supplierId = toInt(req.body?.supplier_id, 'fournisseur', { min: 1 });
    const lines = req.body?.items;
    if (!Array.isArray(lines) || !lines.length) throw badRequest('Ajoutez au moins un produit à l’approvisionnement.');
    if (lines.length > 200) throw badRequest('Trop de lignes (200 au maximum).');
    const note = toText(req.body?.note, 'note', { max: 200, optional: true }) ?? null;
    const updatePrices = toBool(req.body?.update_prices, 'mettre à jour les prix', { optional: true }) ?? true;
    const paidInput = req.body?.paid_amount;

    const id = await db.transaction(async (tx) => {
      const supplier = await tx.get('SELECT id, name FROM suppliers WHERE id = ? AND archived = 0', supplierId);
      if (!supplier) throw badRequest('Fournisseur introuvable.');
      const items = [];
      const seen = new Set();
      for (const [i, line] of lines.entries()) {
        const productId = toInt(line?.product_id, `produit (ligne ${i + 1})`, { min: 1 });
        if (seen.has(productId)) throw badRequest('Un même produit apparaît sur deux lignes : regroupez les quantités.');
        seen.add(productId);
        const product = await tx.get('SELECT id, name, track_stock FROM products WHERE id = ? AND archived = 0', productId);
        if (!product) throw badRequest(`Produit introuvable (ligne ${i + 1}).`);
        const catalog = await tx.get('SELECT pack_size, pack_price FROM supplier_prices WHERE supplier_id = ? AND product_id = ?',
          supplierId, productId);
        const packs = toInt(line.packs, `quantité de « ${product.name} »`, { min: 1, max: MAX_PACKS });
        const packSize = toInt(line.pack_size, `unités par conditionnement de « ${product.name} »`, { min: 1, max: 10_000, optional: true })
          ?? catalog?.pack_size ?? 1;
        const packPrice = toInt(line.pack_price, `prix d'achat de « ${product.name} »`, { min: 0, max: MAX_PRICE, optional: true })
          ?? catalog?.pack_price;
        if (packPrice === undefined) throw badRequest(`Indiquez le prix d'achat de « ${product.name} ».`);
        items.push({ product, packs, packSize, packPrice, quantity: packs * packSize, total: packs * packPrice });
      }
      const total = items.reduce((a, it) => a + it.total, 0);
      const paid = paidInput === 'all' || paidInput === true ? total
        : toInt(paidInput, 'montant payé', { min: 0, max: total, optional: true }) ?? 0;
      const number = await nextPurchaseNumber(tx, req.now);
      const r = await tx.run(`INSERT INTO purchases (number, supplier_id, supplier_name, status, total, paid_amount, note,
          created_by, created_at, updated_at) VALUES (?, ?, ?, 'received', ?, ?, ?, ?, ?, ?)`,
      number, supplier.id, supplier.name, total, paid, note, req.user.id, req.now, req.now);
      const purchaseId = r.lastInsertRowid;
      for (const it of items) {
        const cost = unitCost(it.packPrice, it.packSize);
        await tx.run(`INSERT INTO purchase_items (purchase_id, product_id, product_name, packs, pack_size, pack_price,
          quantity, unit_cost, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        purchaseId, it.product.id, it.product.name, it.packs, it.packSize, it.packPrice, it.quantity, cost, it.total);
        if (it.product.track_stock) {
          await applyStockMovement(tx, {
            productId: it.product.id, type: 'entree', delta: it.quantity, unitCost: cost,
            note: `Appro. ${number} — ${supplier.name}`, purchaseId, userId: req.user.id, at: req.now,
          });
        }
        await tx.run('UPDATE products SET cost_price = ?, updated_at = ? WHERE id = ?', cost, req.now, it.product.id);
        if (updatePrices) {
          await tx.run(`INSERT INTO supplier_prices (supplier_id, product_id, pack_size, pack_price, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (supplier_id, product_id) DO UPDATE SET pack_size = excluded.pack_size,
              pack_price = excluded.pack_price, updated_at = excluded.updated_at`,
          supplier.id, it.product.id, it.packSize, it.packPrice, req.now);
        }
      }
      return purchaseId;
    });
    res.status(201).json(await getPurchase(id));
  });

  // Règlement du fournisseur (en une ou plusieurs fois).
  app.post('/api/purchases/:id/payments', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    await db.transaction(async (tx) => {
      const p = await tx.get('SELECT * FROM purchases WHERE id = ?', id);
      if (!p) throw notFound('Approvisionnement introuvable.');
      if (p.status !== 'received') throw conflict('Cet approvisionnement est annulé.');
      const remaining = p.total - p.paid_amount;
      if (remaining <= 0) throw conflict('Cet approvisionnement est déjà entièrement payé.');
      const amount = toInt(req.body?.amount, 'montant', { min: 1, max: remaining });
      await tx.run('UPDATE purchases SET paid_amount = paid_amount + ?, updated_at = ? WHERE id = ?', amount, req.now, id);
    });
    res.json(await getPurchase(id));
  });

  // Annulation (erreur de saisie, livraison retournée) : les quantités ressortent du stock.
  app.post('/api/purchases/:id/cancel', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const reason = toText(req.body?.reason, "motif d'annulation", { max: 200 });
    await db.transaction(async (tx) => {
      const p = await tx.get('SELECT * FROM purchases WHERE id = ?', id);
      if (!p) throw notFound('Approvisionnement introuvable.');
      if (p.status !== 'received') throw conflict('Cet approvisionnement est déjà annulé.');
      const items = await tx.all(`SELECT pi.product_id, pi.quantity, p.track_stock FROM purchase_items pi
        JOIN products p ON p.id = pi.product_id WHERE pi.purchase_id = ?`, id);
      for (const it of items) {
        if (!it.track_stock) continue;
        await applyStockMovement(tx, {
          productId: it.product_id, type: 'ajustement', delta: -it.quantity,
          note: `Annulation appro. ${p.number}`, purchaseId: id, userId: req.user.id, at: req.now,
        });
      }
      await tx.run("UPDATE purchases SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?", reason, req.now, id);
    });
    res.json(await getPurchase(id));
  });
};
