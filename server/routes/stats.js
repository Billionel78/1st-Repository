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
async function computeStats(db, from, to) {
  const inRange = (col) => `substr(${col}, 1, 10) BETWEEN ? AND ?`;
  const range = [from, to];

  // Requêtes indépendantes lancées ensemble (une base distante répond plus vite ainsi).
  const [collected, byType, byMethod, created, paid, products, families, daily, byUser, open] = await Promise.all([
    db.get(`SELECT COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count FROM payments WHERE ${inRange('created_at')}`,
      ...range),
    db.all(`
      SELECT method_type AS type, COALESCE(SUM(amount), 0) AS amount, COUNT(*) AS count
      FROM payments WHERE ${inRange('created_at')} GROUP BY method_type`, ...range),
    db.all(`
      SELECT method_name AS name, method_type AS type, SUM(amount) AS amount, COUNT(*) AS count
      FROM payments WHERE ${inRange('created_at')} GROUP BY method_name, method_type ORDER BY amount DESC`, ...range),
    db.get(`
      SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled
      FROM orders WHERE ${inRange('created_at')}`, ...range),
    db.get(`
      SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS amount
      FROM orders WHERE status = 'paid' AND ${inRange('closed_at')}`, ...range),
    db.all(`
      SELECT oi.product_id, MAX(oi.product_name) AS product_name, MAX(oi.family_name) AS family_name,
        SUM(oi.quantity) AS quantity, SUM(oi.quantity * oi.unit_price) AS amount,
        SUM(oi.quantity * oi.unit_cost) AS cost, SUM(oi.quantity * (oi.unit_price - oi.unit_cost)) AS margin,
        SUM(CASE WHEN oi.unit_cost = 0 THEN oi.quantity ELSE 0 END) AS qty_without_cost
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status = 'paid' AND ${inRange('o.closed_at')}
      GROUP BY oi.product_id
      ORDER BY quantity DESC, amount DESC, product_name`, ...range),
    db.all(`
      SELECT oi.family_name, SUM(oi.quantity) AS quantity, SUM(oi.quantity * oi.unit_price) AS amount
      FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.status = 'paid' AND ${inRange('o.closed_at')}
      GROUP BY oi.family_name ORDER BY amount DESC`, ...range),
    db.all(`
      SELECT substr(created_at, 1, 10) AS date, SUM(amount) AS collected, COUNT(DISTINCT order_id) AS orders
      FROM payments WHERE ${inRange('created_at')} GROUP BY substr(created_at, 1, 10) ORDER BY 1`, ...range),
    db.all(`
      SELECT COALESCE(MAX(u.full_name), '—') AS name, SUM(p.amount) AS amount, COUNT(*) AS count,
        SUM(CASE WHEN p.method_type = 'cash' THEN p.amount ELSE 0 END) AS cash
      FROM payments p LEFT JOIN users u ON u.id = p.created_by
      WHERE ${inRange('p.created_at')} GROUP BY p.created_by ORDER BY amount DESC`, ...range),
    db.get(`
      SELECT COUNT(*) AS count, COALESCE(SUM(total - paid_amount), 0) AS remaining, COALESCE(SUM(total), 0) AS total
      FROM orders WHERE status = 'open'`),
  ]);
  const byTypeMap = { cash: 0, mobile_money: 0, other: 0 };
  for (const r of byType) byTypeMap[r.type] = r.amount;

  const cost = products.reduce((sum, p) => sum + p.cost, 0);
  const qtyWithoutCost = products.reduce((sum, p) => sum + p.qty_without_cost, 0);

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
    cost_of_sales: cost,
    gross_margin: paid.amount - cost,
    margin_rate: paid.amount > 0 ? Math.round(((paid.amount - cost) / paid.amount) * 1000) / 10 : null,
    items_without_cost: qtyWithoutCost,
    by_user: byUser,
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

/** Lit ?date= ou ?from=&to= (par défaut : aujourd'hui) et valide la période. */
function parseRange(query) {
  const today = todayLocal();
  const from = query.from ?? query.date ?? today;
  const to = query.to ?? query.date ?? from;
  if (!isIsoDate(from) || !isIsoDate(to)) throw badRequest('Date invalide (format AAAA-MM-JJ).');
  if (from > to) throw badRequest('La date de début doit précéder la date de fin.');
  if (daysBetween(from, to) > MAX_RANGE_DAYS) throw badRequest('Période trop longue (maximum un an).');
  return { from, to };
}

module.exports = function statsRoutes(app, db, { requireAdmin }) {
  // Résumé du jour pour le tableau de bord (accessible à tout le personnel).
  app.get('/api/dashboard', async (req, res) => {
    const today = todayLocal();
    const s = await computeStats(db, today, today);
    res.json({
      date: today,
      collected: s.collected,
      by_type: s.by_type,
      orders_created: s.orders_created,
      orders_paid: s.orders_paid,
      sales_amount: s.sales_amount,
      open_orders: s.open_orders,
      top_products: s.top_products.slice(0, 5),
      low_stock: await db.all(`
        SELECT p.id, p.name, p.stock - COALESCE((SELECT SUM(oi.quantity) FROM order_items oi
          JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.status = 'open'), 0) AS free,
          p.alert_threshold
        FROM products p JOIN families f ON f.id = p.family_id
        WHERE p.archived = 0 AND f.archived = 0 AND p.track_stock = 1
          AND p.stock - COALESCE((SELECT SUM(oi.quantity) FROM order_items oi
          JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = p.id AND o.status = 'open'), 0) <= p.alert_threshold
        ORDER BY free, p.name`),
    });
  });

  // Statistiques détaillées (responsable).
  app.get('/api/stats', requireAdmin, async (req, res) => {
    const { from, to } = parseRange(req.query);
    res.json(await computeStats(db, from, to));
  });
};

module.exports.computeStats = computeStats;
module.exports.parseRange = parseRange;
