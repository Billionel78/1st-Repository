'use strict';

const path = require('node:path');
const { openDatabase, seed } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'ice-manager.db');

const db = openDatabase(DB_FILE);
if (seed(db, { adminPassword: process.env.ADMIN_PASSWORD || 'admin123', demoCatalog: process.env.DEMO_CATALOG !== '0' })) {
  console.log('Base de données initialisée. Compte responsable : admin / ' +
    (process.env.ADMIN_PASSWORD ? '(mot de passe défini par ADMIN_PASSWORD)' : 'admin123 — changez-le dès la première connexion !'));
}

const app = createApp(db, { secureCookies: process.env.COOKIE_SECURE === '1' });
const server = app.listen(PORT, HOST, () => {
  console.log(`ICE MANAGER démarré sur http://localhost:${PORT}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
