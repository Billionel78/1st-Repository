'use strict';

const { nowLocal } = require('./time');

/**
 * Applique une variation de stock à un produit et l'enregistre dans stock_movements.
 * `delta` est signé : positif pour une entrée, négatif pour une sortie.
 * À appeler à l'intérieur d'une transaction.
 */
function applyStockMovement(db, { productId, type, delta, unitCost = null, note = null, orderId = null, userId = null, at }) {
  const now = at ?? nowLocal();
  db.prepare('UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?').run(delta, now, productId);
  const { stock } = db.prepare('SELECT stock FROM products WHERE id = ?').get(productId);
  db.prepare(`INSERT INTO stock_movements
    (product_id, type, quantity, stock_after, unit_cost, note, order_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(productId, type, delta, stock, unitCost, note, orderId, userId, now);
  return stock;
}

module.exports = { applyStockMovement };
