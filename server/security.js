'use strict';

const crypto = require('node:crypto');

const KEY_LENGTH = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, KEY_LENGTH).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Limiteur simple en mémoire des tentatives de connexion. */
function createLoginLimiter({ maxAttempts = 5, windowMs = 5 * 60 * 1000 } = {}) {
  const attempts = new Map();
  return {
    isBlocked(key) {
      const entry = attempts.get(key);
      if (!entry) return false;
      if (Date.now() - entry.first > windowMs) {
        attempts.delete(key);
        return false;
      }
      return entry.count >= maxAttempts;
    },
    fail(key) {
      const entry = attempts.get(key);
      if (!entry || Date.now() - entry.first > windowMs) attempts.set(key, { count: 1, first: Date.now() });
      else entry.count += 1;
    },
    reset(key) {
      attempts.delete(key);
    },
  };
}

module.exports = { hashPassword, verifyPassword, newToken, createLoginLimiter };
