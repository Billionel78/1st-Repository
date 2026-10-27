'use strict';

// Synchronisation de la base SQLite dans le stockage partagé de l'artefact (capacité `db`).
//
// La base est stockée compressée (gzip, base64) et découpée en documents :
//   snapshots/head        { version, chunks, size, updatedAt }
//   snapshots/v<N>-<i>    { data }      morceaux de la version N
//   snapshots/lock        bail (lease) d'écriture : un seul appareil écrit à la fois
// Chaque modification : prendre le bail → recharger si une autre version est parue → appliquer
// → publier la version N+1 (morceaux d'abord, puis l'en-tête) → supprimer les morceaux de N.

const CHUNK_CHARS = 190_000; // < 256 Kio par document
const LEASE_MS = 8000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
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

class SyncError extends Error {}

function createSharedStore(store) {
  const holder = `tab-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const head = store.doc('snapshots/head');
  const lock = store.doc('snapshots/lock');
  const chunk = (version, i) => store.doc(`snapshots/v${version}-${i}`);

  async function retry(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err?.code !== 'unavailable') throw err;
      await sleep(300 + Math.random() * 500);
      return fn();
    }
  }

  async function readHead() {
    const snap = await retry(() => head.get());
    return snap.exists ? snap.data() : null;
  }

  /** Télécharge et décompresse une version ; `null` si elle a été remplacée entre-temps. */
  async function download(h) {
    const parts = [];
    for (let i = 0; i < h.chunks; i++) {
      const snap = await retry(() => chunk(h.version, i).get());
      if (!snap.exists) return null;
      parts.push(snap.data().data);
    }
    return gunzip(fromBase64(parts.join('')));
  }

  /** Dernière version publiée : { version, bytes } ou null si la base n'existe pas encore. */
  async function load() {
    for (let attempt = 0; attempt < 5; attempt++) {
      const h = await readHead();
      if (!h) return null;
      const bytes = await download(h);
      if (bytes) return { version: h.version, bytes };
    }
    throw new SyncError('Impossible de charger les données partagées. Rechargez la page.');
  }

  async function acquire(ttlMs = LEASE_MS) {
    const deadline = Date.now() + 25_000;
    for (;;) {
      const r = await retry(() => lock.acquire({ holder, ttlMs }));
      if (r.acquired) return;
      if (Date.now() > deadline) throw new SyncError('Un autre appareil enregistre en ce moment. Réessayez dans un instant.');
      await sleep(250 + Math.random() * 400);
    }
  }

  /** Publie `bytes` comme version baseVersion + 1, en gardant le bail. */
  async function publish(baseVersion, bytes) {
    const encoded = toBase64(await gzip(bytes));
    const version = baseVersion + 1;
    const count = Math.max(1, Math.ceil(encoded.length / CHUNK_CHARS));
    for (let i = 0; i < count; i++) {
      await retry(() => chunk(version, i).set({ data: encoded.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) }));
    }
    // Avant de basculer l'en-tête : toujours détenteur du bail et aucune autre version parue.
    await acquire();
    const current = await readHead();
    if ((current?.version ?? 0) !== baseVersion) {
      throw new SyncError('Les données ont été modifiées sur un autre appareil. Réessayez.');
    }
    await retry(() => head.set({ version, chunks: count, size: encoded.length, updatedAt: new Date().toISOString() }));
    if (current) {
      for (let i = 0; i < current.chunks; i++) chunk(baseVersion, i).delete().catch(() => {});
    }
    return version;
  }

  /** Libère rapidement le bail (il expire de lui-même ; durée minimale 1 s). */
  function release() {
    lock.acquire({ holder, ttlMs: 1000 }).catch(() => {});
  }

  function watch(onVersion, onError) {
    return head.onSnapshot((snap) => {
      if (snap.exists) onVersion(snap.data().version);
    }, onError);
  }

  return { load, acquire, publish, release, watch, readHead };
}

module.exports = { createSharedStore, SyncError, gzip, gunzip, toBase64, fromBase64 };
