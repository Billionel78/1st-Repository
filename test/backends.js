'use strict';

// Les mêmes tests s'exécutent sur SQLite et sur PostgreSQL. PostgreSQL est fourni par PGlite
// (un vrai PostgreSQL compilé en WebAssembly, sans serveur à installer), utilisé de deux façons :
//  - directement ;
//  - à travers le protocole réseau PostgreSQL et le pilote `pg`, comme en production (Neon…).

const { openSqlite, migrate } = require('../server/db');
const { PgliteDatabase, connectPostgres } = require('../server/database');

const BACKENDS = [
  { name: 'SQLite', open: () => openSqlite(':memory:') },
  {
    name: 'PostgreSQL',
    async open() {
      const { PGlite } = require('@electric-sql/pglite');
      const db = new PgliteDatabase(new PGlite());
      await migrate(db);
      return db;
    },
  },
  {
    name: 'PostgreSQL (pilote pg)',
    async open() {
      const { PGlite } = require('@electric-sql/pglite');
      const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');
      const pglite = await PGlite.create();
      const port = 20000 + Math.floor(Math.random() * 20000);
      const server = new PGLiteSocketServer({ db: pglite, port, host: '127.0.0.1' });
      await server.start();
      // PGlite ne sert qu'une connexion à la fois.
      const db = connectPostgres(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1 });
      await migrate(db);
      const close = db.close.bind(db);
      db.close = async () => {
        await close();
        await server.stop();
        await pglite.close();
      };
      return db;
    },
  },
];

module.exports = { BACKENDS };
