'use strict';

const path = require('node:path');
const express = require('express');
const { HttpError, badRequest, toText } = require('./http');
const { hashPassword, verifyPassword, newToken, createLoginLimiter } = require('./security');
const { nowLocal, todayLocal, isIsoDate } = require('./time');
const { seed, hasUsers } = require('./db');
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

function createApp(db, { secureCookies = false, trustProxy = 'loopback' } = {}) {
  const app = express();
  const loginLimiter = createLoginLimiter();

  app.disable('x-powered-by');
  // Derrière l'hébergeur (Render…), un proxy transmet l'adresse réelle du client.
  app.set('trust proxy', trustProxy);

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
  app.use(express.json({ limit: '2mb' })); // photos des produits

  // ---------- Première ouverture : création de l'établissement ----------
  app.get('/api/platform', async (req, res) => {
    res.json({ mode: 'server', status: (await hasUsers(db)) ? 'ready' : 'setup' });
  });

  app.post('/api/platform/setup', async (req, res) => {
    const barName = toText(req.body?.bar_name, "nom de l'établissement", { max: 60 });
    const fullName = toText(req.body?.full_name, 'nom', { max: 80 });
    const username = toText(req.body?.username, 'identifiant', { max: 50 });
    const password = String(req.body?.password ?? '');
    if (!/^[\w.-]{2,50}$/.test(username)) {
      throw badRequest("L'identifiant doit contenir 2 à 50 lettres, chiffres, « . », « - » ou « _ ».");
    }
    if (password.length < 6) throw badRequest('Le mot de passe doit contenir au moins 6 caractères.');
    const created = await seed(db, { adminUsername: username, adminFullName: fullName, adminPassword: password, barName });
    if (!created) throw new HttpError(409, 'La plateforme est déjà configurée. Connectez-vous.');
    res.status(201).json({ ok: true });
  });

  // ---------- Authentification ----------
  app.use('/api', async (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      const row = await db.get(`
        SELECT u.id, u.username, u.full_name, u.role, u.active, s.expires_at
        FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`, token);
      if (row && row.active && Number(row.expires_at) > Date.now()) {
        req.user = { id: row.id, username: row.username, full_name: row.full_name, role: row.role };
        req.sessionToken = token;
      } else if (row) {
        await db.run('DELETE FROM sessions WHERE token = ?', token);
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

  app.post('/api/auth/login', async (req, res) => {
    const username = toText(req.body?.username, "nom d'utilisateur", { max: 50 });
    const password = String(req.body?.password ?? '');
    const key = `${req.ip}|${username.toLowerCase()}`;
    if (loginLimiter.isBlocked(key)) {
      throw new HttpError(429, 'Trop de tentatives. Réessayez dans quelques minutes.');
    }
    const user = await db.get('SELECT * FROM users WHERE lower(username) = lower(?)', username);
    if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
      loginLimiter.fail(key);
      throw new HttpError(401, "Nom d'utilisateur ou mot de passe incorrect.");
    }
    loginLimiter.reset(key);
    await db.run('DELETE FROM sessions WHERE expires_at <= ?', Date.now());
    const token = newToken();
    await db.run('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      token, user.id, nowLocal(), Date.now() + SESSION_TTL_MS);
    setSessionCookie(res, token, SESSION_TTL_MS);
    res.json({ user: { id: user.id, username: user.username, full_name: user.full_name, role: user.role } });
  });

  app.post('/api/auth/logout', async (req, res) => {
    if (req.sessionToken) await db.run('DELETE FROM sessions WHERE token = ?', req.sessionToken);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  // Toutes les routes suivantes exigent une session valide.
  app.use('/api', (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Veuillez vous connecter.'));
    next();
  });

  // Date de saisie : maintenant, ou une journée passée en mode rattrapage (responsable uniquement).
  // L'en-tête X-Ice-Date porte la date (AAAA-MM-JJ) ; l'heure reste l'heure réelle, pour garder l'ordre des saisies.
  app.use('/api', (req, res, next) => {
    req.now = nowLocal();
    req.today = todayLocal();
    const date = req.headers['x-ice-date'];
    if (date && req.user.role === 'admin') {
      const oldest = todayLocal(new Date(Date.now() - 366 * 86_400_000));
      if (!isIsoDate(date) || date >= req.today || date < oldest) {
        return next(badRequest('Date de rattrapage invalide : choisissez une journée passée (un an maximum).'));
      }
      req.backdate = date;
      req.now = `${date} ${req.now.slice(11)}`;
      req.today = date;
    }
    next();
  });

  const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') return next(new HttpError(403, 'Action réservée au responsable.'));
    next();
  };

  app.get('/api/auth/me', async (req, res) => {
    res.json({ user: req.user, settings: await readSettings(db) });
  });

  app.post('/api/auth/password', async (req, res) => {
    const current = String(req.body?.current_password ?? '');
    const next = String(req.body?.new_password ?? '');
    if (next.length < 6) throw badRequest('Le nouveau mot de passe doit contenir au moins 6 caractères.');
    const user = await db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(current, user.password_hash)) throw badRequest('Mot de passe actuel incorrect.');
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(next), req.user.id);
    // Déconnecte les autres appareils.
    await db.run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', req.user.id, req.sessionToken);
    res.json({ ok: true });
  });

  // ---------- Paramètres ----------
  app.get('/api/settings', async (req, res) => res.json(await readSettings(db)));

  app.put('/api/settings', requireAdmin, async (req, res) => {
    const upsert = 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value';
    const barName = toText(req.body?.bar_name, 'nom du bar', { max: 60, optional: true });
    const currency = toText(req.body?.currency, 'devise', { max: 10, optional: true });
    if (barName !== undefined) await db.run(upsert, 'bar_name', barName);
    if (currency !== undefined) await db.run(upsert, 'currency', currency);
    res.json(await readSettings(db));
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

async function readSettings(db) {
  const out = { bar_name: 'ICE MANAGER', currency: 'FCFA' };
  for (const row of await db.all('SELECT key, value FROM settings')) out[row.key] = row.value;
  return out;
}

module.exports = { createApp };
