'use strict';

const { badRequest } = require('../http');
const { todayLocal, isIsoDate } = require('../time');

const MAX_RANGE_DAYS = 366;

/**
 * Statistiques calculées uniquement à partir des données réellement enregistrées :
 *  - montant encaissé = somme des paiements de la période ;
 *  - produits vendus = articles des commandes PAYÉES (clôturées) dans la période.
 * Une commande non payée n'est jamais comptée comme une vente encaissée.
 */
function computeStats(db, from, to) {
  const inRange = (col) => `substr(${col}, 1, 10) BETWEEN ? AND ?`;
  const range = [from, to];

  const collected = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count FROM payments WHERE ${inRange('created_at')}`
  ).get(...range);

  const byType = db.prepare(`
    SELECT method_type AS type, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count
    FROM payments WHERE ${inRange('created_at')} GROUP BY method_type`).all(...range);
  const byTypeMap = { cash: 0, mobile_money: 0, other: 0 };
  for (const r of byType) byTypeMap[r.type] = r.amount;

  const byMethod = db.prepare(`
    SELECT method_name AS name, method_type AS type, SUM(amount) AS amount, COUNT(*) AS count
    FROM payments WHERE ${inRange('created_at')} GROUP BY method_name, method_type ORDER BY amount DESC`).all(...range);

  const created = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
    FROM orders WHERE ${inRange('created_at')}`).get(...range);

  const paid = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS amount
    FROM orders WHERE status = 'paid' AND ${inRange('closed_at')}`).get(...range);

  const products = db.prepare(`
    SELECT oi.product_id, oi.product_name, oi.family_name,
      SUM(oi.quantity) AS quantity, SUM(oi.quantity * oi.unit_price) AS amount
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'paid' AND ${inRange('o.closed_at')}
    GROUP BY oi.product_id
    ORDER BY quantity DESC, amount DESC, oi.product_name`).all(...range);

  const families = db.prepare(`
    SELECT oi.family_name, SUM(oi.quantity) AS quantity, SUM(oi.quantity * oi.unit_price) AS amount
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status = 'paid' AND ${inRange('o.closed_at')}
    GROUP BY oi.family_name ORDER BY amount DESC`).all(...range);

  const daily = db.prepare(`
    SELECT substr(created_at, 1, 10) AS date, SUM(amount) AS collected, COUNT(DISTINCT order_id) AS orders
    FROM payments WHERE ${inRange('created_at')} GROUP BY date ORDER BY date`).all(...range);

  const open = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(total - paid_amount), 0) AS remaining, COALESCE(SUM(total), 0) AS total
    FROM orders WHERE status = 'open'`).get();

  return {
    from,
    to,
    collected: collected.amount,
    payments_count: collected.count,
    by_type: byTypeMap,
    by_method: byMethod,
    orders_created: created.total,
    orders_cancelled: created.cancelled ?? 0,
    orders_paid: paid.count,
    sales_amount: paid.amount,
    products,
    top_products: products.slice(0, 10),
    families,
    daily,
    open_orders: open,
  };
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

module.exports = function statsRoutes(app, db, { requireAdmin }) {
  // Résumé du jour pour le tableau de bord (accessible à tout le personnel).
  app.get('/api/dashboard', (req, res) => {
    const today = todayLocal();
    const s = computeStats(db, today, today);
    res.json({
      date: today,
      collected: s.collected,
      by_type: s.by_type,
      orders_created: s.orders_created,
      orders_paid: s.orders_paid,
      sales_amount: s.sales_amount,
      open_orders: s.open_orders,
      top_products: s.top_products.slice(0, 5),
    });
  });

  // Statistiques détaillées (responsable).
  app.get('/api/stats', requireAdmin, (req, res) => {
    const today = todayLocal();
    const from = req.query.from ?? req.query.date ?? today;
    const to = req.query.to ?? req.query.date ?? from;
    if (!isIsoDate(from) || !isIsoDate(to)) throw badRequest('Date invalide (format AAAA-MM-JJ).');
    if (from > to) throw badRequest('La date de début doit précéder la date de fin.');
    if (daysBetween(from, to) > MAX_RANGE_DAYS) throw badRequest('Période trop longue (maximum un an).');
    res.json(computeStats(db, from, to));
  });
};

module.exports.computeStats = computeStats;
