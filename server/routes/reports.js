'use strict';

const { computeStats, parseRange } = require('./stats');

const STATUS_LABELS = { open: 'En attente de paiement', paid: 'Payée', cancelled: 'Annulée' };
const TYPE_LABELS = { cash: 'Espèces', mobile_money: 'Mobile Money', other: 'Autre' };
const MOVEMENT_LABELS = { entree: 'Entrée', perte: 'Perte', inventaire: 'Inventaire', vente: 'Vente', ajustement: 'Ajustement' };

/**
 * CSV lisible directement par Excel en français : séparateur « ; », BOM UTF-8, fins de ligne CRLF.
 * Les textes commençant par = + - @ sont préfixés d'une apostrophe (injection de formules).
 */
function toCsv(header, rows) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return String(v);
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `\uFEFF${[header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n')}\r\n`;
}

function sendCsv(res, filename, header, rows) {
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.send(toCsv(header, rows));
}

const suffix = ({ from, to }) => (from === to ? from : `${from}_${to}`);

module.exports = function reportRoutes(app, db, { requireAdmin }) {
  app.get('/api/reports/sales.csv', requireAdmin, async (req, res) => {
    const range = parseRange(req.query);
    const s = await computeStats(db, range.from, range.to);
    sendCsv(res, `ventes-produits_${suffix(range)}.csv`,
      ['Produit', 'Famille', 'Quantité vendue', "Chiffre d'affaires", "Coût d'achat", 'Marge brute'],
      [
        ...s.products.map((p) => [p.product_name, p.family_name, p.quantity, p.amount, p.cost, p.margin]),
        ['TOTAL', '', s.products.reduce((a, p) => a + p.quantity, 0), s.sales_amount, s.cost_of_sales, s.gross_margin],
      ]);
  });

  app.get('/api/reports/orders.csv', requireAdmin, async (req, res) => {
    const range = parseRange(req.query);
    const orders = await db.all(`
      SELECT o.*, u.full_name AS created_by_name FROM orders o LEFT JOIN users u ON u.id = o.created_by
      WHERE substr(o.created_at, 1, 10) BETWEEN ? AND ? ORDER BY o.created_at, o.id`, range.from, range.to);
    // Articles et modes de paiement de toute la période, en deux requêtes.
    const items = new Map();
    const methods = new Map();
    const push = (map, key, value) => map.set(key, [...(map.get(key) ?? []), value]);
    const inPeriod = `SELECT id FROM orders WHERE substr(created_at, 1, 10) BETWEEN ? AND ?`;
    for (const i of await db.all(`SELECT order_id, product_name, quantity FROM order_items
      WHERE order_id IN (${inPeriod}) ORDER BY id`, range.from, range.to)) push(items, i.order_id, `${i.quantity} x ${i.product_name}`);
    for (const m of await db.all(`SELECT order_id, method_name FROM payments
      WHERE order_id IN (${inPeriod}) GROUP BY order_id, method_name ORDER BY MIN(id)`, range.from, range.to)) {
      push(methods, m.order_id, m.method_name);
    }
    sendCsv(res, `commandes_${suffix(range)}.csv`,
      ['Date', 'Heure', 'N° commande', 'Table', 'Statut', 'Articles', 'Total', 'Payé', 'Reste', 'Mode(s) de paiement', 'Clôturée le', 'Saisie par'],
      orders.map((o) => [
        o.created_at.slice(0, 10), o.created_at.slice(11, 16), o.number, o.table_name, STATUS_LABELS[o.status],
        (items.get(o.id) ?? []).join(', '),
        o.total, o.paid_amount, o.total - o.paid_amount,
        (methods.get(o.id) ?? []).join(', '), o.closed_at ?? '', o.created_by_name ?? '',
      ]));
  });

  app.get('/api/reports/payments.csv', requireAdmin, async (req, res) => {
    const range = parseRange(req.query);
    const rows = await db.all(`
      SELECT p.*, o.number, o.table_name, u.full_name AS created_by_name
      FROM payments p JOIN orders o ON o.id = p.order_id LEFT JOIN users u ON u.id = p.created_by
      WHERE substr(p.created_at, 1, 10) BETWEEN ? AND ? ORDER BY p.created_at, p.id`, range.from, range.to);
    sendCsv(res, `encaissements_${suffix(range)}.csv`,
      ['Date', 'Heure', 'N° commande', 'Table', 'Mode de paiement', 'Catégorie', 'Montant', 'Montant reçu', 'Monnaie rendue', 'Référence', 'Encaissé par'],
      rows.map((p) => [
        p.created_at.slice(0, 10), p.created_at.slice(11, 16), p.number, p.table_name, p.method_name,
        TYPE_LABELS[p.method_type], p.amount, p.received_amount, p.change_amount, p.reference, p.created_by_name ?? '',
      ]));
  });

  app.get('/api/reports/stock.csv', requireAdmin, async (req, res) => {
    const rows = await db.all(`
      SELECT p.name, f.name AS family_name, p.stock, p.alert_threshold, p.cost_price, p.price
      FROM products p JOIN families f ON f.id = p.family_id
      WHERE p.archived = 0 AND f.archived = 0 AND p.track_stock = 1 ORDER BY f.position, f.name, p.name`);
    sendCsv(res, 'etat-du-stock.csv',
      ['Produit', 'Famille', 'Stock', "Seuil d'alerte", "Prix d'achat", 'Prix de vente', 'Valeur du stock (achat)'],
      rows.map((p) => [p.name, p.family_name, p.stock, p.alert_threshold, p.cost_price, p.price, Math.max(p.stock, 0) * p.cost_price]));
  });

  app.get('/api/reports/stock-movements.csv', requireAdmin, async (req, res) => {
    const range = parseRange(req.query);
    const rows = await db.all(`
      SELECT m.*, p.name AS product_name, o.number, u.full_name AS created_by_name
      FROM stock_movements m JOIN products p ON p.id = m.product_id
      LEFT JOIN orders o ON o.id = m.order_id LEFT JOIN users u ON u.id = m.created_by
      WHERE substr(m.created_at, 1, 10) BETWEEN ? AND ? ORDER BY m.id`, range.from, range.to);
    sendCsv(res, `mouvements-stock_${suffix(range)}.csv`,
      ['Date', 'Heure', 'Produit', 'Type', 'Quantité', 'Stock après', "Prix d'achat unitaire", 'Commande', 'Note', 'Par'],
      rows.map((m) => [
        m.created_at.slice(0, 10), m.created_at.slice(11, 16), m.product_name, MOVEMENT_LABELS[m.type], m.quantity,
        m.stock_after, m.unit_cost, m.number ?? '', m.note ?? '', m.created_by_name ?? '',
      ]));
  });
};

module.exports.toCsv = toCsv;
