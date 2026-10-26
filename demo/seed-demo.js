'use strict';

// Données d'exemple de la démo : un serveur, des prix d'achat, du stock et une semaine de ventes.
// Les ventes sont générées de façon déterministe pour que la démo soit identique à chaque réinitialisation.

const { transaction } = require('../server/db');
const { hashPassword } = require('../server/security');
const { applyStockMovement } = require('../server/stock');
const { nowLocal } = require('../server/time');

function rng(seed) {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

function seedDemo(db) {
  const random = rng(20261026);
  const pick = (list) => list[Math.floor(random() * list.length)];
  const now = new Date();
  const at = (date) => nowLocal(date);

  transaction(db, () => {
    db.prepare('INSERT INTO users (username, full_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('awa', 'Awa (serveuse)', hashPassword('serveur1'), 'serveur', at(now));

    // Prix d'achat ≈ 60 % du prix de vente ; suivi du stock sur les bières et les sucreries.
    const products = db.prepare(`SELECT p.*, f.name AS family_name FROM products p JOIN families f ON f.id = p.family_id`).all();
    const start = new Date(now);
    start.setDate(start.getDate() - 7);
    start.setHours(10, 0, 0, 0);
    for (const p of products) {
      const cost = Math.round((p.price * 0.6) / 50) * 50;
      const tracked = ['Bières', 'Sucreries'].includes(p.family_name);
      db.prepare('UPDATE products SET cost_price = ?, track_stock = ?, alert_threshold = ? WHERE id = ?')
        .run(cost, tracked ? 1 : 0, tracked ? 12 : 0, p.id);
      p.cost_price = cost;
      p.track_stock = tracked;
      if (tracked) {
        const qty = p.name === 'Guinness' ? 60 : 150;
        applyStockMovement(db, { productId: p.id, type: 'entree', delta: qty, unitCost: cost, note: 'Livraison fournisseur', userId: 1, at: at(start) });
      }
    }

    const tables = db.prepare('SELECT * FROM bar_tables ORDER BY position').all();
    const methods = db.prepare('SELECT * FROM payment_methods').all();
    const cash = methods.find((m) => m.type === 'cash');
    const mobile = methods.filter((m) => m.type === 'mobile_money');
    // Les bières se vendent le plus.
    const weighted = products.flatMap((p) => Array(p.family_name === 'Bières' ? 6 : p.family_name === 'Sucreries' ? 3 : 1).fill(p));

    const insOrder = db.prepare(`INSERT INTO orders (number, table_id, table_name, status, total, paid_amount, created_by,
      created_at, updated_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insItem = db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, family_name, unit_price, unit_cost,
      quantity, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insPay = db.prepare(`INSERT INTO payments (order_id, method_id, method_name, method_type, amount, received_amount,
      change_amount, reference, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    function createOrder(opened, table, seq, { paid, closed }) {
      const day = at(opened).slice(0, 10).replaceAll('-', '');
      const lines = new Map();
      const count = 1 + Math.floor(random() * 3);
      for (let i = 0; i < count; i++) {
        const p = pick(weighted);
        lines.set(p, (lines.get(p) ?? 0) + 1 + Math.floor(random() * 4));
      }
      const total = [...lines].reduce((s, [p, q]) => s + p.price * q, 0);
      const userId = random() < 0.6 ? 2 : 1;
      const orderId = Number(insOrder.run(`CMD-${day}-${String(seq).padStart(4, '0')}`, table.id, table.name,
        paid ? 'paid' : 'open', total, paid ? total : 0, userId, at(opened), at(closed ?? opened), paid ? at(closed) : null).lastInsertRowid);
      for (const [p, q] of lines) insItem.run(orderId, p.id, p.name, p.family_name, p.price, p.cost_price, q, at(opened), at(opened));
      if (!paid) return;
      const method = random() < 0.6 ? cash : pick(mobile);
      const received = method.type === 'cash' ? Math.ceil(total / 1000) * 1000 + (random() < 0.3 ? 1000 : 0) : null;
      insPay.run(orderId, method.id, method.name, method.type, total, received, received === null ? null : received - total,
        method.type === 'cash' ? null : `TX${Math.floor(random() * 1e8)}`, userId, at(closed));
      for (const [p, q] of lines) {
        if (p.track_stock) applyStockMovement(db, { productId: p.id, type: 'vente', delta: -q, orderId, userId, at: at(closed) });
      }
    }

    // Six jours passés : de 18 h à minuit.
    for (let back = 6; back >= 1; back--) {
      const day = new Date(now);
      day.setDate(day.getDate() - back);
      const orders = 7 + Math.floor(random() * 7) + (day.getDay() === 5 || day.getDay() === 6 ? 6 : 0);
      for (let n = 1; n <= orders; n++) {
        const opened = new Date(day);
        opened.setHours(18, Math.floor(random() * 300), 0, 0);
        const closed = new Date(opened.getTime() + (20 + random() * 70) * 60000);
        if (closed.getDate() !== opened.getDate()) closed.setTime(opened.getTime() + 5 * 60000);
        createOrder(opened, pick(tables), n, { paid: true, closed });
      }
    }

    // Aujourd'hui : quelques ventes déjà payées (s'il est assez tard) et trois tables encore ouvertes.
    const minutesToday = now.getHours() * 60 + now.getMinutes();
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const step = Math.max(1, Math.min(25, Math.floor(minutesToday / 11)));
    for (let n = 7; n >= 1; n--) {
      const open = n <= 3;
      if (!open && minutesToday < 120) continue;
      const opened = new Date(Math.max(now.getTime() - n * step * 60000, midnight.getTime()));
      createOrder(opened, tables[open ? n - 1 : 3 + (n % 4)], 8 - n,
        open ? { paid: false } : { paid: true, closed: new Date(opened.getTime() + Math.min(15, step) * 60000) });
    }
  });
}

module.exports = { seedDemo };
