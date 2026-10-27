'use strict';

const { openFromEnv, seed, hasUsers } = require('./db');
const { createApp } = require('./app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const db = await openFromEnv();
  console.log(`Base de données : ${db.dialect === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : 'SQLite (fichier local)'}`);

  // Installation automatisée : ADMIN_PASSWORD crée directement le compte « admin ».
  // Sinon, la première ouverture affiche l'écran de configuration de l'établissement.
  if (!(await hasUsers(db))) {
    if (process.env.ADMIN_PASSWORD) {
      await seed(db, { adminPassword: process.env.ADMIN_PASSWORD, demoCatalog: process.env.DEMO_CATALOG !== '0' });
      console.log('Compte responsable créé : admin (mot de passe défini par ADMIN_PASSWORD).');
    } else {
      console.log('Base vide : ouvrez l’application pour configurer l’établissement.');
    }
  }

  const app = createApp(db, {
    secureCookies: process.env.COOKIE_SECURE === '1',
    trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : 'loopback',
  });
  const server = app.listen(PORT, HOST, () => {
    console.log(`ICE MANAGER démarré sur http://localhost:${PORT}`);
  });

  const shutdown = () => {
    server.close(async () => {
      await db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Démarrage impossible :', err.message);
  process.exit(1);
});
