'use strict';

// Démarrage de l'application dans le navigateur : le code serveur (server/*.js) s'exécute ici.
// Les appels fetch('/api/…') de l'interface sont transmis à l'application Express (version simplifiée).
//
// Deux modes, choisis à la construction (window.__ICE_MODE) :
//  - « demo »   : données d'exemple, conservées dans le navigateur du visiteur ;
//  - « shared » : la plateforme réelle, base partagée entre tous les appareils via le stockage
//                 de l'artefact (capacité `db`), synchronisée en direct.

const { migrate, seed } = require('../server/db');
const { SqliteDatabase } = require('../server/database');
const { DatabaseSync } = require('./shims/sqlite');
const { createApp } = require('../server/app');
const { hashPassword } = require('../server/security');
const { seedDemo } = require('./seed-demo');
const { createSharedStore, SyncError, gzip, gunzip, toBase64, fromBase64 } = require('./shared-store');

const MODE = globalThis.__ICE_MODE === 'shared' ? 'shared' : 'demo';
const KEYS = MODE === 'shared'
  ? { session: 'ice-manager-session-v1' }
  : { db: 'ice-manager-demo-db-v1', session: 'ice-manager-demo-session-v1' };

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* stockage indisponible */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* idem */ } },
};

const json = (status, data) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

// ---------- Base courante ----------
const current = { raw: null, db: null, app: null, version: 0 };

/** Charge une base (contenu binaire SQLite, ou base vide) et l'application qui la sert. */
async function mount(bytes, version = 0) {
  globalThis.__ICE_DB_BYTES = bytes || undefined;
  const raw = new DatabaseSync();
  globalThis.__ICE_DB_BYTES = undefined;
  raw.exec('PRAGMA foreign_keys = ON;');
  const db = new SqliteDatabase(raw);
  await migrate(db);
  if (current.raw) current.raw.close();
  Object.assign(current, { raw, db, app: createApp(db), version });
}

const totalChanges = () => current.raw.prepare('SELECT total_changes() AS n').get().n;
const exportBytes = () => current.raw.export();

// ---------- Requêtes ----------
let cookie = storage.get(KEYS.session) || '';

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
      storage.set(KEYS.session, cookie);
      return this;
    },
    clearCookie() {
      cookie = '';
      storage.remove(KEYS.session);
      return this;
    },
  };
}

/** Exécute une requête sur l'application locale. */
async function run(method, url, body, extraHeaders = {}) {
  const u = new URL(url, 'https://ice.local');
  const res = makeResponse();
  const req = {
    method, url, path: u.pathname, query: Object.fromEntries(u.searchParams), params: {}, body,
    headers: { ...extraHeaders, cookie }, ip: '127.0.0.1',
  };
  try {
    await current.app.handle(req, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur interne.' });
  }
  if (!res.finished) res.status(404).json({ error: 'Ressource introuvable.' });
  return res;
}

const toResponse = (res) => new Response(res.body, { status: res.statusCode, headers: res.headers });

async function currentUser() {
  const res = await run('GET', '/api/auth/me');
  return res.statusCode === 200 ? JSON.parse(res.body).user : null;
}

/** Vérifie qu'une sauvegarde est une base ICE MANAGER lisible. */
function checkDatabase(bytes) {
  const SQL = globalThis.__SQL;
  const probe = new SQL.Database(bytes);
  try {
    const n = probe.exec('SELECT COUNT(*) FROM users')[0].values[0][0];
    if (!n) throw new Error('vide');
  } finally {
    probe.close();
  }
}

// ---------- Mode démo ----------
async function bootDemo() {
  const saved = storage.get(KEYS.db);
  if (saved) {
    try { await mount(fromBase64(saved)); } catch { current.db = null; }
  }
  if (!current.db) {
    await mount();
    await seed(current.db, { adminPassword: 'admin123' });
    await seedDemo(current.db);
  }
  persistDemo();
  return 'ready';
}
const persistDemo = () => storage.set(KEYS.db, toBase64(exportBytes()));

// ---------- Mode partagé ----------
let shared = null;
let status = 'loading'; // loading | unavailable | setup | ready
let reloading = null;

async function bootShared() {
  const store = globalThis.claude?.use ? await globalThis.claude.use('db') : null;
  if (!store) return 'unavailable';
  shared = createSharedStore(store);
  const snap = await shared.load();
  if (!snap) return 'setup';
  await mount(snap.bytes, snap.version);
  watchRemote();
  return 'ready';
}

function watchRemote() {
  shared.watch((version) => {
    if (version > current.version) refreshFromStore();
  }, () => {});
}

/** Recharge la dernière version publiée (modification faite sur un autre appareil). */
function refreshFromStore() {
  reloading ??= (async () => {
    try {
      const snap = await shared.load();
      if (snap && snap.version > current.version) {
        await mount(snap.bytes, snap.version);
        globalThis.dispatchEvent(new CustomEvent('ice:remote-change'));
      }
    } finally {
      reloading = null;
    }
  })();
  return reloading;
}

// Une seule écriture à la fois dans cet onglet.
let writeQueue = Promise.resolve();
function serialized(fn) {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.catch(() => {});
  return next;
}

/** Applique une modification et la publie pour tous les appareils. */
function sharedWrite(method, url, body, headers) {
  return sharedMutate(async () => toResponse(await run(method, url, body, headers)));
}

/** Exécute `fn` sur la dernière version de la base, puis publie si elle a modifié des données. */
function sharedMutate(fn) {
  return serialized(async () => {
    await shared.acquire();
    try {
      const head = await shared.readHead();
      if ((head?.version ?? 0) !== current.version) {
        const snap = await shared.load();
        await mount(snap.bytes, snap.version);
        globalThis.dispatchEvent(new CustomEvent('ice:remote-change'));
      }
      const before = totalChanges();
      const res = await fn();
      if (totalChanges() !== before) {
        try {
          current.version = await shared.publish(current.version, exportBytes());
        } catch (err) {
          // La modification n'a pas pu être partagée : on revient à la version publiée.
          const snap = await shared.load().catch(() => null);
          if (snap) await mount(snap.bytes, snap.version);
          globalThis.dispatchEvent(new CustomEvent('ice:remote-change'));
          const message = err instanceof SyncError ? err.message
            : err?.code === 'quota_exceeded' ? 'Espace de stockage plein : faites une sauvegarde puis contactez votre administrateur.'
              : 'Enregistrement impossible (connexion ?). Vérifiez le réseau et réessayez.';
          return json(503, { error: message });
        }
      }
      return res;
    } finally {
      shared.release();
    }
  });
}

/** Configuration initiale : crée la base (validation et création par la route du serveur) puis la partage. */
function setup(body) {
  return serialized(async () => {
    await shared.acquire();
    try {
      const existing = await shared.load();
      if (existing) {
        await mount(existing.bytes, existing.version);
        status = 'ready';
        watchRemote();
        return json(409, { error: 'La plateforme a déjà été configurée depuis un autre appareil. Connectez-vous.' });
      }
      await mount();
      const res = await run('POST', '/api/platform/setup', body);
      if (res.statusCode !== 201) return toResponse(res);
      current.version = await shared.publish(0, exportBytes());
      status = 'ready';
      watchRemote();
      return toResponse(res);
    } finally {
      shared.release();
    }
  });
}

// ---------- Sauvegarde / restauration (responsable) ----------
async function backup() {
  const user = await currentUser();
  if (user?.role !== 'admin') return json(403, { error: 'Action réservée au responsable.' });
  const settings = JSON.parse((await run('GET', '/api/settings')).body);
  return json(200, {
    app: 'ICE MANAGER',
    format: 1,
    bar_name: settings.bar_name,
    created_at: new Date().toISOString(),
    data: toBase64(await gzip(exportBytes())),
  });
}

async function restore(body) {
  const user = await currentUser();
  if (user?.role !== 'admin') return json(403, { error: 'Action réservée au responsable.' });
  let bytes;
  try {
    if (body?.app !== 'ICE MANAGER' || body?.format !== 1) throw new Error('format');
    bytes = await gunzip(fromBase64(body.data));
    checkDatabase(bytes);
  } catch {
    return json(400, { error: 'Ce fichier n’est pas une sauvegarde ICE MANAGER valide.' });
  }
  if (MODE === 'demo') {
    await mount(bytes);
    persistDemo();
    return json(200, { ok: true });
  }
  return serialized(async () => {
    await shared.acquire();
    try {
      const head = await shared.readHead();
      const version = await shared.publish(head?.version ?? 0, bytes);
      await mount(bytes, version);
      return json(200, { ok: true });
    } catch (err) {
      return json(503, { error: err instanceof SyncError ? err.message : 'Restauration impossible. Réessayez.' });
    } finally {
      shared.release();
    }
  });
}

// ---------- Mot de passe oublié : le propriétaire du lien peut redéfinir le mot de passe d'un responsable ----------
const viewer = () => (globalThis.claude?.use ? globalThis.claude.use('user') : Promise.resolve(null));
async function isLinkOwner() {
  try { return (await viewer())?.isOwner() ?? false; } catch { return false; }
}

async function ownerReset(body) {
  if (!(await isLinkOwner())) {
    return json(403, { error: 'Réservé au propriétaire de la plateforme (le compte claude.ai qui l’a créée).' });
  }
  const username = String(body?.username ?? '').trim();
  const password = String(body?.new_password ?? '');
  if (password.length < 6) return json(400, { error: 'Le nouveau mot de passe doit contenir au moins 6 caractères.' });
  return sharedMutate(async () => {
    const user = await current.db.get(
      "SELECT id FROM users WHERE lower(username) = lower(?) AND role = 'admin' AND active = 1", username);
    if (!user) return json(404, { error: 'Aucun compte responsable actif ne porte cet identifiant.' });
    await current.db.run('UPDATE users SET password_hash = ?, reset_requested_at = NULL WHERE id = ?', hashPassword(password), user.id);
    await current.db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
    return json(200, { status: 'reset' });
  });
}

// ---------- Export de la base (responsable) : fichier SQLite utilisable ailleurs (Antigravity, Neon…) ----------
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Archive zip sans compression (« stored ») : [{ name, data: Uint8Array }]. */
function zip(files) {
  const enc = new TextEncoder();
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(10, time, true); local.setUint16(12, date, true); local.setUint32(14, crc, true);
    local.setUint32(18, f.data.length, true); local.setUint32(22, f.data.length, true); local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint16(8, 0x0800, true);
    dir.setUint16(12, time, true); dir.setUint16(14, date, true); dir.setUint32(16, crc, true);
    dir.setUint32(20, f.data.length, true); dir.setUint32(24, f.data.length, true); dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const size = central.reduce((a, p) => a + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

const README_EXPORT = `ICE MANAGER — export de la base de données
==========================================

ice-manager.db : toute la base au format SQLite (produits et photos, commandes, paiements, clients,
stock, fournisseurs, approvisionnements, utilisateurs). Les sessions de connexion n'y sont pas.

Utiliser avec la version serveur (Antigravity, Render…) :
  1. Copier ice-manager.db dans le dossier data/ du projet.
  2. SQLite : npm start, puis se connecter avec les identifiants habituels.
     PostgreSQL (Neon) : mettre DATABASE_URL dans le fichier .env, puis
       npm run transfer:postgres -- data/ice-manager.db
       npm start

Ouvrir et consulter : DB Browser for SQLite, DBeaver, TablePlus…
Montants en FCFA entiers ; dates au format AAAA-MM-JJ HH:MM:SS.
`;

async function exportDatabase() {
  const user = await currentUser();
  if (user?.role !== 'admin') return json(403, { error: 'Action réservée au responsable.' });
  if (MODE === 'shared') {
    // Dernière version publiée par tous les appareils.
    await serialized(async () => {
      const head = await shared.readHead();
      if ((head?.version ?? 0) !== current.version) {
        const snap = await shared.load();
        await mount(snap.bytes, snap.version);
      }
    });
  }
  const SQL = globalThis.__SQL;
  const copy = new SQL.Database(exportBytes());
  let missing = 0;
  try {
    copy.run('DELETE FROM sessions');
    // Photos stockées sur la plateforme : réintégrées dans la base pour qu'elle soit autonome.
    const res = copy.exec("SELECT id, image_url FROM products WHERE image_url LIKE '/_blob/%'");
    const rows = res[0]?.values ?? [];
    const done = new Map();
    const at = new Date().toISOString().slice(0, 19).replace('T', ' ');
    for (const [productId, url] of rows) {
      if (!done.has(url)) {
        try {
          const r = await nativeFetch(url);
          if (!r.ok) throw new Error(String(r.status));
          const blob = await r.blob();
          const mime = /^image\/(jpeg|png|webp)$/.test(blob.type) ? blob.type : 'image/webp';
          copy.run('INSERT INTO images (mime, data, created_at) VALUES (?, ?, ?)', [mime, toBase64(new Uint8Array(await blob.arrayBuffer())), at]);
          done.set(url, `/api/images/${copy.exec('SELECT last_insert_rowid()')[0].values[0][0]}`);
        } catch {
          done.set(url, null);
          missing++;
        }
      }
      if (done.get(url)) copy.run('UPDATE products SET image_url = ? WHERE id = ?', [done.get(url), productId]);
    }
    copy.run('VACUUM');
    const bytes = copy.export();
    const settings = Object.fromEntries((copy.exec('SELECT key, value FROM settings')[0]?.values ?? []));
    const blob = zip([
      { name: 'ice-manager.db', data: bytes },
      { name: 'LISEZMOI.txt', data: new TextEncoder().encode(README_EXPORT) },
    ]);
    return new Response(blob, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'X-Ice-Bar': encodeURIComponent(settings.bar_name || 'ICE MANAGER'),
        'X-Ice-Missing-Photos': String(missing),
      },
    });
  } finally {
    copy.close();
  }
}

// ---------- Photos des produits (responsable) ----------
// Elles ne vont pas dans la base : sur la plateforme, elles sont stockées comme fichiers de l'artefact
// (sinon chaque commande renverrait toutes les photos) ; dans la démo, elles restent dans le navigateur.
async function uploadImage(body) {
  const user = await currentUser();
  if (user?.role !== 'admin') return json(403, { error: 'Action réservée au responsable.' });
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body?.data ?? ''));
  if (!m || m[2].length > 1_400_000) return json(400, { error: 'Image invalide ou trop lourde.' });
  if (MODE === 'demo') return json(201, { url: body.data });

  const assets = globalThis.claude?.use ? await globalThis.claude.use('assets') : null;
  if (!assets) {
    return json(403, { error: 'Seuls le propriétaire de la plateforme et ses éditeurs peuvent ajouter des photos.' });
  }
  try {
    const asset = await assets.upload(new Blob([fromBase64(m[2])], { type: m[1] }), { type: m[1] });
    return json(201, { url: `/_blob/${asset.id}` });
  } catch (err) {
    const messages = {
      too_large: 'Image trop lourde.',
      quota_or_state: 'L’espace réservé aux photos est plein : retirez des photos inutilisées.',
      rate_limited: 'Trop d’envois rapprochés : réessayez dans un instant.',
    };
    return json(err?.code === 'too_large' ? 413 : 503, { error: messages[err?.code] || 'Envoi de la photo impossible. Réessayez.' });
  }
}

// ---------- Point d'entrée ----------
const ready = (async () => {
  globalThis.__SQL = await globalThis.initSqlJs({ wasmBinary: fromBase64(globalThis.__SQL_WASM_B64) });
  try {
    status = MODE === 'shared' ? await bootShared() : await bootDemo();
  } catch (err) {
    console.error(err);
    status = 'unavailable';
  }
})();

const UNAVAILABLE = {
  error: 'Les données partagées sont inaccessibles. Ouvrez ce lien sur claude.ai, connecté avec un compte autorisé.',
};

async function handle(url, init = {}) {
  await ready;
  const method = (init.method || 'GET').toUpperCase();
  let body;
  try {
    body = init.body ? JSON.parse(init.body) : undefined;
  } catch {
    return json(400, { error: 'Requête JSON invalide.' });
  }
  const path = new URL(url, 'https://ice.local').pathname;

  if (path === '/api/platform') {
    return json(200, { mode: MODE, status, ...(MODE === 'shared' && status === 'ready' ? { owner: await isLinkOwner() } : {}) });
  }
  if (MODE === 'shared') {
    if (path === '/api/platform/setup' && method === 'POST') {
      return status === 'setup' ? setup(body) : json(409, { error: 'La plateforme est déjà configurée.' });
    }
    if (status !== 'ready') return json(503, UNAVAILABLE);
    if (reloading) await reloading;
    if (path === '/api/platform/owner-reset' && method === 'POST') return ownerReset(body);
  }
  if (path === '/api/platform/backup' && method === 'GET') return backup();
  if (path === '/api/platform/export-db' && method === 'GET') return exportDatabase();
  if (path === '/api/images' && method === 'POST') return uploadImage(body);
  if (path === '/api/platform/restore' && method === 'POST') return restore(body);

  // En-têtes utiles à l'application (date de rattrapage), en minuscules comme dans Express.
  const headers = {};
  for (const [k, v] of Object.entries(init.headers || {})) if (/^x-ice-/i.test(k)) headers[k.toLowerCase()] = v;
  if (MODE === 'shared' && method !== 'GET') return sharedWrite(method, url, body, headers);
  const res = await run(method, url, body, headers);
  if (MODE === 'demo' && method !== 'GET') persistDemo();
  return toResponse(res);
}

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  return url.startsWith('/api/') ? handle(url, init) : nativeFetch(input, init);
};

globalThis.__iceDemo = {
  mode: MODE,
  handle,
  reset() {
    if (MODE !== 'demo') return;
    storage.remove(KEYS.db);
    storage.remove(KEYS.session);
    location.reload();
  },
};
