'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { seed } = require('../server/db');
const { BACKENDS } = require('./backends');
const { createApp } = require('../server/app');

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
      const text = await res.text();
      let data = text;
      try { data = JSON.parse(text); } catch { /* CSV */ }
      return { status: res.status, data };
    };
  }
  let call;

  before(async () => {
    db = await backend.open();
    await seed(db, { adminPassword: 'secret123' });
    server = createApp(db).listen(0);
    await new Promise((r) => server.once('listening', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    call = client();
    await call('POST', '/api/auth/login', { username: 'admin', password: 'secret123' });
  });
  after(async () => {
    server.close();
    await db.close();
  });

  const newProduct = async (name, extra = {}) => {
    const fam = (await call('GET', '/api/families')).data[0];
    return (await call('POST', '/api/products', { family_id: fam.id, name, price: 1000, track_stock: true, stock: 10, ...extra })).data;
  };

  test('fournisseurs : fiche, catalogue de prix et comparaison', async () => {
    const bad = await call('POST', '/api/suppliers', { name: '' });
    assert.equal(bad.status, 400);
    const solibra = (await call('POST', '/api/suppliers', { name: 'Solibra', phone: '0700000000', contact: 'M. Yao' })).data;
    assert.equal(solibra.name, 'Solibra');
    assert.equal((await call('POST', '/api/suppliers', { name: 'solibra' })).status, 409);
    const grossiste = (await call('POST', '/api/suppliers', { name: 'Grossiste Adjamé' })).data;

    const beer = await newProduct('Bière catalogue');
    // Casier de 12 à 6 000 chez Solibra, carton de 24 à 11 400 chez le grossiste.
    const r = await call('PUT', `/api/suppliers/${solibra.id}/prices/${beer.id}`, { pack_size: 12, pack_price: 6000 });
    assert.equal(r.status, 200);
    assert.equal(r.data.unit_cost, 500);
    await call('PUT', `/api/suppliers/${grossiste.id}/prices/${beer.id}`, { pack_size: 24, pack_price: 11400 });
    // Mise à jour du prix (pas de doublon).
    await call('PUT', `/api/suppliers/${solibra.id}/prices/${beer.id}`, { pack_size: 12, pack_price: 6120 });

    const detail = (await call('GET', `/api/suppliers/${solibra.id}`)).data;
    assert.equal(detail.prices.length, 1);
    assert.equal(detail.prices[0].pack_price, 6120);
    assert.equal(detail.prices[0].unit_cost, 510);
    assert.equal(detail.products_count, 1);

    const compare = (await call('GET', `/api/supplier-prices?product_id=${beer.id}`)).data;
    assert.deepEqual(compare.map((c) => [c.supplier_name, c.unit_cost]), [['Grossiste Adjamé', 475], ['Solibra', 510]]);

    assert.equal((await call('DELETE', `/api/suppliers/${grossiste.id}/prices/${beer.id}`)).status, 200);
    assert.equal((await call('GET', `/api/supplier-prices?product_id=${beer.id}`)).data.length, 1);

    // Réservé au responsable.
    await call('POST', '/api/users', { username: 'awa', full_name: 'Awa', role: 'serveur', password: 'serveur1' });
    const waiter = client();
    await waiter('POST', '/api/auth/login', { username: 'awa', password: 'serveur1' });
    assert.equal((await waiter('GET', '/api/suppliers')).status, 403);
    assert.equal((await waiter('POST', '/api/purchases', { supplier_id: solibra.id, items: [] })).status, 403);
  });

  test('approvisionnement : entrée en stock, prix d’achat, règlement, annulation', async () => {
    const supplier = (await call('POST', '/api/suppliers', { name: 'Brasserie Test' })).data;
    const beer = await newProduct('Bière appro', { stock: 5 });
    const water = await newProduct('Eau appro', { stock: 0 });
    const peanuts = await newProduct('Arachides appro', { track_stock: false, stock: 0 });
    await call('PUT', `/api/suppliers/${supplier.id}/prices/${beer.id}`, { pack_size: 12, pack_price: 6000 });

    // Ligne sans prix et hors catalogue : refusée.
    const missing = await call('POST', '/api/purchases', { supplier_id: supplier.id, items: [{ product_id: water.id, packs: 1 }] });
    assert.equal(missing.status, 400);
    const dup = await call('POST', '/api/purchases', {
      supplier_id: supplier.id, items: [{ product_id: beer.id, packs: 1 }, { product_id: beer.id, packs: 2 }],
    });
    assert.equal(dup.status, 400);

    const created = await call('POST', '/api/purchases', {
      supplier_id: supplier.id,
      paid_amount: 10000,
      note: 'Livraison du matin',
      items: [
        { product_id: beer.id, packs: 3 }, // prix du catalogue : 3 casiers de 12 à 6 000
        { product_id: water.id, packs: 2, pack_size: 6, pack_price: 1800 }, // pack de 6 à 1 800
        { product_id: peanuts.id, packs: 10, pack_price: 150 }, // stock non suivi
      ],
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const p = created.data;
    assert.match(p.number, /^ACH-\d{8}-0001$/);
    assert.equal(p.total, 3 * 6000 + 2 * 1800 + 10 * 150);
    assert.equal(p.paid_amount, 10000);
    assert.equal(p.remaining, p.total - 10000);
    assert.equal(p.items.length, 3);

    const products = (await call('GET', '/api/products')).data;
    const get = (id) => products.find((x) => x.id === id);
    assert.equal(get(beer.id).stock, 5 + 36);
    assert.equal(get(beer.id).cost_price, 500);
    assert.equal(get(water.id).stock, 12);
    assert.equal(get(water.id).cost_price, 300);
    assert.equal(get(peanuts.id).stock, 0);
    assert.equal(get(peanuts.id).cost_price, 150);

    // Le catalogue garde le dernier prix payé.
    const cat = (await call('GET', `/api/suppliers/${supplier.id}`)).data;
    assert.equal(cat.prices.length, 3);
    assert.equal(cat.total_purchased, p.total);
    assert.equal(cat.balance_due, p.total - 10000);

    const moves = (await call('GET', `/api/stock/movements?product_id=${beer.id}`)).data;
    assert.equal(moves[0].quantity, 36);
    assert.match(moves[0].note, /Appro\. ACH-/);

    // Règlement du solde.
    assert.equal((await call('POST', `/api/purchases/${p.id}/payments`, { amount: p.remaining + 1 })).status, 400);
    const paid = await call('POST', `/api/purchases/${p.id}/payments`, { amount: p.remaining });
    assert.equal(paid.data.remaining, 0);
    assert.equal((await call('GET', '/api/purchases?unpaid=1')).data.length, 0);

    // Annulation : les quantités ressortent du stock.
    assert.equal((await call('POST', `/api/purchases/${p.id}/cancel`, {})).status, 400);
    const cancelled = await call('POST', `/api/purchases/${p.id}/cancel`, { reason: 'Erreur de saisie' });
    assert.equal(cancelled.data.status, 'cancelled');
    const after = (await call('GET', '/api/products')).data;
    assert.equal(after.find((x) => x.id === beer.id).stock, 5);
    assert.equal(after.find((x) => x.id === water.id).stock, 0);
    assert.equal((await call('POST', `/api/purchases/${p.id}/cancel`, { reason: 'x' })).status, 409);
    assert.equal((await call('GET', `/api/suppliers/${supplier.id}`)).data.total_purchased, 0);

    // Numérotation et filtre par fournisseur, export CSV.
    const second = await call('POST', '/api/purchases', { supplier_id: supplier.id, paid_amount: 'all', items: [{ product_id: beer.id, packs: 1 }] });
    assert.match(second.data.number, /-0002$/);
    assert.equal(second.data.remaining, 0);
    assert.equal((await call('GET', `/api/purchases?supplier_id=${supplier.id}`)).data.length, 2);
    const csv = await call('GET', '/api/reports/purchases.csv');
    assert.equal(csv.status, 200);
    assert.match(csv.data, /Brasserie Test/);

    // Archivage : la fiche disparaît, l'historique reste.
    assert.equal((await call('DELETE', `/api/suppliers/${supplier.id}`)).status, 200);
    assert.ok(!(await call('GET', '/api/suppliers')).data.some((s) => s.id === supplier.id));
    assert.equal((await call('GET', `/api/purchases/${second.data.id}`)).data.supplier_name, 'Brasserie Test');
  });
});
