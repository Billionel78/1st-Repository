'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SqliteDatabase } = require('./database');
const { hashPassword } = require('./security');
const { nowLocal } = require('./time');

// Schéma SQLite (fichier local, version navigateur).
const SQLITE_SCHEMA = `
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

-- Photos des produits (serveur) : stockées à part pour garder la liste des produits légère.
CREATE TABLE IF NOT EXISTS images (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mime       TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Clients : coordonnées, notes et table habituelle.
CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  phone      TEXT,
  notes      TEXT,
  table_id   INTEGER REFERENCES bar_tables(id),
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Fournisseurs, leur catalogue de prix (par conditionnement : casier, carton…) et les approvisionnements.
CREATE TABLE IF NOT EXISTS suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  contact    TEXT,
  phone      TEXT,
  address    TEXT,
  notes      TEXT,
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_prices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  pack_size   INTEGER NOT NULL DEFAULT 1 CHECK (pack_size >= 1),
  pack_price  INTEGER NOT NULL CHECK (pack_price >= 0),
  updated_at  TEXT NOT NULL,
  UNIQUE (supplier_id, product_id)
);

CREATE TABLE IF NOT EXISTS purchases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  number        TEXT NOT NULL UNIQUE,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  supplier_name TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'cancelled')),
  total         INTEGER NOT NULL DEFAULT 0,
  paid_amount   INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  cancel_reason TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchases_created ON purchases(created_at);

CREATE TABLE IF NOT EXISTS purchase_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id  INTEGER NOT NULL REFERENCES purchases(id),
  product_id   INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  packs        INTEGER NOT NULL,
  pack_size    INTEGER NOT NULL,
  pack_price   INTEGER NOT NULL,
  quantity     INTEGER NOT NULL,
  unit_cost    INTEGER NOT NULL,
  total        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
`;

// Schéma PostgreSQL (Neon ou tout autre serveur PostgreSQL) : mêmes tables et mêmes colonnes.
const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  username      TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'serveur')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (lower(username));

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS families (
  id       INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name     TEXT NOT NULL,
  color    TEXT NOT NULL DEFAULT '#2563eb',
  icon     TEXT NOT NULL DEFAULT '🍹',
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id              INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  family_id       INTEGER NOT NULL REFERENCES families(id),
  name            TEXT NOT NULL,
  price           INTEGER NOT NULL CHECK (price >= 0),
  cost_price      INTEGER NOT NULL DEFAULT 0,
  alert_threshold INTEGER NOT NULL DEFAULT 0,
  track_stock     INTEGER NOT NULL DEFAULT 0,
  stock           INTEGER NOT NULL DEFAULT 0,
  available       INTEGER NOT NULL DEFAULT 1,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_family ON products(family_id);

CREATE TABLE IF NOT EXISTS bar_tables (
  id       INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name     TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payment_methods (
  id       INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name     TEXT NOT NULL,
  type     TEXT NOT NULL CHECK (type IN ('cash', 'mobile_money', 'other')),
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  number        TEXT NOT NULL UNIQUE,
  table_id      INTEGER NOT NULL REFERENCES bar_tables(id),
  table_name    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('open', 'paid', 'cancelled')),
  total         INTEGER NOT NULL DEFAULT 0,
  paid_amount   INTEGER NOT NULL DEFAULT 0,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  closed_at     TEXT,
  cancel_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_closed ON orders(closed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_one_open_per_table ON orders(table_id) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS order_items (
  id           INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  family_name  TEXT NOT NULL,
  unit_price   INTEGER NOT NULL,
  unit_cost    INTEGER NOT NULL DEFAULT 0,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_items_product ON order_items(product_id);

CREATE TABLE IF NOT EXISTS payments (
  id              INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS stock_movements (
  id          INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS images (
  id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  mime       TEXT NOT NULL,
  data       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  phone      TEXT,
  notes      TEXT,
  table_id   INTEGER REFERENCES bar_tables(id),
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Fournisseurs, leur catalogue de prix (par conditionnement : casier, carton…) et les approvisionnements.
CREATE TABLE IF NOT EXISTS suppliers (
  id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  contact    TEXT,
  phone      TEXT,
  address    TEXT,
  notes      TEXT,
  archived   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS supplier_prices (
  id          INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  pack_size   INTEGER NOT NULL DEFAULT 1 CHECK (pack_size >= 1),
  pack_price  INTEGER NOT NULL CHECK (pack_price >= 0),
  updated_at  TEXT NOT NULL,
  UNIQUE (supplier_id, product_id)
);

CREATE TABLE IF NOT EXISTS purchases (
  id            INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  number        TEXT NOT NULL UNIQUE,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
  supplier_name TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'cancelled')),
  total         INTEGER NOT NULL DEFAULT 0,
  paid_amount   INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  cancel_reason TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchases_created ON purchases(created_at);

CREATE TABLE IF NOT EXISTS purchase_items (
  id           INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  purchase_id  INTEGER NOT NULL REFERENCES purchases(id),
  product_id   INTEGER NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  packs        INTEGER NOT NULL,
  pack_size    INTEGER NOT NULL,
  pack_price   INTEGER NOT NULL,
  quantity     INTEGER NOT NULL,
  unit_cost    INTEGER NOT NULL,
  total        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id);
`;

// Colonnes ajoutées après la création des tables : ajoutées automatiquement aux bases existantes.
const MIGRATIONS = [
  ['products', 'cost_price', 'INTEGER NOT NULL DEFAULT 0'],
  ['products', 'alert_threshold', 'INTEGER NOT NULL DEFAULT 0'],
  ['order_items', 'unit_cost', 'INTEGER NOT NULL DEFAULT 0'],
  ['products', 'image_url', 'TEXT'],
  ['products', 'format', 'TEXT'],
  ['orders', 'customer_id', 'INTEGER REFERENCES customers(id)'],
  ['orders', 'customer_name', 'TEXT'],
  ['users', 'recovery_hash', 'TEXT'],
  ['users', 'reset_requested_at', 'TEXT'],
  ['stock_movements', 'purchase_id', 'INTEGER REFERENCES purchases(id)'],
];

/** Crée les tables manquantes et applique les migrations. */
async function migrate(db) {
  if (db.dialect === 'postgres') {
    await db.transaction(async (tx) => {
      for (const statement of POSTGRES_SCHEMA.split(';').map((x) => x.trim()).filter(Boolean)) {
        await tx.exec(statement);
      }
      for (const [table, column, definition] of MIGRATIONS) {
        await tx.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
      }
      await tx.exec('CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id)');
    });
    return;
  }
  await db.exec(SQLITE_SCHEMA);
  for (const [table, column, definition] of MIGRATIONS) {
    const columns = await db.all(`PRAGMA table_info(${table})`);
    if (!columns.some((c) => c.name === column)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  await db.exec('CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id)');
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

/** Ouvre (ou crée) une base SQLite : un fichier, ou ':memory:'. */
async function openSqlite(file) {
  const { DatabaseSync } = require('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') raw.exec('PRAGMA journal_mode = WAL;');
  const db = new SqliteDatabase(raw);
  await migrate(db);
  return db;
}

/** Ouvre la base configurée : PostgreSQL si DATABASE_URL est défini, sinon le fichier SQLite. */
async function openFromEnv(env = process.env) {
  if (env.DATABASE_URL) {
    const { connectPostgres } = require('./database');
    const db = connectPostgres(env.DATABASE_URL);
    await migrate(db);
    return db;
  }
  return openSqlite(env.DB_FILE || path.join(__dirname, '..', 'data', 'ice-manager.db'));
}

const hasUsers = async (db) => (await db.get('SELECT COUNT(*) AS n FROM users')).n > 0;

/**
 * Données initiales : compte du responsable, paramètres, moyens de paiement, tables et catalogue
 * de départ. Ne fait rien si la base contient déjà des utilisateurs.
 */
async function seed(db, {
  adminUsername = 'admin', adminFullName = 'Responsable', adminPassword = 'admin123',
  barName = 'ICE MANAGER', demoCatalog = true,
} = {}) {
  return db.transaction(async (tx) => {
    if ((await tx.get('SELECT COUNT(*) AS n FROM users')).n > 0) return false;
    const now = nowLocal();
    await tx.run('INSERT INTO users (username, full_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
      adminUsername, adminFullName, hashPassword(adminPassword), 'admin', now);

    for (const [key, value] of [['bar_name', barName], ['currency', 'FCFA']]) {
      await tx.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', key, value);
    }
    for (const [i, [name, type]] of DEFAULT_PAYMENT_METHODS.entries()) {
      await tx.run('INSERT INTO payment_methods (name, type, position) VALUES (?, ?, ?)', name, type, i);
    }
    for (let i = 1; i <= 8; i++) await tx.run('INSERT INTO bar_tables (name, position) VALUES (?, ?)', `Table ${i}`, i);

    if (demoCatalog) {
      for (const [i, f] of DEFAULT_FAMILIES.entries()) {
        const { lastInsertRowid: familyId } = await tx.run(
          'INSERT INTO families (name, color, icon, position) VALUES (?, ?, ?, ?)', f.name, f.color, f.icon, i);
        for (const [name, price] of f.products) {
          await tx.run('INSERT INTO products (family_id, name, price, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            familyId, name, price, now, now);
        }
      }
    }
    return true;
  });
}

module.exports = { openSqlite, openFromEnv, migrate, seed, hasUsers, SQLITE_SCHEMA, POSTGRES_SCHEMA };
