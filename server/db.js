'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./security');
const { nowLocal } = require('./time');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'serveur')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS families (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  color    TEXT NOT NULL DEFAULT '#2563eb',
  icon     TEXT NOT NULL DEFAULT '🍹',
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id   INTEGER NOT NULL REFERENCES families(id),
  name        TEXT NOT NULL,
  price       INTEGER NOT NULL CHECK (price >= 0),
  track_stock INTEGER NOT NULL DEFAULT 0,
  stock       INTEGER NOT NULL DEFAULT 0,
  available   INTEGER NOT NULL DEFAULT 1,
  archived    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_family ON products(family_id);

CREATE TABLE IF NOT EXISTS bar_tables (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  type     TEXT NOT NULL CHECK (type IN ('cash', 'mobile_money', 'other')),
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT NOT NULL UNIQUE,
  table_id    INTEGER NOT NULL REFERENCES bar_tables(id),
  table_name  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('open', 'paid', 'cancelled')),
  total       INTEGER NOT NULL DEFAULT 0,
  paid_amount INTEGER NOT NULL DEFAULT 0,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  closed_at   TEXT,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_closed ON orders(closed_at);
-- Une seule commande ouverte par table.
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_open_per_table
  ON orders(table_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS order_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  family_name  TEXT NOT NULL,
  unit_price   INTEGER NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_product ON order_items(product_id);

CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id        INTEGER NOT NULL REFERENCES orders(id),
  method_id       INTEGER NOT NULL REFERENCES payment_methods(id),
  method_name     TEXT NOT NULL,
  method_type     TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount > 0),
  received_amount INTEGER,
  change_amount   INTEGER,
  reference       TEXT,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_order ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at);

-- Mouvements de stock : entrées, pertes, inventaires, ventes, ajustements.
CREATE TABLE IF NOT EXISTS stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  type        TEXT NOT NULL CHECK (type IN ('entree', 'perte', 'inventaire', 'vente', 'ajustement')),
  quantity    INTEGER NOT NULL,
  stock_after INTEGER NOT NULL,
  unit_cost   INTEGER,
  note        TEXT,
  order_id    INTEGER REFERENCES orders(id),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_movements_created ON stock_movements(created_at);
`;

// Colonnes ajoutées après la première version : ajoutées automatiquement aux bases existantes.
const MIGRATIONS = [
  ['products', 'cost_price', 'INTEGER NOT NULL DEFAULT 0'],
  ['products', 'alert_threshold', 'INTEGER NOT NULL DEFAULT 0'],
  ['order_items', 'unit_cost', 'INTEGER NOT NULL DEFAULT 0'],
];

function migrate(db) {
  for (const [table, column, definition] of MIGRATIONS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

const DEFAULT_FAMILIES = [
  { name: 'Bières', color: '#d97706', icon: '🍺', products: [['Vox 66', 1000], ['Castle Beer', 1000], ['Flag', 800], ['Guinness', 1200]] },
  { name: 'Vins', color: '#9f1239', icon: '🍷', products: [['Vin rouge (verre)', 1500], ['Vin blanc (verre)', 1500], ['Bouteille de vin rouge', 8000]] },
  { name: 'Liqueurs', color: '#7c3aed', icon: '🥃', products: [['Whisky (verre)', 2000], ['Pastis (verre)', 1500], ['Gin (verre)', 1500]] },
  { name: 'Boissons non alcoolisées', color: '#0891b2', icon: '🧃', products: [['Eau minérale', 500], ['Jus de fruit', 700], ['Malta', 700]] },
  { name: 'Sucreries', color: '#db2777', icon: '🥤', products: [['Coca-Cola', 600], ['Fanta', 600], ['Sprite', 600]] },
  { name: 'Autres produits', color: '#475569', icon: '🛒', products: [['Arachides', 300], ['Cigarettes (paquet)', 1500]] },
];

const DEFAULT_PAYMENT_METHODS = [
  ['Espèces (Cash)', 'cash'],
  ['Orange Money', 'mobile_money'],
  ['MTN Mobile Money', 'mobile_money'],
  ['Wave', 'mobile_money'],
];

function openDatabase(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Exécute fn dans une transaction SQLite (rollback en cas d'erreur). */
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Données initiales : administrateur, familles, produits, tables, moyens de paiement. */
function seed(db, { adminPassword = 'admin123', demoCatalog = true } = {}) {
  const now = nowLocal();
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (hasUsers) return false;

  transaction(db, () => {
    db.prepare(
      'INSERT INTO users (username, full_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('admin', 'Responsable', hashPassword(adminPassword), 'admin', now);

    const setSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
    setSetting.run('bar_name', 'ICE MANAGER');
    setSetting.run('currency', 'FCFA');

    const insMethod = db.prepare('INSERT INTO payment_methods (name, type, position) VALUES (?, ?, ?)');
    DEFAULT_PAYMENT_METHODS.forEach(([name, type], i) => insMethod.run(name, type, i));

    const insTable = db.prepare('INSERT INTO bar_tables (name, position) VALUES (?, ?)');
    for (let i = 1; i <= 8; i++) insTable.run(`Table ${i}`, i);

    if (demoCatalog) {
      const insFamily = db.prepare('INSERT INTO families (name, color, icon, position) VALUES (?, ?, ?, ?)');
      const insProduct = db.prepare(
        'INSERT INTO products (family_id, name, price, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
      );
      DEFAULT_FAMILIES.forEach((f, i) => {
        const familyId = Number(insFamily.run(f.name, f.color, f.icon, i).lastInsertRowid);
        for (const [name, price] of f.products) insProduct.run(familyId, name, price, now, now);
      });
    }
  });
  return true;
}

module.exports = { openDatabase, transaction, seed };
