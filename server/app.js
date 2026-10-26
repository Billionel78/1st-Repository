'use strict';

const path = require('node:path');
const express = require('express');
const { HttpError, badRequest, toText } = require('./http');
const { hashPassword, verifyPassword, newToken, createLoginLimiter } = require('./security');
const { nowLocal } = require('./time');
const catalogRoutes = require('./routes/catalog');
const orderRoutes = require('./routes/orders');
const statsRoutes = require('./routes/stats');
const userRoutes = require('./routes/users');
const stockRoutes = require('./routes/stock');
const reportRoutes = require('./routes/reports');

const SESSION_COOKIE = 'ice_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // une journée de service

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createApp(db, { secureCookies = false } = {}) {
  const app = express();
  const loginLimiter = createLoginLimiter();

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  // ---------- Authentification ----------
  const findSession = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.role, u.active, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`);

  app.use('/api', (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const row = findSession.get(token);
      if (row && row.active && row.expires_at > Date.now()) {
        req.user = { id: row.id, username: row.username, full_name: row.full_name, role: row.role };
        req.sessionToken = token;
      } else if (row) {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      }
    }
    next();
  });

  function setSessionCookie(res, token, maxAge) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: secureCookies,
      maxAge,
      path: '/',
    });
  }

  app.post('/api/auth/login', (req, res) => {
    const username = toText(req.body?.username, "nom d'utilisateur", { max: 50 });
    const password = String(req.body?.password ?? '');
    const key = `${req.ip}|${username.toLowerCase()}`;
    if (loginLimiter.isBlocked(key)) {
      throw new HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      loginLimiter.fail(key);
      throw new HttpError(401, "Nom d'utilisateur ou mot de passe incorrect.");
    }
    loginLimiter.reset(key);
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    const token = newToken();
    db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      token, user.id, nowLocal(), Date.now() + SESSION_TTL_MS
    );
    setSessionCookie(res, token, SESSION_TTL_MS);
    res.json({ user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role } });
  });

  app.post('/api/auth/logout', (req, res) => {
    if (req.sessionToken) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.sessionToken);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // Toutes les routes suivantes exigent une session valide.
  app.use('/api', (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Veuillez vous connecter.'));
    next();
  });

  const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') return next(new HttpError(403, 'Action réservée au responsable.'));
    next();
  };

  app.get('/api/auth/me', (req, res) => {
    res.json({ user: req.user, settings: readSettings(db) });
  });

  app.post('/api/auth/password', (req, res) => {
    const current = String(req.body?.current_password ?? '');
    const next = String(req.body?.new_password ?? '');
    if (next.length < 6) throw badRequest('Le nouveau mot de passe doit contenir au moins 6 caractères.');
    const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!verifyPassword(current, user.password_hash)) throw badRequest('Mot de passe actuel incorrect.');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(next), req.user.id);
    // Déconnecte les autres appareils.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.user.id, req.sessionToken);
    res.json({ ok: true });
  });

  // ---------- Paramètres ----------
  app.get('/api/settings', (req, res) => res.json(readSettings(db)));

  app.put('/api/settings', requireAdmin, (req, res) => {
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    const barName = toText(req.body?.bar_name, 'nom du bar', { max: 60, optional: true });
    const currency = toText(req.body?.currency, 'devise', { max: 10, optional: true });
    if (barName !== undefined) upsert.run('bar_name', barName);
    if (currency !== undefined) upsert.run('currency', currency);
    res.json(readSettings(db));
  });

  catalogRoutes(app, db, { requireAdmin });
  orderRoutes(app, db, { requireAdmin });
  statsRoutes(app, db, { requireAdmin });
  userRoutes(app, db, { requireAdmin });
  stockRoutes(app, db, { requireAdmin });
  reportRoutes(app, db, { requireAdmin });

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Ressource introuvable.')));

  // ---------- Interface web ----------
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', maxAge: 0 }));

  // ---------- Gestion des erreurs ----------
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Requête JSON invalide.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Requête trop volumineuse.' });
    console.error(err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  });

  return app;
}

function readSettings(db) {
  const out = { bar_name: 'ICE MANAGER', currency: 'FCFA' };
  for (const row of db.prepare('SELECT key, value FROM settings').all()) out[row.key] = row.value;
  return out;
}

module.exports = { createApp };
