'use strict';

const { badRequest, notFound, conflict, toInt, toText } = require('../http');
const { isIsoDate, nowLocal } = require('../time');
const { applyStockMovement } = require('../stock');

const MAX_QTY = 1000;
const STATUSES = ['open', 'paid', 'cancelled'];

module.exports = function orderRoutes(app, db, { requireAdmin, requireCustomer }) {
  // ---------- Lecture ----------
  // `q` : la base, ou la transaction en cours.
  async function loadOrder(id, q = db) {
    const order = await q.get(`
      SELECT o.*, u.full_name AS created_by_name
      FROM orders o LEFT JOIN users u ON u.id = o.created_by WHERE o.id = ?`, id);
    if (!order) return null;
    order.remaining = order.total - order.paid_amount;
    order.items = await q.all(`
      SELECT id, product_id, product_name, family_name, unit_price, quantity, unit_price * quantity AS amount,
        created_at, updated_at
      FROM order_items WHERE order_id = ? ORDER BY id`, id);
    order.payments = await q.all(`
      SELECT p.id, p.method_id, p.method_name, p.method_type, p.amount, p.received_amount, p.change_amount,
        p.reference, p.created_at, u.full_name AS created_by_name
      FROM payments p LEFT JOIN users u ON u.id = p.created_by WHERE p.order_id = ? ORDER BY p.id`, id);
    return order;
  }

  async function requireOrder(id, q = db) {
    const order = await loadOrder(id, q);
    if (!order) throw notFound('Commande introuvable.');
    return order;
  }

  function requireOpen(order) {
    if (order.status !== 'open') throw conflict('Cette commande est déjà clôturée.');
  }

  /**
   * Commande modifiable : ouverte (tout le personnel) ou payée (responsable uniquement, correction).
   * Une commande annulée ne se modifie plus.
   */
  function requireEditable(req, order) {
    if (order.status === 'open') return;
    if (order.status === 'paid' && req.user.role === 'admin') return;
    if (order.status === 'paid') throw conflict('Seul le responsable peut modifier une commande déjà payée.');
    throw conflict('Cette commande est annulée.');
  }

  /** Commande payée corrigée : le stock suit la variation de quantité (trace dans l'historique du stock). */
  async function correctPaidStock(tx, order, productId, qtyDelta, now, userId) {
    if (!qtyDelta) return;
    const product = await tx.get('SELECT track_stock FROM products WHERE id = ?', productId);
    if (!product?.track_stock) return;
    await applyStockMovement(tx, {
      productId, type: 'vente', delta: -qtyDelta, orderId: order.id, userId, at: now,
      note: `Correction ${order.number}`,
    });
  }

  /**
   * Commande payée corrigée : les paiements suivent le nouveau total pour qu'elle reste soldée.
   * Hausse : ajoutée au dernier paiement. Baisse : retirée des derniers paiements (supprimés à zéro).
   */
  async function settlePaidOrder(tx, orderId, now) {
    const { total } = await tx.get('SELECT total FROM orders WHERE id = ?', orderId);
    const payments = await tx.all('SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC', orderId);
    let diff = total - payments.reduce((sum, p) => sum + p.amount, 0);
    for (const p of payments) {
      if (diff === 0) break;
      const amount = Math.max(0, p.amount + diff);
      diff -= amount - p.amount;
      if (amount === 0) {
        await tx.run('DELETE FROM payments WHERE id = ?', p.id);
      } else {
        // Espèces : le montant reçu couvre au moins le montant, la monnaie rendue suit.
        const received = p.method_type === 'cash' ? Math.max(p.received_amount ?? amount, amount) : p.received_amount;
        await tx.run('UPDATE payments SET amount = ?, received_amount = ?, change_amount = ? WHERE id = ?',
          amount, received, p.method_type === 'cash' ? received - amount : p.change_amount, p.id);
      }
    }
    await tx.run('UPDATE orders SET paid_amount = total, updated_at = ? WHERE id = ?', now, orderId);
  }

  /** Rattrapage : on n'encaisse ni ne complète une commande d'une autre journée que celle rattrapée. */
  function requireSameDay(req, order) {
    if (req.backdate && order.created_at.slice(0, 10) !== req.backdate) {
      throw conflict(`Cette commande date du ${order.created_at.slice(8, 10)}/${order.created_at.slice(5, 7)} : quittez le mode rattrapage (ou choisissez sa date) pour la traiter.`);
    }
  }

  app.get('/api/orders', async (req, res) => {
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
    const orders = await db.all(`
      SELECT o.id, o.number, o.table_id, o.table_name, o.status, o.total, o.paid_amount,
        o.total - o.paid_amount AS remaining, o.created_at, o.updated_at, o.closed_at, o.cancel_reason,
        o.customer_id, o.customer_name,
        u.full_name AS created_by_name
      FROM orders o LEFT JOIN users u ON u.id = o.created_by
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY o.created_at DESC, o.id DESC LIMIT ${limit}`, ...params);

    // Détail compact pour l'historique (articles + modes de paiement), en deux requêtes au total.
    const byOrder = new Map(orders.map((o) => [o.id, Object.assign(o, { items: [], payment_methods: [] })]));
    if (orders.length) {
      const ids = orders.map((o) => o.id);
      const marks = ids.map(() => '?').join(', ');
      const items = await db.all(`
        SELECT order_id, product_name, unit_price, quantity, unit_price * quantity AS amount
        FROM order_items WHERE order_id IN (${marks}) ORDER BY id`, ...ids);
      for (const { order_id: orderId, ...item } of items) byOrder.get(orderId).items.push(item);
      const methods = await db.all(`
        SELECT order_id, method_name, method_type, SUM(amount) AS amount
        FROM payments WHERE order_id IN (${marks})
        GROUP BY order_id, method_name, method_type ORDER BY MIN(id)`, ...ids);
      for (const { order_id: orderId, ...m } of methods) byOrder.get(orderId).payment_methods.push(m);
    }
    res.json(orders);
  });

  app.get('/api/orders/:id', async (req, res) => {
    res.json(await requireOrder(toInt(req.params.id, 'id')));
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

  async function nextOrderNumber(tx, now) {
    const day = now.slice(0, 10).replaceAll('-', '');
    const prefix = `CMD-${day}-`;
    const last = await tx.get('SELECT number FROM orders WHERE number LIKE ? ORDER BY number DESC LIMIT 1', `${prefix}%`);
    const seq = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
    return `${prefix}${String(seq).padStart(4, '0')}`;
  }

  function recomputeTotal(tx, orderId, now) {
    return tx.run(`UPDATE orders SET
        total = COALESCE((SELECT SUM(unit_price * quantity) FROM order_items WHERE order_id = ?), 0),
        updated_at = ?
      WHERE id = ?`, orderId, now, orderId);
  }

  /** Ajoute les articles à une commande ouverte : fusionne avec une ligne existante au même prix. */
  async function addItems(tx, orderId, items, now) {
    for (const { product_id, quantity } of items) {
      const p = await tx.get(`
        SELECT p.*, f.name AS family_name,
          COALESCE((SELECT SUM(oi.quantity) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                    WHERE oi.product_id = p.id AND o.status = 'open'), 0) AS reserved
        FROM products p JOIN families f ON f.id = p.family_id
        WHERE p.id = ? AND p.archived = 0`, product_id);
      if (!p) throw badRequest('Produit introuvable.');
      if (!p.available) throw conflict(`« ${p.name} » n’est pas disponible actuellement.`);
      if (p.track_stock) {
        const free = p.stock - p.reserved;
        if (quantity > free) {
          throw conflict(`Stock insuffisant pour « ${p.name} » : ${Math.max(free, 0)} disponible(s).`);
        }
      }
      const line = await tx.get('SELECT id FROM order_items WHERE order_id = ? AND product_id = ? AND unit_price = ?',
        orderId, product_id, p.price);
      if (line) {
        await tx.run('UPDATE order_items SET quantity = quantity + ?, updated_at = ? WHERE id = ?', quantity, now, line.id);
      } else {
        await tx.run(`INSERT INTO order_items
          (order_id, product_id, product_name, family_name, unit_price, unit_cost, quantity, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          orderId, product_id, p.name, p.family_name, p.price, p.cost_price, quantity, now, now);
      }
    }
    await recomputeTotal(tx, orderId, now);
  }

  // Ajoute des articles sur une table : complète la commande ouverte de la table ou en crée une nouvelle.
  app.post('/api/orders', async (req, res) => {
    const tableId = toInt(req.body?.table_id, 'table', { min: 1 });
    const customerId = toInt(req.body?.customer_id, 'client', { min: 1, optional: true });
    const items = parseItems(req.body);
    const { orderId, created } = await db.transaction(async (tx) => {
      const customer = customerId ? await requireCustomer(customerId, tx) : null;
      const table = await tx.get('SELECT * FROM bar_tables WHERE id = ? AND archived = 0', tableId);
      if (!table) throw badRequest('Table introuvable.');
      const now = req.now;
      const open = await tx.get(
        "SELECT id, created_at, customer_id, customer_name FROM orders WHERE table_id = ? AND status = 'open'", tableId);
      // Rattrapage : ne jamais mêler une vente passée à la commande en cours d'une autre journée.
      if (open && req.backdate && open.created_at.slice(0, 10) !== req.backdate) {
        throw conflict(`${table.name} a une commande en cours d'une autre journée : choisissez une autre table pour le rattrapage.`);
      }
      // Une table = une commande ouverte = au plus un client.
      if (open && customer && open.customer_id && open.customer_id !== customer.id) {
        throw conflict(`${table.name} est occupée par la commande de ${open.customer_name} : choisissez une autre table.`);
      }
      let id = open?.id;
      if (!id) {
        const r = await tx.run(`INSERT INTO orders
          (number, table_id, table_name, status, customer_id, customer_name, created_by, created_at, updated_at)
          VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?)`, await nextOrderNumber(tx, now), tableId, table.name,
          customer?.id ?? null, customer?.name ?? null, req.user.id, now, now);
        id = Number(r.lastInsertRowid);
      } else if (customer && !open.customer_id) {
        await tx.run('UPDATE orders SET customer_id = ?, customer_name = ? WHERE id = ?', customer.id, customer.name, id);
      }
      await addItems(tx, id, items, now);
      return { orderId: id, created: !open };
    });
    res.status(created ? 201 : 200).json({ created, order: await loadOrder(orderId) });
  });

  app.post('/api/orders/:id/items', async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const items = parseItems(req.body);
    await db.transaction(async (tx) => {
      const order = await requireOrder(id, tx);
      requireEditable(req, order);
      if (order.status === 'open') requireSameDay(req, order);
      // Correction d'une commande payée : horodatée maintenant, pas à la date de la vente.
      const now = order.status === 'paid' ? nowLocal() : req.now;
      await addItems(tx, id, items, now);
      if (order.status === 'paid') {
        for (const { product_id: productId, quantity } of items) {
          await correctPaidStock(tx, order, productId, quantity, now, req.user.id);
        }
        await settlePaidOrder(tx, id, now);
      }
    });
    res.json(await loadOrder(id));
  });

  // Correction d'une ligne (quantité 0 = suppression) : commande ouverte, ou payée (responsable).
  app.patch('/api/orders/:id/items/:itemId', async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const itemId = toInt(req.params.itemId, 'article');
    const quantity = toInt(req.body?.quantity, 'quantité', { min: 0, max: MAX_QTY });
    await db.transaction(async (tx) => {
      const order = await requireOrder(id, tx);
      requireEditable(req, order);
      const paid = order.status === 'paid';
      const item = order.items.find((i) => i.id === itemId);
      if (!item) throw notFound('Article introuvable dans cette commande.');
      if (paid && quantity === 0 && order.items.length === 1) {
        throw conflict('Une commande payée doit garder au moins un article.');
      }
      if (quantity > item.quantity) {
        const p = await tx.get('SELECT * FROM products WHERE id = ?', item.product_id);
        if (p?.track_stock) {
          const { n: reserved } = await tx.get(`SELECT COALESCE(SUM(oi.quantity), 0) AS n FROM order_items oi
            JOIN orders o ON o.id = oi.order_id WHERE oi.product_id = ? AND o.status = 'open'`, p.id);
          const free = p.stock - reserved;
          if (quantity - item.quantity > free) {
            throw conflict(`Stock insuffisant pour « ${p.name} » : ${Math.max(free, 0)} disponible(s).`);
          }
        }
      }
      const newTotal = order.total - item.amount + item.unit_price * quantity;
      if (!paid && newTotal < order.paid_amount) {
        throw conflict('Impossible : le total deviendrait inférieur au montant déjà payé.');
      }
      const now = paid ? nowLocal() : req.now;
      if (quantity === 0) await tx.run('DELETE FROM order_items WHERE id = ?', itemId);
      else await tx.run('UPDATE order_items SET quantity = ?, updated_at = ? WHERE id = ?', quantity, now, itemId);
      await recomputeTotal(tx, id, now);
      if (paid) {
        await correctPaidStock(tx, order, item.product_id, quantity - item.quantity, now, req.user.id);
        await settlePaidOrder(tx, id, now);
      }
    });
    res.json(await loadOrder(id));
  });

  /**
   * Date et heure de la vente (responsable) : toute la commande est déplacée — ouverture, paiements,
   * clôture et sorties de stock liées gardent leur heure sur le nouveau jour — et renumérotée pour ce jour.
   */
  app.put('/api/orders/:id/date', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const date = String(req.body?.date ?? '');
    const time = String(req.body?.time ?? '');
    if (!isIsoDate(date)) throw badRequest('Date invalide.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw badRequest('Heure invalide (format HH:MM).');
    const created = `${date} ${time}:00`;
    if (created > nowLocal()) throw badRequest('La date de vente ne peut pas être dans le futur.');
    await db.transaction(async (tx) => {
      const order = await requireOrder(id, tx);
      if (order.status === 'cancelled') throw conflict('Cette commande est annulée.');
      // Même heure, nouveau jour, jamais avant l'ouverture de la commande.
      const moved = (stamp) => {
        const value = `${date} ${stamp.slice(11)}`;
        return value < created ? created : value;
      };
      const number = date === order.created_at.slice(0, 10) ? order.number : await nextOrderNumber(tx, created);
      await tx.run('UPDATE orders SET number = ?, created_at = ?, closed_at = ?, updated_at = ? WHERE id = ?',
        number, created, order.closed_at ? moved(order.closed_at) : null, nowLocal(), id);
      for (const p of order.payments) await tx.run('UPDATE payments SET created_at = ? WHERE id = ?', moved(p.created_at), p.id);
      // Sorties de stock de la vente (pas les corrections faites après coup).
      const moves = await tx.all("SELECT id, created_at FROM stock_movements WHERE order_id = ? AND note IS NULL", id);
      for (const m of moves) await tx.run('UPDATE stock_movements SET created_at = ? WHERE id = ?', moved(m.created_at), m.id);
      for (const item of order.items) {
        await tx.run('UPDATE order_items SET created_at = ? WHERE id = ?', moved(item.created_at), item.id);
      }
    });
    res.json(await loadOrder(id));
  });

  // Mode de paiement d'un encaissement déjà fait (responsable) : correction d'une erreur de saisie.
  app.put('/api/orders/:id/payments/:paymentId', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const paymentId = toInt(req.params.paymentId, 'paiement');
    const methodId = toInt(req.body?.method_id, 'mode de paiement', { min: 1 });
    await db.transaction(async (tx) => {
      const payment = await tx.get('SELECT * FROM payments WHERE id = ? AND order_id = ?', paymentId, id);
      if (!payment) throw notFound('Paiement introuvable.');
      const method = await tx.get('SELECT * FROM payment_methods WHERE id = ? AND archived = 0', methodId);
      if (!method) throw badRequest('Mode de paiement introuvable.');
      const cash = method.type === 'cash';
      await tx.run(`UPDATE payments SET method_id = ?, method_name = ?, method_type = ?, received_amount = ?,
        change_amount = ?, reference = ? WHERE id = ?`,
        method.id, method.name, method.type, cash ? (payment.method_type === 'cash' ? payment.received_amount : payment.amount) : null,
        cash ? (payment.method_type === 'cash' ? payment.change_amount : 0) : null,
        cash ? null : payment.reference, paymentId);
    });
    res.json(await loadOrder(id));
  });

  // Client d'une commande : rattacher, changer ou retirer (null). Commande clôturée : responsable seulement.
  app.put('/api/orders/:id/customer', async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const customerId = req.body?.customer_id === null ? null : toInt(req.body?.customer_id, 'client', { min: 1 });
    await db.transaction(async (tx) => {
      const order = await requireOrder(id, tx);
      if (order.status !== 'open' && req.user.role !== 'admin') {
        throw conflict('Seul le responsable peut changer le client d’une commande clôturée.');
      }
      const customer = customerId ? await requireCustomer(customerId, tx) : null;
      await tx.run('UPDATE orders SET customer_id = ?, customer_name = ?, updated_at = ? WHERE id = ?',
        customer?.id ?? null, customer?.name ?? null, req.now, id);
    });
    res.json(await loadOrder(id));
  });

  // Transfert d'une commande ouverte vers une autre table libre.
  app.post('/api/orders/:id/transfer', async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const tableId = toInt(req.body?.table_id, 'table', { min: 1 });
    await db.transaction(async (tx) => {
      const order = await requireOrder(id, tx);
      requireOpen(order);
      const table = await tx.get('SELECT * FROM bar_tables WHERE id = ? AND archived = 0', tableId);
      if (!table) throw badRequest('Table introuvable.');
      if (table.id === order.table_id) return;
      const busy = await tx.get("SELECT id FROM orders WHERE table_id = ? AND status = 'open'", tableId);
      if (busy) throw conflict(`${table.name} a déjà une commande ouverte.`);
      await tx.run('UPDATE orders SET table_id = ?, table_name = ?, updated_at = ? WHERE id = ?',
        table.id, table.name, req.now, id);
    });
    res.json(await loadOrder(id));
  });

  app.post('/api/orders/:id/cancel', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const reason = toText(req.body?.reason, 'motif', { max: 200, optional: true }) ?? null;
    await db.transaction(async (tx) => {
      const order = await requireOrder(id, tx);
      requireOpen(order);
      if (order.paid_amount > 0) throw conflict('Impossible d’annuler une commande partiellement payée.');
      requireSameDay(req, order);
      const now = req.now;
      await tx.run("UPDATE orders SET status = 'cancelled', cancel_reason = ?, closed_at = ?, updated_at = ? WHERE id = ?",
        reason, now, now, id);
    });
    res.json(await loadOrder(id));
  });

  // ---------- Paiement ----------
  app.post('/api/orders/:id/payments', async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const methodId = toInt(req.body?.method_id, 'mode de paiement', { min: 1 });
    const reference = toText(req.body?.reference, 'référence', { max: 60, optional: true }) ?? null;

    const result = await db.transaction(async (tx) => {
      const order = await requireOrder(id, tx);
      requireOpen(order);
      if (order.total <= 0) throw conflict('La commande est vide.');
      const method = await tx.get('SELECT * FROM payment_methods WHERE id = ? AND archived = 0', methodId);
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

      requireSameDay(req, order);
      const now = req.now;
      await tx.run(`INSERT INTO payments
        (order_id, method_id, method_name, method_type, amount, received_amount, change_amount, reference, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, method.id, method.name, method.type, amount, received, change, reference, req.user.id, now);
      const paid = order.paid_amount + amount;
      const fullyPaid = paid === order.total;
      if (fullyPaid) {
        await tx.run("UPDATE orders SET paid_amount = ?, status = 'paid', closed_at = ?, updated_at = ? WHERE id = ?",
          paid, now, now, id);
        // Mise à jour du stock des produits suivis (mouvement « vente »).
        for (const item of order.items) {
          const product = await tx.get('SELECT track_stock FROM products WHERE id = ?', item.product_id);
          if (!product?.track_stock) continue;
          await applyStockMovement(tx, {
            productId: item.product_id, type: 'vente', delta: -item.quantity, orderId: id, userId: req.user.id, at: now,
          });
        }
      } else {
        await tx.run('UPDATE orders SET paid_amount = ?, updated_at = ? WHERE id = ?', paid, now, id);
      }
      return { fullyPaid, change };
    });
    res.status(201).json({ fully_paid: result.fullyPaid, change: result.change, order: await loadOrder(id) });
  });
};
