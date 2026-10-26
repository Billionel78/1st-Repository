'use strict';

const { badRequest, notFound, conflict, toInt, toText, toBool } = require('../http');
const { hashPassword } = require('../security');
const { nowLocal } = require('../time');

const ROLES = ['admin', 'serveur'];

module.exports = function userRoutes(app, db, { requireAdmin }) {
  const getUser = (id) =>
    db.prepare('SELECT id, username, full_name, role, active, created_at FROM users WHERE id = ?').get(id);

  const activeAdmins = () =>
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;

  function role(value, optional) {
    if (value === undefined && optional) return undefined;
    if (!ROLES.includes(value)) throw badRequest('Rôle invalide (admin ou serveur).');
    return value;
  }

  function password(value, optional) {
    if ((value === undefined || value === '') && optional) return undefined;
    if (typeof value !== 'string' || value.length < 6) {
      throw badRequest('Le mot de passe doit contenir au moins 6 caractères.');
    }
    return value;
  }

  app.get('/api/users', requireAdmin, (req, res) => {
    res.json(db.prepare(
      'SELECT id, username, full_name, role, active, created_at FROM users ORDER BY active DESC, full_name'
    ).all());
  });

  app.post('/api/users', requireAdmin, (req, res) => {
    const username = toText(req.body?.username, "nom d'utilisateur", { max: 50 });
    if (!/^[\w.-]+$/.test(username)) {
      throw badRequest("Le nom d'utilisateur ne doit contenir que des lettres, chiffres, « . », « - » ou « _ ».");
    }
    const fullName = toText(req.body?.full_name, 'nom complet', { max: 80 });
    const r = role(req.body?.role, false);
    const pwd = password(req.body?.password, false);
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      throw conflict("Ce nom d'utilisateur existe déjà.");
    }
    const result = db.prepare(
      'INSERT INTO users (username, full_name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(username, fullName, hashPassword(pwd), r, nowLocal());
    res.status(201).json(getUser(result.lastInsertRowid));
  });

  app.put('/api/users/:id', requireAdmin, (req, res) => {
    const id = toInt(req.params.id, 'id');
    const current = getUser(id);
    if (!current) throw notFound('Utilisateur introuvable.');
    const fullName = toText(req.body?.full_name, 'nom complet', { max: 80, optional: true }) ?? current.full_name;
    const newRole = role(req.body?.role, true) ?? current.role;
    const activeIn = toBool(req.body?.active, 'actif', { optional: true });
    const active = activeIn === undefined ? current.active : (activeIn ? 1 : 0);
    const pwd = password(req.body?.password, true);

    const losesAdmin = current.role === 'admin' && current.active && (newRole !== 'admin' || !active);
    if (losesAdmin && activeAdmins() <= 1) throw conflict('Il doit rester au moins un responsable actif.');
    if (id === req.user.id && !active) throw conflict('Vous ne pouvez pas désactiver votre propre compte.');

    db.prepare('UPDATE users SET full_name = ?, role = ?, active = ? WHERE id = ?').run(fullName, newRole, active, id);
    if (pwd) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pwd), id);
    if (!active || pwd || newRole !== current.role) {
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(id, req.sessionToken ?? '');
    }
    res.json(getUser(id));
  });
};
