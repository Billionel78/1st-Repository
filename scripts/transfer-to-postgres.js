'use strict';

/**
 * Transfert d'une base ICE MANAGER SQLite (fichier .db) vers PostgreSQL (Neon…).
 *
 *   node scripts/transfer-to-postgres.js chemin/ice-manager.db [--remplacer]
 *
 * La base de destination est lue dans DATABASE_URL (variable d'environnement ou fichier .env).
 * Par sécurité, une base de destination qui contient déjà des données est refusée,
 * sauf avec --remplacer (toutes ses données sont alors effacées puis remplacées).
 */

const fs = require('node:fs');
const path = require('node:path');
const { openSqlite, migrate } = require('../server/db');

// Ordre d'insertion compatible avec les clés étrangères. Les sessions ne sont pas transférées.
const TABLES = [
  'users', 'settings', 'families', 'products', 'images', 'bar_tables', 'payment_methods', 'customers',
  'orders', 'order_items', 'payments', 'suppliers', 'supplier_prices', 'purchases', 'purchase_items', 'stock_movements',
];
const SKIPPED = new Set(['sessions', 'sqlite_sequence']);
const BATCH_ROWS = 200;
const BATCH_BYTES = 48 * 1024; // requêtes de taille raisonnable (photos en base64, réseau mobile)

/** Découpe les lignes en lots limités en nombre de lignes et en volume. */
function* batches(rows, cols) {
  let chunk = [];
  let bytes = 0;
  for (const row of rows) {
    const size = cols.reduce((a, c) => a + (typeof row[c] === 'string' ? row[c].length : 8), 0);
    if (chunk.length && (chunk.length >= BATCH_ROWS || bytes + size > BATCH_BYTES)) {
      yield chunk;
      chunk = [];
      bytes = 0;
    }
    chunk.push(row);
    bytes += size;
  }
  if (chunk.length) yield chunk;
}

async function transfer(source, target, { replace = false, log = () => {} } = {}) {
  // Toutes les tables de la source doivent être connues : aucune donnée ne doit être oubliée.
  const sourceTables = (await source.all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((t) => t.name);
  const unknown = sourceTables.filter((t) => !TABLES.includes(t) && !SKIPPED.has(t));
  if (unknown.length) throw new Error(`Tables non prises en charge par le transfert : ${unknown.join(', ')}.`);

  await migrate(target);
  const counts = {};
  await target.transaction(async (tx) => {
    const existing = await tx.get('SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM orders) + (SELECT COUNT(*) FROM products) AS n');
    if (existing.n > 0) {
      if (!replace) {
        throw new Error('La base PostgreSQL contient déjà des données. Relancez avec --remplacer pour les effacer et les remplacer.');
      }
      await tx.exec(`TRUNCATE ${[...TABLES, 'sessions'].join(', ')} RESTART IDENTITY CASCADE`);
      log('Données existantes de la base PostgreSQL effacées.');
    }

    for (const table of TABLES) {
      const srcCols = (await source.all(`PRAGMA table_info(${table})`)).map((c) => c.name);
      const dstCols = new Set((await tx.all(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?", table,
      )).map((c) => c.column_name));
      const missing = srcCols.filter((c) => !dstCols.has(c));
      if (missing.length) throw new Error(`Colonnes absentes de PostgreSQL dans ${table} : ${missing.join(', ')}.`);
      const rows = srcCols.length ? await source.all(`SELECT ${srcCols.join(', ')} FROM ${table} ORDER BY rowid`) : [];
      for (const chunk of batches(rows, srcCols)) {
        const values = chunk.map(() => `(${srcCols.map(() => '?').join(', ')})`).join(', ');
        await tx.run(`INSERT INTO ${table} (${srcCols.join(', ')}) VALUES ${values}`,
          ...chunk.flatMap((r) => srcCols.map((c) => r[c])));
      }
      // Les prochains identifiants repartent après les données copiées.
      if (srcCols.includes('id')) {
        await tx.get(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST(COALESCE(MAX(id), 0), 1), MAX(id) IS NOT NULL) FROM ${table}`);
      }
      const n = (await tx.get(`SELECT COUNT(*) AS n FROM ${table}`)).n;
      if (n !== rows.length) throw new Error(`Vérification impossible pour ${table} : ${rows.length} lignes lues, ${n} copiées.`);
      counts[table] = n;
      log(`  ${table.padEnd(16)} ${String(n).padStart(6)} ligne(s)`);
    }
  });

  const blobs = (await source.get("SELECT COUNT(*) AS n FROM products WHERE image_url LIKE '/_blob/%'")).n;
  return { counts, blobPhotos: blobs };
}

async function main() {
  try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { /* pas de fichier .env */ }
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  const replace = args.includes('--remplacer');
  if (!file) throw new Error('Indiquez le fichier SQLite : node scripts/transfer-to-postgres.js chemin/ice-manager.db');
  if (!fs.existsSync(file)) throw new Error(`Fichier introuvable : ${file}`);
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL manquante (variable d’environnement ou fichier .env).');

  // La source est ouverte sur une copie : le fichier d'origine n'est jamais modifié.
  const copy = path.join(require('node:os').tmpdir(), `ice-transfer-${process.pid}.db`);
  fs.copyFileSync(file, copy);
  const source = await openSqlite(copy);
  const { connectPostgres } = require('../server/database');
  const target = connectPostgres(process.env.DATABASE_URL, { max: 1 });
  const host = new URL(process.env.DATABASE_URL).hostname;
  try {
    console.log(`Transfert de ${path.basename(file)} vers PostgreSQL (${host})…`);
    const { counts, blobPhotos } = await transfer(source, target, { replace, log: (m) => console.log(m) });
    const total = Object.values(counts).reduce((a, n) => a + n, 0);
    console.log(`Terminé : ${total} lignes copiées et vérifiées.`);
    if (blobPhotos) {
      console.log(`Attention : ${blobPhotos} photo(s) de produits pointent vers la plateforme claude.ai et ne s’afficheront pas.`
        + ' Utilisez un export qui contient les photos.');
    }
    console.log('Démarrez ensuite l’application avec la même DATABASE_URL : npm start');
  } finally {
    await source.close();
    await target.close();
    for (const f of [copy, `${copy}-wal`, `${copy}-shm`]) fs.rmSync(f, { force: true });
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Transfert impossible :', err.message);
    process.exit(1);
  });
}

module.exports = { transfer, TABLES };
