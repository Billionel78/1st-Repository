'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (msg) => new HttpError(400, msg);
const notFound = (msg = 'Élément introuvable.') => new HttpError(404, msg);
const conflict = (msg) => new HttpError(409, msg);

/** Entier strictement contrôlé (pas de décimales, pas de chaînes vides). */
function toInt(value, field, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    throw badRequest(`Le champ « ${field} » est obligatoire.`);
  }
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isInteger(n)) throw badRequest(`Le champ « ${field} » doit être un nombre entier.`);
  if (n < min) throw badRequest(`Le champ « ${field} » doit être supérieur ou égal à ${min}.`);
  if (n > max) throw badRequest(`Le champ « ${field} » doit être inférieur ou égal à ${max}.`);
  return n;
}

function toText(value, field, { max = 100, optional = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (optional) return undefined;
    throw badRequest(`Le champ « ${field} » est obligatoire.`);
  }
  const s = String(value).trim();
  if (s.length > max) throw badRequest(`Le champ « ${field} » ne doit pas dépasser ${max} caractères.`);
  return s;
}

function toBool(value, field, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return undefined;
    throw badRequest(`Le champ « ${field} » est obligatoire.`);
  }
  if (value === true || value === 1 || value === '1' || value === 'true') return true;
  if (value === false || value === 0 || value === '0' || value === 'false') return false;
  throw badRequest(`Le champ « ${field} » doit être vrai ou faux.`);
}

function toColor(value, { optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return undefined;
    throw badRequest('La couleur est obligatoire.');
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw badRequest('Couleur invalide (format attendu : #RRGGBB).');
  return value.toLowerCase();
}

module.exports = { HttpError, badRequest, notFound, conflict, toInt, toText, toBool, toColor };
