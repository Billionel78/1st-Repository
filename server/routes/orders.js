'use strict';

const { badRequest, notFound, conflict, toInt, toText } = require('../http');
const { transaction } = require('../db');
const { nowLocal, isIsoDate } = require('../time');
const { applyStockMovement } = require('../stock');

const MAX_QTY = 1000;
const STATUSES = ['open', 'paid', 'cancelled'];

module.exports = function orderRoutes(app, db, { requireAdmin }) {
  // ---------- Lecture ----------
  function loadOrder(id) {
    const order = db.prepare(`
      SELECT o.*, u.full_name AS created_by_name
      FROM orders o LEFT JOIN users u ON u.id = o.created_by WHERE o.id = ?`).get(id);
    if (!order) return null;
    order.remaining = order.total - order.paid_amount;
    order.items = db.prepare(`
      SELECT id, product_id, product_name, family_name, unit_price, quantity, unit_price * quantity AS amount,
        created_at, updated_at
      FROM order_items WHERE order_id = ? ORDER BY id`).all(id);
    order.payments = db.prepare(`
      SELECT p.id, p.method_id, p.method_name, p.method_type, p.amount, p.received_amount, p.change_amount,
        p.reference, p.created_at, u.full_name AS created_by_name
      FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.order_id = ? ORDER BY p.id`).all(id);
    return order;
  }

  function requireOrder(id) {
    const order = loadOrder(id);
    if (!order) throw notFound('Commande introuvable.');
    return order;
  }

  function requireOpen(order) {
    if (order.status !== 'open') throw conflict('Cette commande est déjà clôturée.');
  }

  app.get('/api/orders', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status !== undefined) {
      if (!STATUSES.includes(req.query.status)) throw badRequest('Statut invalide.');
      where.push('o.status = ?');
      params.push(req.query.status);
    }
    if (req.query.date !== undefined) {
      if (!isIsoDate(req.query.date)) throw badRequest('Date invalide (format AAAA-MM-JJ).');
      where.push('substr(o.created_at, 1, 10) = ?');
      params.push(req.query.date);
    }
    if (req.query.table_id !== undefined) {
      where.push('o.table_id = ?');
      params.push(toInt(req.query.table_id, 'table'));
    }
    const limit = toInt(req.query.limit, 'limite', { min: 1, max: 1000, optional: true }) ?? 500;
    const orders = db.prepare(`
      SELECT o.id, o.number, o.table_id, o.table_name, o.status, o.total, o.paid_amount,
        o.total - o.paid_amount AS remaining, o.created_at, o.updated_at, o.closed_at, o.cancel_reason,
        u.full_name AS created_by_name
      FROM orders o LEFT JOIN users u ON u.id = o.created_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY o.created_at DESC, o.id DESC LIMIT ${limit}`).all(...params);

    // Détail compact pour l'historique (articles + modes de paiement).
    const itemsStmt = db.prepare(
      'SELECT product_name, unit_price, quantity, unit_price * quantity AS amount FROM order_items WHERE order_id = ? ORDER BY id'
    );
    const methodsStmt = db.prepare(
      'SELECT method_name, method_type, SUM(amount) AS amount FROM payments WHERE order_id = ? GROUP BY method_name, method_type'
    );
    for (const o of orders) {
      o.items = itemsStmt.all(o.id);
      o.payment_methods = methodsStmt.all(o.id);
    }
    res.json(orders);
  });

  app.get('/api/orders/:id', (req, res) => {
    res.json(requireOrder(toInt(req.params.id, 'id')));
  });

  // ---------- Saisie ----------
  function parseItems(body) {
    const raw = Array.isArray(body?.items)
      ? body.items
      : [{ product_id: body?.product_id, quantity: body?.quantity }];
    if (raw.length === 0) throw badRequest('Aucun article à ajouter.');
    if (raw.length > 100) throw badRequest('Trop d’articles dans une seule saisie.');
    // Regroupe les doublons d'un même produit.
    const merged = new Map();
    for (const it of raw) {
      const productId = toInt(it?.product_id, 'produit', { min: 1 });
      const qty = toInt(it?.quantity, 'quantité', { min: 1, max: MAX_QTY });
      merged.set(productId, (merged.get(productId) ?? 0) + qty);
    }
    return [...merged].map(([product_id, quantity]) => ({ product_id, quantity }));
  }

  function nextOrderNumber(now) {
    const day = now.slice(0, 10).replaceAll('-', '');
    const prefix = `CMD-${day}-`;
    const last = db.prepare('SELECT number FROM orders WHERE number LIKE ? ORDER BY number DESC LIMIT 1').get(`${prefix}%`);
    const seq = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, '0')}`;
  }

  function recomputeTotal(orderId, now) {
    db.prepare(`UPDATE orders SET
        total = COALESCE((SELECT SUM(unit_price * quantity) FROM order_items WHERE order_id = ?), 0),
        updated_at = ?
      WHERE id = ?`).run(orderId, now, orderId);
  }

  /** Ajoute les articles à une commande ouverte : fusionne avec une ligne existante au même prix. */
  function addItems(orderId, items, now) {
    const getProduct = db.prepare(`
      SELECT p.*, f.name AS family_name,
        COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                  WHERE oi.product_id = p.id AND o.status = 'open'), 0) AS reserved
      FROM products p JOIN families f ON f.id = p.family_id
      WHERE p.id = ? AND p.archived = 0`);
    const findLine = db.prepare('SELECT id FROM order_items WHERE order_id = ? AND product_id = ? AND unit_price = ?');
    const bumpLine = db.prepare('UPDATE order_items SET quantity = quantity + ?, updated_at = ? WHERE id = ?');
    const insertLine = db.prepare(`INSERT INTO order_items
      (order_id, product_id, product_name, family_name, unit_price, unit_cost, quantity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    for (const { product_id, quantity } of items) {
      const p = getProduct.get(product_id);
      if (!p) throw badRequest('Produit introuvable.');
      if (!p.available) throw conflict(`« ${p.name} » n’est pas disponible actuellement.`);
      if (p.track_stock) {
        const free = p.stock - p.reserved;
        if (quantity > free) {
          throw conflict(`Stock insuffisant pour « ${p.name} » : ${Math.max(free, 0)} disponible(s).`);
        }
      }
      const line = findLine.get(orderId, product_id, p.price);
      if (line) bumpLine.run(quantity, now, line.id);
      else insertLine.run(orderId, product_id, p.name, p.family_name, p.price, p.cost_price, quantity, now, now);
    }
    recomputeTotal(orderId, now);
  }

  // Ajoute des articles sur une table : complète la commande ouverte de la table ou en crée une nouvelle.
  app.post('/api/orders', (req, res) => {
    const tableId = toInt(req.body?.table_id, 'table', { min: 1 });
    const items = parseItems(req.body);
    const { orderId, created } = transaction(db, () => {
      const table = db.prepare('SELECT * FROM bar_tables WHERE id = ? AND archived = 0').get(tableId);
      if (!table) throw badRequest('Table introuvable.');
      const now = nowLocal();
      const open = db.prepare("SELECT id FROM orders WHERE table_id = ? AND status = 'open'").get(tableId);
      let id = open?.id;
      if (!id) {
        id = Number(db.prepare(`INSERT INTO orders (number, table_id, table_name, status, created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'open', ?, ?, ?)`).run(nextOrderNumber(now), tableId, table.name, req.user.id, now, now)
          .lastInsertRowid);
      }
      addItems(id, items, now);
      return { orderId: id, created: !open };
    });
    res.status(created ? 201 : 200).json({ created, order: loadOrder(orderId) });
  });

  app.post('/api/orders/:id/items', (req, res) => {
    const id = toInt(req.params.id, 'id');
    const items = parseItems(req.body);
    transaction(db, () => {
      requireOpen(requireOrder(id));
      addItems(id, items, nowLocal());
    });
    res.json(loadOrder(id));
  });

  // Correction d'une ligne (quantité 0 = suppression) tant que la commande est ouverte.
  app.patch('/api/orders/:id/items/:itemId', (req, res) => {
    const id = toInt(req.params.id, 'id');
    const itemId = toInt(req.params.itemId, 'article');
    const quantity = toInt(req.body?.quantity, 'quantité', { min: 0, max: MAX_QTY });
    transaction(db, () => {
      const order = requireOrder(id);
      requireOpen(order);
      const item = order.items.find((i) => i.id === itemId);
      if (!item) throw notFound('Article introuvable dans cette commande.');
      if (quantity > item.quantity) {
        const p = db.prepare('SELECT * FROM products WHERE id = ?').get(item.product_id);
        if (p?.track_stock) {
          const reserved = db.prepare(`SELECT COALESCE(SUM(oi.quantity), 0) AS n FROM order_items oi
            JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = ? AND o.status = 'open'`).get(p.id).n;
          const free = p.stock - reserved;
          if (quantity - item.quantity > free) {
            throw conflict(`Stock insuffisant pour « ${p.name} » : ${Math.max(free, 0)} disponible(s).`);
          }
        }
      }
      const newTotal = order.total - item.amount + item.unit_price * quantity;
      if (newTotal < order.paid_amount) {
        throw conflict('Impossible : le total deviendrait inférieur au montant déjà payé.');
      }
      const now = nowLocal();
      if (quantity === 0) db.prepare('DELETE FROM order_items WHERE id = ?').run(itemId);
      else db.prepare('UPDATE order_items SET quantity = ?, updated_at = ? WHERE id = ?').run(quantity, now, itemId);
      recomputeTotal(id, now);
    });
    res.json(loadOrder(id));
  });

  // Transfert d'une commande ouverte vers une autre table libre.
  app.post('/api/orders/:id/transfer', (req, res) => {
    const id = toInt(req.params.id, 'id');
    const tableId = toInt(req.body?.table_id, 'table', { min: 1 });
    transaction(db, () => {
      const order = requireOrder(id);
      requireOpen(order);
      const table = db.prepare('SELECT * FROM bar_tables WHERE id = ? AND archived = 0').get(tableId);
      if (!table) throw badRequest('Table introuvable.');
      if (table.id === order.table_id) return;
      const busy = db.prepare("SELECT id FROM orders WHERE table_id = ? AND status = 'open'").get(tableId);
      if (busy) throw conflict(`${table.name} a déjà une commande ouverte.`);
      db.prepare('UPDATE orders SET table_id = ?, table_name = ?, updated_at = ? WHERE id = ?')
        .run(table.id, table.name, nowLocal(), id);
    });
    res.json(loadOrder(id));
  });

  app.post('/api/orders/:id/cancel', requireAdmin, (req, res) => {
    const id = toInt(req.params.id, 'id');
    const reason = toText(req.body?.reason, 'motif', { max: 200, optional: true }) ?? null;
    transaction(db, () => {
      const order = requireOrder(id);
      requireOpen(order);
      if (order.paid_amount > 0) throw conflict('Impossible d’annuler une commande partiellement payée.');
      const now = nowLocal();
      db.prepare("UPDATE orders SET status = 'cancelled', cancel_reason = ?, closed_at = ?, updated_at = ? WHERE id = ?")
        .run(reason, now, now, id);
    });
    res.json(loadOrder(id));
  });

  // ---------- Paiement ----------
  app.post('/api/orders/:id/payments', (req, res) => {
    const id = toInt(req.params.id, 'id');
    const methodId = toInt(req.body?.method_id, 'mode de paiement', { min: 1 });
    const reference = toText(req.body?.reference, 'référence', { max: 60, optional: true }) ?? null;

    const result = transaction(db, () => {
      const order = requireOrder(id);
      requireOpen(order);
      if (order.total <= 0) throw conflict('La commande est vide.');
      const method = db.prepare('SELECT * FROM payment_methods WHERE id = ? AND archived = 0').get(methodId);
      if (!method) throw badRequest('Mode de paiement introuvable.');

      const amount = toInt(req.body?.amount, 'montant', { min: 1, optional: true }) ?? order.remaining;
      if (amount > order.remaining) {
        throw badRequest(`Le montant dépasse le reste à payer (${order.remaining}).`);
      }
      let received = null;
      let change = null;
      if (method.type === 'cash') {
        received = toInt(req.body?.received_amount, 'montant reçu', { min: 0, optional: true }) ?? amount;
        if (received < amount) throw badRequest('Le montant reçu est inférieur au montant à encaisser.');
        change = received - amount;
      }

      const now = nowLocal();
      db.prepare(`INSERT INTO payments
        (order_id, method_id, method_name, method_type, amount, received_amount, change_amount, reference, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, method.id, method.name, method.type, amount, received, change, reference, req.user.id, now
      );
      const paid = order.paid_amount + amount;
      const fullyPaid = paid === order.total;
      if (fullyPaid) {
        db.prepare("UPDATE orders SET paid_amount = ?, status = 'paid', closed_at = ?, updated_at = ? WHERE id = ?")
          .run(paid, now, now, id);
        // Mise à jour du stock des produits suivis (mouvement « vente »).
        const tracked = db.prepare('SELECT track_stock FROM products WHERE id = ?');
        for (const item of order.items) {
          if (!tracked.get(item.product_id)?.track_stock) continue;
          applyStockMovement(db, {
            productId: item.product_id, type: 'vente', delta: -item.quantity, orderId: id, userId: req.user.id, at: now,
          });
        }
      } else {
        db.prepare('UPDATE orders SET paid_amount = ?, updated_at = ? WHERE id = ?').run(paid, now, id);
      }
      return { fullyPaid, change };
    });
    res.status(201).json({ fully_paid: result.fullyPaid, change: result.change, order: loadOrder(id) });
  });
};
