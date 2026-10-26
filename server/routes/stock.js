'use strict';

const { badRequest, notFound, conflict, toInt, toText } = require('../http');
const { transaction } = require('../db');
const { applyStockMovement } = require('../stock');
const { isIsoDate } = require('../time');

const MAX_QTY = 1_000_000;
const MANUAL_TYPES = ['entree', 'perte', 'inventaire'];

module.exports = function stockRoutes(app, db, { requireAdmin }) {
  // État du stock des produits suivis.
  app.get('/api/stock', requireAdmin, (req, res) => {
    const rows = db.prepare(`
      SELECT p.id, p.name, p.family_id, f.name AS family_name, p.price, p.cost_price, p.stock, p.alert_threshold,
        p.available,
        COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                  WHERE oi.product_id = p.id AND o.status = 'open'), 0) AS reserved,
        (SELECT MAX(created_at) FROM stock_movements m WHERE m.product_id = p.id AND m.type = 'entree') AS last_entry
      FROM products p JOIN families f ON f.id = p.family_id
      WHERE p.archived = 0 AND f.archived = 0 AND p.track_stock = 1
      ORDER BY f.position, f.name, p.name`).all();
    for (const r of rows) {
      r.free = r.stock - r.reserved;
      r.status = r.free <= 0 ? 'rupture' : r.free <= r.alert_threshold ? 'alerte' : 'ok';
      r.stock_value = Math.max(r.stock, 0) * r.cost_price;
    }
    res.json(rows);
  });

  /**
   * Mouvement manuel :
   *  - entree      : réapprovisionnement (+quantité), prix d'achat unitaire facultatif ;
   *  - perte       : casse, offert, périmé… (−quantité) ;
   *  - inventaire  : quantité réellement comptée, l'écart est enregistré.
   */
  app.post('/api/stock/movements', requireAdmin, (req, res) => {
    const productId = toInt(req.body?.product_id, 'produit', { min: 1 });
    const type = req.body?.type;
    if (!MANUAL_TYPES.includes(type)) throw badRequest('Type de mouvement invalide (entree, perte ou inventaire).');
    const quantity = toInt(req.body?.quantity, 'quantité', { min: type === 'inventaire' ? 0 : 1, max: MAX_QTY });
    const unitCost = toInt(req.body?.unit_cost, "prix d'achat", { min: 0, max: 100_000_000, optional: true });
    const note = toText(req.body?.note, 'note', { max: 200, optional: true }) ?? null;

    const result = transaction(db, () => {
      const p = db.prepare('SELECT * FROM products WHERE id = ? AND archived = 0').get(productId);
      if (!p) throw notFound('Produit introuvable.');
      if (!p.track_stock) throw conflict(`Le suivi du stock n’est pas activé pour « ${p.name} ».`);
      let delta;
      if (type === 'entree') delta = quantity;
      else if (type === 'perte') delta = -quantity;
      else delta = quantity - p.stock;
      if (type === 'inventaire' && delta === 0) return { stock: p.stock, delta: 0 };
      const stock = applyStockMovement(db, {
        productId, type, delta, unitCost: type === 'entree' ? (unitCost ?? null) : null, note, userId: req.user.id,
      });
      // Une entrée avec un nouveau prix d'achat met à jour le prix d'achat du produit.
      if (type === 'entree' && unitCost !== undefined) {
        db.prepare('UPDATE products SET cost_price = ? WHERE id = ?').run(unitCost, productId);
      }
      return { stock, delta };
    });
    res.status(201).json(result);
  });

  app.get('/api/stock/movements', requireAdmin, (req, res) => {
    const where = [];
    const params = [];
    if (req.query.product_id !== undefined) {
      where.push('m.product_id = ?');
      params.push(toInt(req.query.product_id, 'produit'));
    }
    for (const [key, op] of [['from', '>='], ['to', '<=']]) {
      if (req.query[key] === undefined) continue;
      if (!isIsoDate(req.query[key])) throw badRequest('Date invalide (format AAAA-MM-JJ).');
      where.push(`substr(m.created_at, 1, 10) ${op} ?`);
      params.push(req.query[key]);
    }
    if (req.query.type !== undefined) {
      where.push('m.type = ?');
      params.push(String(req.query.type));
    }
    const limit = toInt(req.query.limit, 'limite', { min: 1, max: 2000, optional: true }) ?? 300;
    res.json(db.prepare(`
      SELECT m.id, m.product_id, p.name AS product_name, m.type, m.quantity, m.stock_after, m.unit_cost, m.note,
        m.order_id, o.number AS order_number, m.created_at, u.full_name AS created_by_name
      FROM stock_movements m
      JOIN products p ON p.id = m.product_id
      LEFT JOIN orders o ON o.id = m.order_id
      LEFT JOIN users u ON u.id = m.created_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY m.id DESC LIMIT ${limit}`).all(...params));
  });
};
