'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed } = require('../server/db');
const { BACKENDS } = require('./backends');
const { createApp } = require('../server/app');
const { todayLocal } = require('../server/time');

for (const backend of BACKENDS) describe(backend.name, () => {
  let server;
  let db;
  let baseUrl;

  function client() {
    let cookie = '';
    return async function call(method, url, body, headers = {}) {
      const res = await fetch(baseUrl + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const type = res.headers.get('content-type') || '';
      const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
      return { status: res.status, data, type };
    };
  }

  const admin = client();
  const waiter = client();

  before(async () => {
    db = await backend.open();
    await seed(db, { adminPassword: 'secret123' });
    server = createApp(db).listen(0);
    await new Promise((r) => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server.close();
    await db.close();
  });

  const product = async (name) => (await admin('GET', '/api/products')).data.find((p) => p.name === name);
  const table = async (name) => (await admin('GET', '/api/tables')).data.find((t) => t.name === name);

  test('refuse les accès sans connexion et les mauvais identifiants', async () => {
    assert.equal((await admin('GET', '/api/families')).status, 401);
    assert.equal((await admin('POST', '/api/auth/login', { username: 'admin', password: 'nope' })).status, 401);
    const ok = await admin('POST', '/api/auth/login', { username: 'admin', password: 'secret123' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.user.role, 'admin');
  });

  test('le responsable crée un serveur, qui ne peut pas gérer le catalogue', async () => {
    const created = await admin('POST', '/api/users', {
      username: 'awa', full_name: 'Awa', role: 'serveur', password: 'serveur1',
    });
    assert.equal(created.status, 201);
    assert.equal((await waiter('POST', '/api/auth/login', { username: 'awa', password: 'serveur1' })).status, 200);
    assert.equal((await waiter('POST', '/api/families', { name: 'X' })).status, 403);
    assert.equal((await waiter('GET', '/api/stats')).status, 403);
    assert.equal((await waiter('GET', '/api/families')).status, 200);
  });

  test('gestion des familles et produits', async () => {
    const fam = await admin('POST', '/api/families', { name: 'Cocktails', color: '#123456', icon: '🍸' });
    assert.equal(fam.status, 201);
    assert.equal((await admin('POST', '/api/families', { name: 'cocktails' })).status, 409);
    const p = await admin('POST', '/api/products', { family_id: fam.data.id, name: 'Mojito', price: 2500 });
    assert.equal(p.status, 201);
    assert.equal(p.data.price, 2500);
    assert.equal((await admin('POST', '/api/products', { family_id: fam.data.id, name: 'Bad', price: 12.5 })).status, 400);
    assert.equal((await admin('DELETE', `/api/families/${fam.data.id}`)).status, 409);
    const upd = await admin('PUT', `/api/products/${p.data.id}`, { price: 3000 });
    assert.equal(upd.data.price, 3000);
    const list = await admin('GET', `/api/products?family_id=${fam.data.id}`);
    assert.deepEqual(list.data.map((x) => x.name), ['Mojito']);
  });

  test('cycle complet : commande, ajout, paiement partiel puis total, statistiques', async () => {
    const castle = await product('Castle Beer');
    const vox = await product('Vox 66');
    const t2 = await table('Table 2');

    // Étapes 1 à 5 : Castle Beer x5 sur la Table 2.
    const first = await waiter('POST', '/api/orders', { table_id: t2.id, product_id: castle.id, quantity: 5 });
    assert.equal(first.status, 201);
    assert.equal(first.data.created, true);
    const order = first.data.order;
    assert.equal(order.status, 'open');
    assert.equal(order.total, 5 * castle.price);
    assert.match(order.number, /^CMD-\d{8}-0001$/);

    // Nouvelle commande sur la même table : ajoutée à la commande ouverte.
    const second = await waiter('POST', '/api/orders', {
      table_id: t2.id, items: [{ product_id: castle.id, quantity: 2 }, { product_id: vox.id, quantity: 3 }],
    });
    assert.equal(second.status, 200);
    assert.equal(second.data.order.id, order.id);
    const castleLine = second.data.order.items.find((i) => i.product_id === castle.id);
    assert.equal(castleLine.quantity, 7);
    const total = 7 * castle.price + 3 * vox.price;
    assert.equal(second.data.order.total, total);

    // La table apparaît occupée.
    assert.equal((await table('Table 2')).order_id, order.id);

    // Paiement partiel en Mobile Money.
    const methods = (await waiter('GET', '/api/payment-methods')).data;
    const cash = methods.find((m) => m.type === 'cash');
    const orange = methods.find((m) => m.name === 'Orange Money');
    const p1 = await waiter('POST', `/api/orders/${order.id}/payments`, { method_id: orange.id, amount: 3000, reference: 'OM123' });
    assert.equal(p1.status, 201);
    assert.equal(p1.data.fully_paid, false);
    assert.equal(p1.data.order.status, 'open');
    assert.equal(p1.data.order.remaining, total - 3000);

    // Pas encore comptée comme vente : aucun produit vendu.
    let stats = (await admin('GET', '/api/stats')).data;
    assert.equal(stats.orders_paid, 0);
    assert.equal(stats.products.length, 0);
    assert.equal(stats.collected, 3000);

    // On ne peut pas payer plus que le reste.
    assert.equal((await waiter('POST', `/api/orders/${order.id}/payments`, { method_id: cash.id, amount: total })).status, 400);
    // Le montant reçu en espèces doit couvrir le montant.
    assert.equal((await waiter('POST', `/api/orders/${order.id}/payments`, {
      method_id: cash.id, received_amount: 100,
    })).status, 400);

    // Solde en espèces avec rendu de monnaie.
    const remaining = total - 3000;
    const p2 = await waiter('POST', `/api/orders/${order.id}/payments`, { method_id: cash.id, received_amount: remaining + 500 });
    assert.equal(p2.data.fully_paid, true);
    assert.equal(p2.data.change, 500);
    assert.equal(p2.data.order.status, 'paid');
    assert.ok(p2.data.order.closed_at);

    // Commande clôturée : plus de modification possible, table libérée.
    assert.equal((await waiter('POST', `/api/orders/${order.id}/items`, { product_id: vox.id, quantity: 1 })).status, 409);
    assert.equal((await table('Table 2')).order_id, null);

    stats = (await admin('GET', `/api/stats?date=${todayLocal()}`)).data;
    assert.equal(stats.collected, total);
    assert.equal(stats.by_type.cash, remaining);
    assert.equal(stats.by_type.mobile_money, 3000);
    assert.equal(stats.orders_paid, 1);
    assert.equal(stats.sales_amount, total);
    assert.deepEqual(stats.top_products.map((p) => [p.product_name, p.quantity]), [['Castle Beer', 7], ['Vox 66', 3]]);

    const history = (await waiter('GET', `/api/orders?date=${todayLocal()}`)).data;
    assert.equal(history[0].id, order.id);
    assert.equal(history[0].payment_methods.length, 2);
  });

  test('suivi du stock : réservation, blocage et déduction au paiement', async () => {
    const fanta = await product('Fanta');
    await admin('PUT', `/api/products/${fanta.id}`, { track_stock: true, stock: 4 });
    const t3 = await table('Table 3');
    const t4 = await table('Table 4');
    const o = await waiter('POST', '/api/orders', { table_id: t3.id, product_id: fanta.id, quantity: 3 });
    assert.equal(o.status, 201);
    const refused = await waiter('POST', '/api/orders', { table_id: t4.id, product_id: fanta.id, quantity: 2 });
    assert.equal(refused.status, 409);
    assert.match(refused.data.error, /Stock insuffisant/);
    // L'échec ne doit pas laisser de commande vide sur la table 4.
    assert.equal((await table('Table 4')).order_id, null);

    const cash = (await waiter('GET', '/api/payment-methods')).data.find((m) => m.type === 'cash');
    await waiter('POST', `/api/orders/${o.data.order.id}/payments`, { method_id: cash.id });
    const after = await product('Fanta');
    assert.equal(after.stock, 1);
    assert.equal(after.reserved, 0);
  });

  test('corrections, transfert et annulation', async () => {
    const flag = await product('Flag');
    const t5 = await table('Table 5');
    const t6 = await table('Table 6');
    const { data } = await waiter('POST', '/api/orders', { table_id: t5.id, product_id: flag.id, quantity: 4 });
    const order = data.order;
    const item = order.items[0];
    const fixed = await waiter('PATCH', `/api/orders/${order.id}/items/${item.id}`, { quantity: 2 });
    assert.equal(fixed.data.total, 2 * flag.price);

    const moved = await waiter('POST', `/api/orders/${order.id}/transfer`, { table_id: t6.id });
    assert.equal(moved.data.table_name, 'Table 6');

    assert.equal((await waiter('POST', `/api/orders/${order.id}/cancel`, {})).status, 403);
    const cancelled = await admin('POST', `/api/orders/${order.id}/cancel`, { reason: 'Erreur de saisie' });
    assert.equal(cancelled.data.status, 'cancelled');
    assert.equal((await table('Table 6')).order_id, null);
  });

  test('le changement de prix ne modifie pas une commande existante', async () => {
    const guinness = await product('Guinness');
    const t7 = await table('Table 7');
    const { data } = await waiter('POST', '/api/orders', { table_id: t7.id, product_id: guinness.id, quantity: 1 });
    await admin('PUT', `/api/products/${guinness.id}`, { price: guinness.price + 300 });
    const again = await waiter('POST', `/api/orders/${data.order.id}/items`, { product_id: guinness.id, quantity: 1 });
    assert.equal(again.data.items.length, 2);
    assert.equal(again.data.total, guinness.price * 2 + 300);
  });

  test('il reste toujours au moins un responsable actif', async () => {
    const me = (await admin('GET', '/api/auth/me')).data.user;
    const res = await admin('PUT', `/api/users/${me.id}`, { role: 'serveur' });
    assert.equal(res.status, 409);
  });

  test('photos et format des produits', async () => {
    // PNG 1×1 pixel.
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    assert.equal((await waiter('POST', '/api/images', { data: `data:image/png;base64,${png}` })).status, 403);
    assert.equal((await admin('POST', '/api/images', { data: 'data:text/html;base64,PGI+' })).status, 400);
    const up = await admin('POST', '/api/images', { data: `data:image/png;base64,${png}` });
    assert.equal(up.status, 201);
    assert.match(up.data.url, /^\/api\/images\/\d+$/);
    const img = await waiter('GET', up.data.url);
    assert.equal(img.status, 200);
    assert.equal(img.type, 'image/png');
    assert.equal(img.data.toString('base64'), png);

    const fam = (await admin('GET', '/api/families')).data[0];
    const a = (await admin('POST', '/api/products', {
      family_id: fam.id, name: 'Beaufort 50cl', format: '50 cl', price: 700, image_url: up.data.url,
    })).data;
    assert.equal(a.format, '50 cl');
    assert.equal(a.image_url, up.data.url);
    assert.equal((await admin('POST', '/api/products', { family_id: fam.id, name: 'X', price: 1, image_url: 'https://exemple.com/a.png' })).status, 400);
    // Copie (bouton Dupliquer) : même photo.
    const b = (await admin('POST', '/api/products', { family_id: fam.id, name: 'Beaufort 65cl', price: 900, image_url: up.data.url })).data;
    // Nouvelle photo sur A : l'ancienne est conservée car B l'utilise encore.
    const up2 = (await admin('POST', '/api/images', { data: `data:image/png;base64,${png}` })).data;
    await admin('PUT', `/api/products/${a.id}`, { image_url: up2.url, format: '' });
    const a2 = (await admin('GET', '/api/products')).data.find((p) => p.id === a.id);
    assert.equal(a2.image_url, up2.url);
    assert.equal(a2.format, null);
    assert.equal((await admin('GET', up.data.url)).status, 200);
    // Photo retirée de B : plus personne ne l'utilise, elle est supprimée.
    await admin('PUT', `/api/products/${b.id}`, { image_url: null });
    assert.equal((await admin('GET', up.data.url)).status, 404);
    assert.equal((await admin('GET', up2.url)).status, 200);
  });

  test('rattrapage : ventes enregistrées à une date passée', async () => {
    const day = (offset) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const past = day(-3);
    const back = { 'X-Ice-Date': past };
    const vox = await product('Vox 66');
    const t1 = await table('Table 1');
    const t8 = await table('Table 8');
    const cash = (await admin('GET', '/api/payment-methods')).data.find((m) => m.type === 'cash');

    // Garde-fous : date future ou du jour refusée ; un serveur ne peut pas antidater.
    assert.equal((await admin('GET', '/api/dashboard', undefined, { 'X-Ice-Date': day(1) })).status, 400);
    assert.equal((await admin('GET', '/api/dashboard', undefined, { 'X-Ice-Date': day(0) })).status, 400);
    const w = await waiter('POST', '/api/orders', { table_id: t8.id, product_id: vox.id, quantity: 1 }, back);
    assert.equal(w.status, 201);
    assert.equal(w.data.order.created_at.slice(0, 10), day(0)); // ignoré pour un serveur : date du jour
    await admin('POST', `/api/orders/${w.data.order.id}/cancel`, {});

    // Une commande d'aujourd'hui sur la table 1 ; le rattrapage ne doit pas s'y mêler.
    const today = await admin('POST', '/api/orders', { table_id: t1.id, product_id: vox.id, quantity: 1 });
    assert.equal((await admin('POST', '/api/orders', { table_id: t1.id, product_id: vox.id, quantity: 2 }, back)).status, 409);
    assert.equal((await admin('POST', `/api/orders/${today.data.order.id}/payments`, { method_id: cash.id }, back)).status, 409);

    // Vente passée complète : commande + ajout + paiement, tout au jour rattrapé.
    const o = await admin('POST', '/api/orders', { table_id: t8.id, product_id: vox.id, quantity: 4 }, back);
    assert.equal(o.status, 201);
    assert.equal(o.data.order.created_at.slice(0, 10), past);
    assert.match(o.data.order.number, new RegExp(`^CMD-${past.replaceAll('-', '')}-\\d{4}$`));
    await admin('POST', '/api/orders', { table_id: t8.id, product_id: vox.id, quantity: 1 }, back);
    const paid = await admin('POST', `/api/orders/${o.data.order.id}/payments`, { method_id: cash.id }, back);
    assert.equal(paid.data.order.status, 'paid');
    assert.equal(paid.data.order.closed_at.slice(0, 10), past);
    assert.equal(paid.data.order.payments[0].created_at.slice(0, 10), past);

    const stats = (await admin('GET', `/api/stats?date=${past}`)).data;
    assert.equal(stats.orders_paid, 1);
    assert.equal(stats.collected, 5 * vox.price);
    assert.deepEqual(stats.products.map((x) => [x.product_name, x.quantity]), [['Vox 66', 5]]);
    const dash = (await admin('GET', '/api/dashboard', undefined, back)).data;
    assert.equal(dash.date, past);
    assert.equal(dash.collected, 5 * vox.price);
    const history = (await admin('GET', `/api/orders?date=${past}`)).data;
    assert.deepEqual(history.map((x) => x.id), [o.data.order.id]);
    // Aujourd'hui n'est pas touché.
    assert.ok(!(await admin('GET', '/api/orders?status=paid')).data.some((x) => x.id === o.data.order.id && x.closed_at.startsWith(day(0))));
    await admin('POST', `/api/orders/${today.data.order.id}/cancel`, {});
  });
});
