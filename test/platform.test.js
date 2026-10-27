'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { BACKENDS } = require('./backends');

for (const backend of BACKENDS) describe(backend.name, () => {
  let server;
  let db;
  let baseUrl;

  function client() {
    let cookie = '';
    return async (method, url, body) => {
      const res = await fetch(baseUrl + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return { status: res.status, data: await res.json() };
    };
  }

  before(async () => {
    db = await backend.open(); // base vide : aucun utilisateur
    server = createApp(db).listen(0);
    await new Promise((r) => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.close();
    await db.close();
  });

  test('première ouverture : configuration de l’établissement', async () => {
    const call = client();
    assert.deepEqual((await call('GET', '/api/platform')).data, { mode: 'server', status: 'setup' });
    assert.equal((await call('POST', '/api/auth/login', { username: 'admin', password: 'admin123' })).status, 401);
    const bad = await call('POST', '/api/platform/setup', { bar_name: 'Le Glacier', full_name: 'Koffi', username: 'k o', password: 'abcdef' });
    assert.equal(bad.status, 400);
    const ok = await call('POST', '/api/platform/setup', {
      bar_name: 'Bar Le Glacier', full_name: 'Koffi Mensah', username: 'Koffi', password: 'glacier2026',
    });
    assert.equal(ok.status, 201);
    assert.equal((await call('POST', '/api/platform/setup', {
      bar_name: 'Autre', full_name: 'Intrus', username: 'intrus', password: 'abcdefgh',
    })).status, 409);
    assert.equal((await call('GET', '/api/platform')).data.status, 'ready');
    // Identifiant insensible à la casse.
    const login = await call('POST', '/api/auth/login', { username: 'koffi', password: 'glacier2026' });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.role, 'admin');
    const me = await call('GET', '/api/auth/me');
    assert.equal(me.data.settings.bar_name, 'Bar Le Glacier');
    assert.equal((await call('GET', '/api/tables')).data.length, 8);
  });

  test('commandes simultanées depuis plusieurs appareils : rien n’est perdu', async () => {
    const devices = [client(), client(), client()];
    for (const d of devices) await d('POST', '/api/auth/login', { username: 'koffi', password: 'glacier2026' });
    const tables = (await devices[0]('GET', '/api/tables')).data;
    const product = (await devices[0]('GET', '/api/products')).data[0];
    // 12 saisies en parallèle : 4 tables × 3 appareils.
    const results = await Promise.all(devices.flatMap((d) => tables.slice(0, 4).map((t) =>
      d('POST', '/api/orders', { table_id: t.id, product_id: product.id, quantity: 2 }))));
    assert.ok(results.every((r) => r.status === 200 || r.status === 201), results.map((r) => r.status).join(','));
    assert.equal(results.filter((r) => r.status === 201).length, 4); // une commande créée par table
    const open = (await devices[0]('GET', '/api/orders?status=open')).data;
    assert.equal(open.length, 4);
    assert.equal(new Set(open.map((o) => o.number)).size, 4);
    for (const o of open) {
      assert.equal(o.items[0].quantity, 6);
      assert.equal(o.total, 6 * product.price);
    }
  });
});
