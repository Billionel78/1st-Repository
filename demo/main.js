'use strict';

// Démarrage de la démo : le code serveur (server/*.js) s'exécute dans le navigateur.
// Les appels fetch('/api/…') de l'interface sont transmis directement à l'application Express
// (version simplifiée), et la base SQLite est sauvegardée dans le stockage local du navigateur.

const { openDatabase, seed } = require('../server/db');
const { createApp } = require('../server/app');
const { seedDemo } = require('./seed-demo');

const DB_KEY = 'ice-manager-demo-db-v1';
const COOKIE_KEY = 'ice-manager-demo-session-v1';

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* stockage indisponible : démo non persistante */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* idem */ } },
};

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  const s = atob(b64);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

function freshDatabase() {
  globalThis.__ICE_DB_BYTES = undefined;
  const db = openDatabase(':memory:');
  seed(db, { adminPassword: 'admin123' });
  seedDemo(db);
  return db;
}

const ready = (async () => {
  globalThis.__SQL = await globalThis.initSqlJs({ wasmBinary: fromBase64(globalThis.__SQL_WASM_B64) });
  let db;
  const saved = storage.get(DB_KEY);
  if (saved) {
    try {
      globalThis.__ICE_DB_BYTES = fromBase64(saved);
      db = openDatabase(':memory:');
    } catch {
      db = null;
    }
  }
  if (!db) db = freshDatabase();
  const app = createApp(db);
  const persist = () => storage.set(DB_KEY, toBase64(db.export()));
  persist();
  return { app, persist };
})();

let cookie = storage.get(COOKIE_KEY) || '';

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    finished: false,
    status(code) { this.statusCode = code; return this; },
    set(key, value) {
      if (typeof key === 'object') Object.assign(this.headers, key);
      else this.headers[key] = value;
      return this;
    },
    json(data) {
      this.headers['Content-Type'] = 'application/json; charset=utf-8';
      return this.send(JSON.stringify(data));
    },
    send(body) { this.body = body; this.finished = true; return this; },
    cookie(name, value) {
      cookie = `${name}=${encodeURIComponent(value)}`;
      storage.set(COOKIE_KEY, cookie);
      return this;
    },
    clearCookie() {
      cookie = '';
      storage.remove(COOKIE_KEY);
      return this;
    },
  };
}

/** Exécute une requête sur l'application Express de la démo. */
async function handle(url, init = {}) {
  const { app, persist } = await ready;
  const u = new URL(url, 'https://demo.local');
  const method = (init.method || 'GET').toUpperCase();
  const res = makeResponse();
  let body;
  try {
    body = init.body ? JSON.parse(init.body) : undefined;
  } catch {
    return new Response(JSON.stringify({ error: 'Requête JSON invalide.' }), { status: 400 });
  }
  const req = {
    method, url, path: u.pathname, query: Object.fromEntries(u.searchParams), params: {}, body,
    headers: { cookie }, ip: '127.0.0.1',
  };
  try {
    app.handle(req, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur interne de la démo.' });
  }
  if (!res.finished) res.status(404).json({ error: 'Ressource introuvable.' });
  if (method !== 'GET' && res.statusCode < 500) persist();
  return new Response(res.body, { status: res.statusCode, headers: res.headers });
}

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  return url.startsWith('/api/') ? handle(url, init) : nativeFetch(input, init);
};

globalThis.__iceDemo = {
  handle,
  reset() {
    storage.remove(DB_KEY);
    storage.remove(COOKIE_KEY);
    location.reload();
  },
};
