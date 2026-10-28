'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { BACKENDS } = require('./backends');

for (const backend of BACKENDS) describe(backend.name, () => {
  let server;
  let db;
  let baseUrl;
  let recoveryCode;

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
    assert.match(ok.data.recovery_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    recoveryCode = ok.data.recovery_code;
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

  test('mot de passe oublié : code de secours du responsable, demande d’un serveur', async () => {
    const admin = client();
    // Mauvais code : refusé, sans dire si le compte existe.
    const bad = await admin('POST', '/api/auth/forgot', { username: 'koffi', recovery_code: 'AAAA-BBBB-CCCC', new_password: 'nouveau1' });
    assert.equal(bad.status, 400);
    // Bon code (saisi en minuscules, sans tirets) : nouveau mot de passe et nouveau code.
    const reset = await admin('POST', '/api/auth/forgot', {
      username: 'KOFFI', recovery_code: recoveryCode.toLowerCase().replaceAll('-', ' '), new_password: 'nouveau1',
    });
    assert.equal(reset.status, 200);
    assert.notEqual(reset.data.recovery_code, recoveryCode);
    assert.equal((await admin('POST', '/api/auth/login', { username: 'koffi', password: 'glacier2026' })).status, 401);
    assert.equal((await admin('POST', '/api/auth/login', { username: 'koffi', password: 'nouveau1' })).status, 200);
    // L'ancien code ne sert plus.
    assert.equal((await client()('POST', '/api/auth/forgot', { username: 'koffi', recovery_code: recoveryCode, new_password: 'autre123' })).status, 400);

    // Serveur : demande transmise au responsable (même réponse pour un compte inconnu).
    await admin('POST', '/api/users', { username: 'awa', full_name: 'Awa', role: 'serveur', password: 'serveur1' });
    const anon = client();
    assert.deepEqual((await anon('POST', '/api/auth/forgot', { username: 'awa' })).data, { status: 'requested' });
    assert.deepEqual((await anon('POST', '/api/auth/forgot', { username: 'inconnu' })).data, { status: 'requested' });
    // Un serveur n'a pas de code de secours : le code ne marche pas pour lui.
    assert.equal((await anon('POST', '/api/auth/forgot', { username: 'awa', recovery_code: reset.data.recovery_code, new_password: 'xxxxxx' })).status, 400);
    let awa = (await admin('GET', '/api/users')).data.find((u) => u.username === 'awa');
    assert.ok(awa.reset_requested_at);
    await admin('PUT', `/api/users/${awa.id}`, { password: 'serveur2' });
    awa = (await admin('GET', '/api/users')).data.find((u) => u.username === 'awa');
    assert.equal(awa.reset_requested_at, null);
    assert.equal((await anon('POST', '/api/auth/login', { username: 'awa', password: 'serveur2' })).status, 200);

    // Nouveau code à la demande du responsable (mot de passe exigé) ; réservé au responsable.
    assert.equal((await admin('POST', '/api/auth/recovery-code', { current_password: 'faux' })).status, 400);
    const fresh = await admin('POST', '/api/auth/recovery-code', { current_password: 'nouveau1' });
    assert.match(fresh.data.recovery_code, /^[A-Z2-9-]{14}$/);
    assert.deepEqual((await admin('GET', '/api/auth/recovery-code')).data, { configured: true });
    assert.equal((await anon('GET', '/api/auth/recovery-code')).status, 403);

    // Tentatives répétées : bloquées.
    const spam = client();
    for (let i = 0; i < 5; i++) await spam('POST', '/api/auth/forgot', { username: 'koffi', recovery_code: 'XXXX', new_password: 'abcdef' });
    assert.equal((await spam('POST', '/api/auth/forgot', { username: 'koffi', recovery_code: fresh.data.recovery_code, new_password: 'abcdef' })).status, 429);
  });

  test('base exportée de la plateforme en ligne : mots de passe SHA-256 acceptés puis convertis', async () => {
    const browserHash = require('../demo/shims/security').hashPassword('platef0rme');
    await db.run("INSERT INTO users (username, full_name, role, password_hash, active, created_at) VALUES ('patron', 'Patron', 'admin', ?, 1, '2026-10-28 10:00:00')", browserHash);
    const call = client();
    assert.equal((await call('POST', '/api/auth/login', { username: 'patron', password: 'mauvais' })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { username: 'patron', password: 'platef0rme' })).status, 200);
    const stored = (await db.get("SELECT password_hash FROM users WHERE username = 'patron'")).password_hash;
    assert.match(stored, /^scrypt\$/);
    assert.equal((await client()('POST', '/api/auth/login', { username: 'patron', password: 'platef0rme' })).status, 200);
  });
});
