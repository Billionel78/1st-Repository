'use strict';

// Remplace server/security.js dans la démo : le navigateur n'a pas de scrypt synchrone.
// Les mots de passe restent hachés (SHA-256 salé et itéré) ; les données ne quittent pas le navigateur.

function sha256(bytes) {
  const K = [];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const frac = (x) => ((x - Math.floor(x)) * 2 ** 32) | 0;
  for (let n = 2, c = 0; c < 64; n++) {
    let prime = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
    if (prime) K[c++] = frac(n ** (1 / 3));
  }
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, len * 8);
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 2 ** 32));
  const w = new Int32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getInt32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) | 0; });
  }
  return H.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
}

const utf8 = (s) => new TextEncoder().encode(s);

function randomHex(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function derive(password, salt) {
  let h = sha256(utf8(`${salt}:${password}`));
  for (let i = 0; i < 500; i++) h = sha256(utf8(h + salt));
  return h;
}

function hashPassword(password) {
  const salt = randomHex(16);
  return `sha256$${salt}$${derive(String(password), salt)}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  return scheme === 'sha256' && derive(String(password), salt) === hash;
}

// Code de secours du responsable : 12 caractères faciles à recopier (sans 0/O, 1/I/L), groupés par 4.
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const normalizeRecoveryCode = (code) => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function newRecoveryCode() {
  const bytes = crypto.getRandomValues(new Uint32Array(12));
  return Array.from(bytes, (n) => RECOVERY_ALPHABET[n % RECOVERY_ALPHABET.length]).join('').match(/.{4}/g).join('-');
}

const newToken = () => randomHex(32);

function createLoginLimiter() {
  return { isBlocked: () => false, fail() {}, reset() {} };
}

module.exports = { hashPassword, verifyPassword, newToken, newRecoveryCode, normalizeRecoveryCode, createLoginLimiter, sha256 };
