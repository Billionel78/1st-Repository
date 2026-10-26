'use strict';

// Les dates sont stockées en heure locale du serveur (variable d'environnement TZ),
// au format « YYYY-MM-DD HH:MM:SS », ce qui permet de regrouper les ventes par journée
// avec un simple substr(…, 1, 10).

const pad = (n) => String(n).padStart(2, '0');

function nowLocal(date = new Date()) {
  return `${todayLocal(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function todayLocal(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

module.exports = { nowLocal, todayLocal, isIsoDate };
