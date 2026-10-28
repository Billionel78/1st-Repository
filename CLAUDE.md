# ICE MANAGER — notes pour Claude Code

Application de gestion de bar (français) : produits, tables, commandes, paiements (espèces, Mobile Money),
clients, stock, rapports, statistiques. Interface et messages en **français**.

## Commandes

- `npm install` puis `npm run dev` : serveur sur http://localhost:3000 (base SQLite `data/ice-manager.db`, créée au besoin).
- `npm test` : tests `node:test`, exécutés sur 3 moteurs (SQLite, PostgreSQL via PGlite, pilote `pg` sur pglite-socket).
- `npm run build:web` : version navigateur sans serveur → `demo/dist/ice-manager.html` (plateforme partagée claude.ai)
  et `demo/dist/ice-manager-demo.html` (démo).
- Node **22.13+** obligatoire (`node:sqlite`).
- PostgreSQL (Neon…) : définir `DATABASE_URL`. Ne jamais écrire d'identifiants dans le dépôt.

## Architecture

- `server/app.js` : Express 5, authentification (cookie de session), routes publiques `/api/platform*`, `/api/auth/*`.
- `server/routes/*.js` : catalogue, commandes, clients, stock, statistiques, rapports CSV, utilisateurs.
- `server/database.js` : couche d'accès **asynchrone** commune (`get`, `all`, `run`, `transaction`) pour SQLite,
  PostgreSQL et PGlite. Le SQL s'écrit une fois avec des `?` (convertis en `$n` pour PG).
  Dans une transaction, passer l'objet `tx` aux fonctions appelées (sinon blocage avec PGlite).
  PG est strict sur `GROUP BY` : utiliser `MAX()` pour les colonnes non groupées.
- `server/db.js` : schémas SQLite et PostgreSQL, `MIGRATIONS` (ajout de colonnes), `seed`.
  Toute nouvelle colonne : l'ajouter aux deux schémas **et** à `MIGRATIONS`. Nouvelle table avec `id` : l'ajouter à `ID_TABLES`.
- Dates : chaînes locales `YYYY-MM-DD HH:MM:SS` ; utiliser `req.now` / `req.today` (le responsable peut antidater
  via l'en-tête `X-Ice-Date`).
- `public/` : interface monopage sans framework (`app.js`, `index.html`, `style.css`), thèmes clair/sombre, mobile d'abord.
- `demo/` : version navigateur. `build.js` regroupe le code serveur avec des remplacements (`demo/shims/`) :
  sql.js à la place de `node:sqlite`, SHA-256 à la place de scrypt. `main.js` intercepte `fetch('/api/…')`.
  `shared-store.js` partage la base entre appareils via la capacité `db` de l'artefact (instantanés + verrou).
  Toute fonction ajoutée à `server/security.js` doit aussi exister dans `demo/shims/security.js`.

## Conventions

- Montants en entiers (FCFA). Rôles : `admin` (responsable) et `serveur`.
- Ajouter un test dans `test/` pour chaque nouvelle route ; vérifier que `npm test` et `npm run build:web` passent.
