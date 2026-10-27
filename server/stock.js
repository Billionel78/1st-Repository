'use strict';

const { nowLocal } = require('./time');

/**
 * Applique une variation de stock à un produit et l'enregistre dans stock_movements.
 * `delta` est signé : positif pour une entrée, négatif pour une sortie.
 * `q` est la transaction en cours.
 */
async function applyStockMovement(q, { productId, type, delta, unitCost = null, note = null, orderId = null, userId = null, at }) {
  const now = at ?? nowLocal();
  await q.run('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?', delta, now, productId);
  const { stock } = await q.get('SELECT stock FROM products WHERE id = ?', productId);
  await q.run(`INSERT INTO stock_movements
    (product_id, type, quantity, stock_after, unit_cost, note, order_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, productId, type, delta, stock, unitCost, note, orderId, userId, now);
  return stock;
}

module.exports = { applyStockMovement };
