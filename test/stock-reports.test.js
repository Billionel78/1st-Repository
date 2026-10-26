'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDatabase, seed } = require('../server/db');
const { createApp } = require('../server/app');
const { toCsv } = require('../server/routes/reports');

let server;
let baseUrl;
let cookie = '';

async function call(method, url, body) {
  const res = await fetch(baseUrl + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* CSV */ }
  return { status: res.status, data, headers: res.headers };
}

before(async () => {
  const db = openDatabase(':memory:');
  seed(db, { adminPassword: 'secret123' });
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  await call('POST', '/api/auth/login', { username: 'admin', password: 'secret123' });
});
after(() => server.close());

const product = async (name) => (await call('GET', '/api/products')).data.find((p) => p.name === name);
const table = async (name) => (await call('GET', '/api/tables')).data.find((t) => t.name === name);

test('mouvements de stock : stock initial, entrée, perte, inventaire, vente', async () => {
  const fam = (await call('GET', '/api/families')).data[0];
  const created = await call('POST', '/api/products', {
    family_id: fam.id, name: 'Bière test', price: 1000, cost_price: 600, track_stock: true, stock: 24, alert_threshold: 6,
  });
  assert.equal(created.status, 201);
  assert.equal(created.data.stock, 24);
  const id = created.data.id;

  // Entrée de 12 avec nouveau prix d'achat.
  let r = await call('POST', '/api/stock/movements', { product_id: id, type: 'entree', quantity: 12, unit_cost: 650 });
  assert.equal(r.data.stock, 36);
  assert.equal((await product('Bière test')).cost_price, 650);
  // Perte de 2.
  r = await call('POST', '/api/stock/movements', { product_id: id, type: 'perte', quantity: 2, note: 'Casse' });
  assert.equal(r.data.stock, 34);
  // Inventaire : 30 comptées → écart −4.
  r = await call('POST', '/api/stock/movements', { product_id: id, type: 'inventaire', quantity: 30 });
  assert.deepEqual(r.data, { stock: 30, delta: -4 });
  // Type inconnu refusé ; produit sans suivi refusé.
  assert.equal((await call('POST', '/api/stock/movements', { product_id: id, type: 'vente', quantity: 1 })).status, 400);
  const vox = await product('Vox 66');
  assert.equal((await call('POST', '/api/stock/movements', { product_id: vox.id, type: 'entree', quantity: 1 })).status, 409);

  // Vente : 25 bouteilles sur la table 1, payées.
  const t1 = await table('Table 1');
  const o = (await call('POST', '/api/orders', { table_id: t1.id, product_id: id, quantity: 25 })).data.order;
  let stock = (await call('GET', '/api/stock')).data.find((p) => p.id === id);
  assert.equal(stock.reserved, 25);
  assert.equal(stock.free, 5);
  assert.equal(stock.status, 'alerte');
  const dash = (await call('GET', '/api/dashboard')).data;
  assert.ok(dash.low_stock.some((p) => p.id === id));

  const cash = (await call('GET', '/api/payment-methods')).data.find((m) => m.type === 'cash');
  await call('POST', `/api/orders/${o.id}/payments`, { method_id: cash.id });
  stock = (await call('GET', '/api/stock')).data.find((p) => p.id === id);
  assert.equal(stock.stock, 5);
  assert.equal(stock.reserved, 0);

  const moves = (await call('GET', `/api/stock/movements?product_id=${id}`)).data;
  assert.deepEqual(moves.map((m) => [m.type, m.quantity, m.stock_after]), [
    ['vente', -25, 5], ['inventaire', -4, 30], ['perte', -2, 34], ['entree', 12, 36], ['entree', 24, 24],
  ]);
  assert.equal(moves[0].order_number, o.number);

  // Correction directe depuis la fiche produit → ajustement tracé.
  await call('PUT', `/api/products/${id}`, { stock: 8 });
  const last = (await call('GET', `/api/stock/movements?product_id=${id}&limit=1`)).data[0];
  assert.deepEqual([last.type, last.quantity, last.stock_after], ['ajustement', 3, 8]);
});

test('statistiques financières : coût, marge, encaissements par serveur', async () => {
  const s = (await call('GET', '/api/stats')).data;
  const line = s.products.find((p) => p.product_name === 'Bière test');
  // Prix d'achat figé au moment de la commande (650).
  assert.equal(line.cost, 25 * 650);
  assert.equal(line.margin, 25 * 350);
  assert.equal(s.gross_margin, s.sales_amount - s.cost_of_sales);
  assert.equal(s.by_user[0].name, 'Responsable');
  assert.equal(s.by_user[0].amount, s.collected);
});

test('exports CSV compatibles Excel', async () => {
  const sales = await call('GET', '/api/reports/sales.csv');
  assert.equal(sales.status, 200);
  assert.match(sales.headers.get('content-type'), /text\/csv/);
  assert.match(sales.headers.get('content-disposition'), /attachment; filename="ventes-produits_\d{4}-\d{2}-\d{2}\.csv"/);
  // text() retire le BOM : on vérifie les octets bruts.
  const raw = Buffer.from(await (await fetch(`${baseUrl}/api/reports/sales.csv`, { headers: { Cookie: cookie } })).arrayBuffer());
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(sales.data.startsWith('Produit;Famille;'));
  assert.match(sales.data, /Bière test;Bières;25;25000;16250;8750/);
  for (const url of ['orders', 'payments', 'stock', 'stock-movements']) {
    assert.equal((await call('GET', `/api/reports/${url}.csv`)).status, 200, url);
  }
  assert.equal((await call('GET', '/api/reports/sales.csv?from=2026-02-01&to=2026-01-01')).status, 400);
});

test('échappement CSV et protection contre les formules', () => {
  assert.equal(toCsv(['a', 'b'], [['x;y', '=SUM(A1)'], ['"q"', 12]]),
    '\uFEFFa;b\r\n"x;y";\'=SUM(A1)\r\n"""q""";12\r\n');
});

test('la migration de la base est idempotente', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ice-')), 'test.db');
  openDatabase(file).close();
  const db = openDatabase(file);
  const cols = db.prepare('PRAGMA table_info(products)').all().map((c) => c.name);
  assert.ok(cols.includes('cost_price') && cols.includes('alert_threshold'));
  db.close();
});
