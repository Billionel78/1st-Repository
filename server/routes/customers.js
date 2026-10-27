'use strict';

const { badRequest, notFound, conflict, toInt, toText } = require('../http');

/** Texte facultatif qu'on peut effacer : null pour vider, undefined pour ne pas y toucher. */
function clearable(value, field, max) {
  if (value === undefined) return undefined;
  if (value === null || String(value).trim() === '') return null;
  return toText(value, field, { max });
}

// Statistiques d'un client : visites et dépenses (commandes payées), commande en cours.
const CUSTOMER_SELECT = `
  SELECT c.id, c.name, c.phone, c.notes, c.table_id, t.name AS table_name, c.created_at,
    (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id AND o.status = 'paid') AS visits,
    COALESCE((SELECT SUM(o.total) FROM orders o WHERE o.customer_id = c.id AND o.status = 'paid'), 0) AS total_spent,
    (SELECT MAX(o.created_at) FROM orders o WHERE o.customer_id = c.id AND o.status <> 'cancelled') AS last_visit,
    (SELECT MIN(o.id) FROM orders o WHERE o.customer_id = c.id AND o.status = 'open') AS open_order_id
  FROM customers c LEFT JOIN bar_tables t ON t.id = c.table_id AND t.archived = 0`;

module.exports = function customerRoutes(app, db, { requireAdmin }) {
  const getCustomer = (id, q = db) => q.get(`${CUSTOMER_SELECT} WHERE c.id = ? AND c.archived = 0`, id);

  /** Client actif, ou erreur claire (utilisé aussi par les commandes). */
  async function requireCustomer(id, q = db) {
    const c = await q.get('SELECT id, name, table_id FROM customers WHERE id = ? AND archived = 0', id);
    if (!c) throw badRequest('Client introuvable.');
    return c;
  }

  async function input(body, partial, q = db) {
    const tableId = body?.table_id === null || body?.table_id === ''
      ? null : toInt(body?.table_id, 'table habituelle', { min: 1, optional: true });
    if (tableId) {
      const t = await q.get('SELECT id FROM bar_tables WHERE id = ? AND archived = 0', tableId);
      if (!t) throw badRequest('Table introuvable.');
    }
    return {
      name: toText(body?.name, 'nom', { max: 80, optional: partial }),
      phone: clearable(body?.phone, 'téléphone', 30),
      notes: clearable(body?.notes, 'notes', 300),
      table_id: tableId,
    };
  }

  app.get('/api/customers', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const rows = q
      ? await db.all(`${CUSTOMER_SELECT} WHERE c.archived = 0 AND (lower(c.name) LIKE ? OR c.phone LIKE ?)
          ORDER BY lower(c.name)`, `%${q}%`, `%${q}%`)
      : await db.all(`${CUSTOMER_SELECT} WHERE c.archived = 0 ORDER BY lower(c.name)`);
    res.json(rows);
  });

  app.get('/api/customers/:id', async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const customer = await getCustomer(id);
    if (!customer) throw notFound('Client introuvable.');
    customer.orders = await db.all(`
      SELECT id, number, table_name, status, total, paid_amount, created_at, closed_at
      FROM orders WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`, id);
    res.json(customer);
  });

  // Tout le personnel peut enregistrer un client pendant le service.
  app.post('/api/customers', async (req, res) => {
    const c = await input(req.body, false);
    const r = await db.run(`INSERT INTO customers (name, phone, notes, table_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`, c.name, c.phone ?? null, c.notes ?? null, c.table_id ?? null, req.now, req.now);
    res.status(201).json(await getCustomer(r.lastInsertRowid));
  });

  app.put('/api/customers/:id', async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const current = await db.get('SELECT * FROM customers WHERE id = ? AND archived = 0', id);
    if (!current) throw notFound('Client introuvable.');
    const c = await input(req.body, true);
    const name = c.name ?? current.name;
    await db.transaction(async (tx) => {
      await tx.run('UPDATE customers SET name = ?, phone = ?, notes = ?, table_id = ?, updated_at = ? WHERE id = ?',
        name, c.phone === undefined ? current.phone : c.phone, c.notes === undefined ? current.notes : c.notes,
        c.table_id === undefined ? current.table_id : c.table_id, req.now, id);
      // Le nom affiché sur ses commandes en cours suit la fiche.
      if (name !== current.name) {
        await tx.run("UPDATE orders SET customer_name = ? WHERE customer_id = ? AND status = 'open'", name, id);
      }
    });
    res.json(await getCustomer(id));
  });

  // Archivage : l'historique de ses commandes (et le nom qui y figure) est conservé.
  app.delete('/api/customers/:id', requireAdmin, async (req, res) => {
    const id = toInt(req.params.id, 'id');
    const c = await getCustomer(id);
    if (!c) throw notFound('Client introuvable.');
    if (c.open_order_id) throw conflict('Ce client a une commande en cours : encaissez-la avant de le supprimer.');
    await db.run('UPDATE customers SET archived = 1, updated_at = ? WHERE id = ?', req.now, id);
    res.json({ ok: true });
  });

  return { requireCustomer };
};
