'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openSqlite, seed } = require('../server/db');
const { createApp } = require('../server/app');
const { BACKENDS } = require('./backends');
const { transfer, TABLES } = require('../scripts/transfer-to-postgres');

/** Démarre l'application sur une base et renvoie un client HTTP connecté. */
async function startApp(db, username, password) {
  const server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  assert.equal((await call('POST', '/api/auth/login', { username, password })).status, 200);
  return { call, close: () => server.close() };
}

for (const backend of BACKENDS.filter((b) => b.name.startsWith('PostgreSQL'))) describe(`Transfert SQLite → ${backend.name}`, () => {
  let source;
  let target;
  let before_;

  before(async () => {
    // Base SQLite avec de l'activité : vente payée, client, fournisseur, approvisionnement, photo.
    source = await openSqlite(':memory:');
    await seed(source, { adminPassword: 'secret123' });
    const app = await startApp(source, 'admin', 'secret123');
    const { call } = app;
    const product = (await call('GET', '/api/products')).data[0];
    const table = (await call('GET', '/api/tables')).data[0];
    const customer = (await call('POST', '/api/customers', { name: 'Koffi', table_id: table.id })).data;
    const { order } = (await call('POST', '/api/orders', { table_id: table.id, product_id: product.id, quantity: 3, customer_id: customer.id })).data;
    const method = (await call('GET', '/api/payment-methods')).data[0];
    await call('POST', `/api/orders/${order.id}/payments`, { method_id: method.id, amount: order.total });
    const supplier = (await call('POST', '/api/suppliers', { name: 'Solibra' })).data;
    await call('POST', '/api/purchases', { supplier_id: supplier.id, paid_amount: 'all', items: [{ product_id: product.id, packs: 2, pack_size: 12, pack_price: 6000 }] });
    const img = (await call('POST', '/api/images', { data: 'data:image/png;base64,iVBORw0KGgo=' })).data;
    await call('PUT', `/api/products/${product.id}`, { image_url: img.url });
    before_ = {
      stats: (await call('GET', '/api/stats')).data,
      products: (await call('GET', '/api/products')).data,
      orders: (await call('GET', '/api/orders?status=paid')).data,
    };
    app.close();
    target = await backend.open();
  });
  after(async () => {
    await source.close();
    await target.close();
  });

  test('copie complète, vérifiée, puis l’application fonctionne sur PostgreSQL', async () => {
    const { counts, blobPhotos } = await transfer(source, target);
    assert.equal(blobPhotos, 0);
    for (const t of TABLES) {
      assert.equal(counts[t], (await source.get(`SELECT COUNT(*) AS n FROM ${t}`)).n, t);
    }
    assert.ok(counts.orders >= 1 && counts.payments >= 1 && counts.customers === 1 && counts.purchases === 1 && counts.images === 1);
    assert.ok(before_.orders.length === 1 && before_.stats.collected > 0, JSON.stringify(before_.stats).slice(0, 200));

    const app = await startApp(target, 'admin', 'secret123');
    const { call } = app;
    assert.deepEqual((await call('GET', '/api/stats')).data, before_.stats);
    assert.deepEqual((await call('GET', '/api/products')).data, before_.products);
    assert.deepEqual((await call('GET', '/api/orders?status=paid')).data, before_.orders);
    const photo = before_.products.find((p) => p.image_url);
    const res = await call('GET', photo.image_url);
    assert.equal(res.status, 200);

    // Les identifiants continuent après les données copiées (pas de conflit à l'insertion).
    const supplier = (await call('POST', '/api/suppliers', { name: 'Grossiste' })).data;
    assert.ok(supplier.id > 1);
    const table = (await call('GET', '/api/tables')).data[1];
    const order = await call('POST', '/api/orders', { table_id: table.id, product_id: before_.products[1].id, quantity: 1 });
    assert.equal(order.status, 201);
    app.close();
  });

  test('refuse une base de destination déjà remplie, sauf avec --remplacer', async () => {
    await assert.rejects(transfer(source, target), /contient déjà des données/);
    const { counts } = await transfer(source, target, { replace: true });
    assert.equal(counts.suppliers, 1); // le fournisseur ajouté après le premier transfert a été remplacé
  });
});
