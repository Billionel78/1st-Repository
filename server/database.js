'use strict';

// Couche d'accès aux données, commune à SQLite et PostgreSQL.
//
//   await db.get(sql, ...params)   → première ligne ou undefined
//   await db.all(sql, ...params)   → lignes
//   await db.run(sql, ...params)   → { changes, lastInsertRowid }
//   await db.exec(sql)             → plusieurs instructions, sans paramètres
//   await db.transaction(async (tx) => …)  tx offre les mêmes méthodes
//
// Le SQL est écrit une seule fois, avec des paramètres « ? », dans un sous-ensemble compris par
// les deux moteurs. Les écritures en transaction sont sérialisées (une à la fois), comme SQLite le
// fait naturellement : les numéros de commande et les contrôles de stock restent cohérents.

// Tables dont la clé « id » est renvoyée après un INSERT (lastInsertRowid).
const ID_TABLES = new Set([
  'users', 'families', 'products', 'bar_tables', 'payment_methods', 'orders', 'order_items', 'payments', 'stock_movements',
  'images',
]);

/** File d'attente asynchrone : une seule section critique à la fois. */
function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  };
}

// ---------------------------------------------------------------------------------------------
// SQLite (node:sqlite, ou sql.js dans le navigateur) : moteur synchrone, interface asynchrone.
// ---------------------------------------------------------------------------------------------
/** Requêtes directes sur la connexion SQLite (synchrone). */
class SqliteQueries {
  constructor(raw) {
    this.raw = raw;
    this.dialect = 'sqlite';
  }

  async get(sql, ...params) { return this.raw.prepare(sql).get(...params); }
  async all(sql, ...params) { return this.raw.prepare(sql).all(...params); }
  async exec(sql) { this.raw.exec(sql); }

  async run(sql, ...params) {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
}

class SqliteDatabase extends SqliteQueries {
  constructor(raw) {
    super(raw);
    this.exclusive = createMutex();
    this.direct = new SqliteQueries(raw);
  }

  // Une seule connexion : une écriture hors transaction attend la fin de la transaction en cours,
  // sinon elle en ferait partie (et serait annulée avec elle).
  run(sql, ...params) { return this.exclusive(() => this.direct.run(sql, ...params)); }
  exec(sql) { return this.exclusive(() => this.direct.exec(sql)); }

  transaction(fn) {
    return this.exclusive(async () => {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(this.direct);
        this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        this.raw.exec('ROLLBACK');
        throw err;
      }
    });
  }

  async close() { this.raw.close(); }
}

// ---------------------------------------------------------------------------------------------
// PostgreSQL
// ---------------------------------------------------------------------------------------------

/** Remplace les « ? » par $1, $2… (hors chaînes entre apostrophes). */
function toPgPlaceholders(sql) {
  let n = 0;
  let out = '';
  let quoted = false;
  for (const ch of sql) {
    if (ch === "'") quoted = !quoted;
    out += ch === '?' && !quoted ? `$${++n}` : ch;
  }
  return out;
}

function withReturningId(sql) {
  const m = /^\s*INSERT\s+INTO\s+(\w+)/i.exec(sql);
  return m && ID_TABLES.has(m[1]) && !/\bRETURNING\b/i.test(sql) ? `${sql} RETURNING id` : sql;
}

const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);

/** Méthodes communes, au-dessus d'une fonction query(text, params) → { rows, rowCount }. */
class PgQueries {
  constructor(query) {
    this.query = query;
    this.dialect = 'postgres';
  }

  async get(sql, ...params) { return (await this.query(toPgPlaceholders(sql), params.map(norm))).rows[0]; }
  async all(sql, ...params) { return (await this.query(toPgPlaceholders(sql), params.map(norm))).rows; }
  async exec(sql) { await this.query(sql); }

  async run(sql, ...params) {
    const r = await this.query(withReturningId(toPgPlaceholders(sql)), params.map(norm));
    return { changes: r.rowCount ?? r.affectedRows ?? 0, lastInsertRowid: r.rows?.[0]?.id ?? null };
  }
}

/** Serveur PostgreSQL (Neon, etc.) via un pool de connexions `pg`. */
class PostgresDatabase extends PgQueries {
  constructor(pool) {
    super((text, params) => pool.query(text, params));
    this.pool = pool;
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Verrou de transaction : les écritures s'exécutent une à la fois, sur toutes les instances.
      await client.query('SELECT pg_advisory_xact_lock(7426001)');
      const result = await fn(new PgQueries((text, params) => client.query(text, params)));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close() { await this.pool.end(); }
}

/** PostgreSQL embarqué (PGlite), utilisé par les tests. */
class PgliteDatabase extends PgQueries {
  constructor(pglite) {
    super((text, params) => pglite.query(text, params));
    this.pglite = pglite;
    this.exclusive = createMutex();
  }

  transaction(fn) {
    return this.exclusive(() => this.pglite.transaction((tx) => fn(new PgQueries((text, params) => tx.query(text, params)))));
  }

  async close() { await this.pglite.close(); }
}

/** Ouvre une base PostgreSQL à partir d'une URL de connexion (DATABASE_URL). */
function connectPostgres(url, { max = Number(process.env.PG_POOL_MAX) || 5 } = {}) {
  const pg = require('pg');
  // COUNT et SUM renvoient des bigint / numeric : on les veut en nombres JavaScript.
  pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));
  pg.types.setTypeParser(1700, (v) => Number.parseFloat(v));
  const config = { connectionString: url, max };
  if (/channel_binding=require/.test(url)) config.enableChannelBinding = true;
  return new PostgresDatabase(new pg.Pool(config));
}

module.exports = { SqliteDatabase, PostgresDatabase, PgliteDatabase, connectPostgres, toPgPlaceholders };
