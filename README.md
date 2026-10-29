# 🧊 ICE MANAGER – Gestion de bar

Application web simple pour gérer un bar : familles de produits, produits, tables, commandes,
paiements (Cash et Mobile Money), historique et statistiques quotidiennes.
Elle s'utilise depuis un navigateur sur ordinateur, tablette ou téléphone.

## Démarrage rapide (sur un ordinateur)

Prérequis : **Node.js 22.13 ou plus récent**. Sans configuration, les données sont stockées dans un
fichier SQLite local (`data/ice-manager.db`).

```bash
npm install
npm start
```

Ouvrez ensuite <http://localhost:3000> (ou `http://<adresse-ip-du-poste>:3000` depuis une tablette
ou un téléphone connecté au même réseau Wi-Fi). À la première ouverture, un écran de configuration
crée l'établissement et le compte du responsable (identifiant et mot de passe de votre choix).

Un catalogue de départ (Bières, Vins, Liqueurs, Boissons non alcoolisées, Sucreries, Autres produits),
8 tables et les moyens de paiement Espèces, Orange Money, MTN Mobile Money et Wave sont créés.
Tout est modifiable dans **Gestion**.

## Base de données PostgreSQL (Neon…)

Si la variable `DATABASE_URL` est définie, l'application utilise PostgreSQL au lieu de SQLite.
Les tables sont créées automatiquement au démarrage (rien à faire dans la console de la base).

```bash
DATABASE_URL="postgresql://utilisateur:motdepasse@hote/base?sslmode=require" npm start
```

- Avec **Neon**, utilisez l'adresse **« pooler »** (`…-pooler….neon.tech`).
- Ne mettez jamais cette adresse (elle contient le mot de passe) dans le code ou dans Git :
  uniquement dans les variables d'environnement de l'hébergeur ou dans un fichier `.env` local
  (ignoré par Git).
- Les écritures sont sérialisées par un verrou PostgreSQL : plusieurs instances du serveur peuvent
  travailler sur la même base sans doublon de numéro de commande ni survente de stock.

## Mise en ligne (adresse publique permanente)

### Render (gratuit pour commencer)

1. Créez un compte sur <https://render.com> et connectez votre compte GitHub.
2. **New → Blueprint**, choisissez ce dépôt : le fichier `render.yaml` configure tout.
3. Render demande deux valeurs :
   - `DATABASE_URL` : l'adresse PostgreSQL (Neon, adresse « pooler ») ;
   - `TZ` : le fuseau horaire du bar, par exemple `Africa/Abidjan` (GMT), `Africa/Douala` ou
     `Africa/Kinshasa` (GMT+1).
4. Une fois le déploiement terminé, Render donne l'adresse du site (`https://ice-manager-….onrender.com`).
   Ouvrez-la : l'écran de configuration de l'établissement s'affiche.

Sur l'offre gratuite de Render, le service s'endort après 15 minutes sans visite et met environ une
minute à se réveiller ; une offre payante évite cette attente pendant le service.

### Autres hébergeurs

Le `Dockerfile` fonctionne sur tout hébergeur compatible Docker (Railway, Fly.io, Koyeb, un VPS…) :
fournir `DATABASE_URL`, `TZ`, et `COOKIE_SECURE=1` derrière HTTPS.

### Variables d'environnement

| Variable | Rôle | Défaut |
|---|---|---|
| `DATABASE_URL` | Base PostgreSQL ; absente : fichier SQLite | — |
| `PORT` | Port HTTP | `3000` |
| `DB_FILE` | Fichier SQLite (sans `DATABASE_URL`) | `data/ice-manager.db` |
| `TZ` | Fuseau horaire utilisé pour regrouper les ventes par jour | fuseau du système |
| `COOKIE_SECURE` | `1` si l'application est servie en HTTPS | — |
| `TRUST_PROXY` | `1` derrière le proxy d'un hébergeur (Render…) | — |
| `ADMIN_PASSWORD` | Installation automatisée : crée le compte `admin` sans écran de configuration | — |
| `DEMO_CATALOG` | `0` pour ne pas créer le catalogue de départ (avec `ADMIN_PASSWORD`) | `1` |
| `PG_POOL_MAX` | Nombre maximal de connexions PostgreSQL | `5` |

Sauvegarde : avec SQLite, copier le dossier `data/` (application arrêtée) ; avec Neon, utiliser les
sauvegardes et la restauration à un instant donné proposées par Neon.

## Fonctionnement

1. Le serveur se connecte et arrive sur le **tableau de bord** : encaissé du jour, répartition
   Cash / Mobile Money, commandes ouvertes, panneaux des familles, commandes en attente de paiement.
2. Il touche une **famille** (ex. Bières) → les produits s'affichent.
3. Il touche un **produit** (ex. Castle Beer) → il choisit la **table** puis la **quantité** et valide.
4. La commande est créée avec le statut **« En attente de paiement »**. Si la table a déjà une
   commande ouverte, les articles y sont **ajoutés** (quantités et total recalculés). La table reste
   présélectionnée pour enchaîner les produits suivants.
5. Pour encaisser : ouvrir la commande → **Encaisser** → choisir Espèces (avec calcul de la monnaie
   à rendre) ou un opérateur Mobile Money (référence de transaction facultative). Les paiements
   partiels sont acceptés ; la commande ne passe à **« Payée »** et n'est clôturée que lorsque le
   total est réglé.
6. À la clôture, la vente est ajoutée aux statistiques du jour et le stock est mis à jour (pour les
   produits dont le suivi du stock est activé).

Autres fonctions : correction des quantités tant que la commande est ouverte, changement de table,
annulation (responsable, si aucun paiement), vue des tables libres/occupées, historique par date,
statistiques par jour ou par période (aujourd'hui, hier, 7 jours, mois, dates libres), impression
de l'**addition** (commande ouverte) ou du **reçu** (commande payée) au format ticket de caisse 80 mm.

### Corrections par le responsable

Dans le détail d'une commande, le responsable peut :

- **modifier la date et l'heure de la vente** : ouverture, paiements, clôture et sorties de stock liées
  passent au nouveau jour (même heure, jamais avant l'ouverture) ; si le jour change, la commande reçoit
  un numéro de ce jour ; date future refusée ;
- **corriger une commande déjà payée** : quantités (− / +), retrait ou ajout d'articles. La commande reste
  payée : le paiement suit le nouveau total (hausse sur le dernier paiement, baisse retirée des derniers
  paiements ; en espèces, la monnaie rendue est recalculée) et le stock est corrigé (mouvement
  « Correction CMD-… »). Une commande payée garde au moins un article ;
- **changer le mode de paiement** d'un encaissement (erreur de saisie), sans changer son montant.

### Clients

Écran **Clients** (tout le personnel) : fiche avec nom, téléphone, notes et **table habituelle** ; visites,
total dépensé, panier moyen, dernière visite et historique de ses commandes ; recherche par nom ou
téléphone. À la prise de commande, l'étape « Client » (facultative) permet de choisir un client (sa table
habituelle est alors présélectionnée) ou d'en créer un sur place ; les ajouts sur la même table restent
au même client, et un autre client ne peut pas se greffer sur sa table. Le client d'une commande se
change depuis son détail (commande clôturée : responsable uniquement). Le client figure aussi sur les
cartes de commande, les tables, l'historique, le ticket, l'export des commandes et le classement
« Meilleurs clients » des statistiques. Supprimer une fiche (responsable) garde le nom sur les anciennes
commandes.

### Rattrapage de ventes passées (responsable)

Menu du responsable (ou page Historique) → **« Saisir des ventes passées »** : on choisit une journée
passée (un an maximum) et un bandeau jaune reste affiché. Les ventes se saisissent comme d'habitude ;
commandes, numéros (`CMD-AAAAMMJJ-…`), paiements et sorties de stock sont enregistrés à cette date
(l'heure réelle est conservée pour garder l'ordre des saisies). Une vente de rattrapage ne se mélange
jamais à une commande en cours d'une autre journée. **« Terminer le rattrapage »** revient à la date du jour.
Côté API : en-tête `X-Ice-Date: AAAA-MM-JJ`, accepté uniquement pour un responsable.

### Gestion des stocks (écran « Stock », responsable)

Le suivi du stock s'active produit par produit (Gestion → Produits → « Activer le suivi du stock »).

- **Entrée** : réception de marchandises, avec prix d'achat unitaire facultatif (met à jour le prix d'achat).
- **Perte** : casse, offert, périmé…, avec motif.
- **Inventaire** : saisir la quantité réellement comptée ; l'écart est enregistré automatiquement.
- **Vente** : déduite automatiquement à la clôture (paiement intégral) d'une commande.
- Chaque mouvement est historisé (date, quantité, stock après, commande liée, auteur, note).
- Les quantités sur commandes ouvertes sont **réservées** : on ne peut pas commander plus que le
  stock disponible.
- **Seuil d'alerte** par produit : les produits en stock bas ou en rupture sont signalés sur le
  tableau de bord et dans le menu.

### Fournisseurs et approvisionnements (responsable)

Accès : écran **Stock** → « 🚚 Fournisseurs » ou « 📥 Approvisionner ».

- **Fiche fournisseur** : nom, contact, téléphone, adresse, notes ; total des achats et **reste à payer**.
- **Catalogue de prix** : pour chaque produit, le prix du **conditionnement** (casier de 12, carton de 24… ou à l'unité).
  Le prix unitaire et la marge sur le prix de vente sont calculés. `GET /api/supplier-prices?product_id=…` compare
  les fournisseurs du moins cher au plus cher.
- **Approvisionner** : choisir le fournisseur, ajouter les produits livrés (un par un, tout le catalogue ou les produits
  en stock bas), saisir quantités et prix, puis le règlement (payé, à crédit ou en partie). À la validation :
  - le stock augmente (mouvement « Entrée » lié au bon `ACH-AAAAMMJJ-NNNN`) ;
  - le prix d'achat des produits devient le dernier coût unitaire payé (marges des rapports à jour) ;
  - le catalogue du fournisseur garde ces prix (case à décocher si besoin).
- **Bon d'approvisionnement** : paiements au fournisseur en une ou plusieurs fois ; annulation avec motif
  (les quantités ressortent du stock).
- Export Excel : `/api/reports/purchases.csv?from=…&to=…`.

### Rapports financiers

- Prix d'achat par produit → **coût d'achat des ventes**, **marge brute** et taux de marge dans les
  statistiques (le prix d'achat est figé au moment de la commande, comme le prix de vente).
- **Encaissements par utilisateur**, avec la part en espèces à remettre en caisse.
- **Exports Excel (CSV)** : ventes par produit, commandes, encaissements (écran Statistiques, pour la
  période choisie), état du stock et mouvements de stock (écran Stock).

### Mot de passe oublié

Lien « Mot de passe oublié ? » sous le formulaire de connexion :

- **Responsable** : à la création de l'établissement, un **code de secours** (`XXXX-XXXX-XXXX`) s'affiche une seule fois ;
  notez-le sur papier. Avec ce code, le responsable choisit un nouveau mot de passe ; un nouveau code lui est alors donné
  (chaque code ne sert qu'une fois) et toutes ses sessions ouvertes sont fermées. Code perdu : Gestion → Paramètres →
  « Code de secours » → Générer un nouveau code (mot de passe actuel demandé).
- **Serveur** : il prévient le responsable depuis l'écran de connexion. La demande apparaît sur l'accueil du responsable et
  dans Gestion → Utilisateurs (🔑) ; le responsable définit un nouveau mot de passe, ce qui efface la demande.
- **Plateforme en ligne (claude.ai)** : le propriétaire du lien peut en plus redéfinir le mot de passe d'un responsable
  sans code de secours.

Les tentatives de code erronées sont limitées (5 échecs, puis blocage de 5 minutes) ; la réponse ne révèle jamais si un
identifiant existe.

### Rôles

- **Responsable** (`admin`) : tout, plus la gestion (familles, produits, prix, stock, tables, moyens de
  paiement, utilisateurs, paramètres), les statistiques détaillées et l'annulation de commandes.
- **Serveur** : prise de commandes, ajouts, encaissements, tables, historique.

### Règles de calcul

- **Encaissé** = somme des paiements réellement enregistrés sur la période.
- **Produits vendus / plus vendus** = articles des commandes **payées** (clôturées) sur la période.
- Une commande non payée n'est jamais comptée comme une vente encaissée.
- Le prix est figé au moment de la saisie : modifier le prix d'un produit ne change pas les commandes
  déjà enregistrées.
- Les produits, familles, tables et moyens de paiement supprimés sont archivés : l'historique reste intact.

## Architecture

```
server/
  index.js          démarrage du serveur
  app.js            Express : sécurité, authentification, paramètres
  db.js             schémas SQLite et PostgreSQL, migrations, données initiales
  database.js       accès aux données commun à SQLite et PostgreSQL (requêtes, transactions)
  routes/catalog.js familles, produits, tables, moyens de paiement
  routes/orders.js  commandes, ajouts d'articles, paiements, annulation, transfert
  routes/stats.js   tableau de bord et statistiques
  routes/users.js   utilisateurs
  routes/stock.js   état du stock et mouvements (entrées, pertes, inventaires)
  routes/reports.js exports CSV (compatibles Excel)
  stock.js          enregistrement des mouvements de stock
public/             interface web (HTML/CSS/JS sans framework)
test/               tests de l'API (node:test)
```

Tables de la base : `users`, `sessions`, `settings`, `families`, `products`, `bar_tables`, `orders`,
`order_items`, `payment_methods`, `payments`, `stock_movements`. Les nouvelles colonnes sont ajoutées
automatiquement aux bases existantes au démarrage (aucune perte de données). Les statistiques sont calculées à la demande à partir des
commandes et paiements enregistrés.

Sécurité : mots de passe hachés (scrypt), session par cookie `HttpOnly` / `SameSite=Strict`,
limitation des tentatives de connexion, contrôle des rôles côté serveur, en-têtes de sécurité (CSP).

## Version navigateur (sans serveur)

`npm run build:web` génère deux pages autonomes dans `demo/dist/`, qui embarquent l'interface,
le code serveur (exécuté dans le navigateur, Express et `node:sqlite` remplacés par des équivalents
légers) et SQLite en WebAssembly (sql.js) :

- **`ice-manager.html` — la plateforme**, publiée comme artefact claude.ai. La base est stockée dans le
  stockage partagé de l'artefact (capacité `db`) : compressée, découpée en documents et versionnée.
  Chaque modification prend un bail d'écriture, vérifie qu'elle part de la dernière version, applique
  l'action avec le code serveur, puis publie la version suivante ; les autres appareils la reçoivent
  en direct. À la première ouverture, un écran de configuration crée l'établissement et le compte du
  responsable. Sauvegarde / restauration dans Gestion → Paramètres. Accès : le propriétaire de
  l'artefact et les personnes invitées comme éditeurs (ou contributeurs dans une organisation).
- **`ice-manager-demo.html` — la démo** : une semaine de ventes d'exemple, données gardées dans le
  navigateur. Comptes `admin` / `admin123` et `awa` / `serveur1`.

Dans ces versions, l'impression affiche le ticket à l'écran (le lecteur claude.ai bloque l'impression).

### Reprendre en local une base de la plateforme en ligne

Une base exportée de la plateforme claude.ai (fichier SQLite) s'utilise telle quelle : copiez-la en
`data/ice-manager.db` (ou indiquez son chemin avec `DB_FILE=…`) puis `npm run dev`. Les mots de passe créés en ligne
(empreintes SHA-256 de la version navigateur) sont acceptés et convertis en scrypt à la première connexion.

## Tests

```bash
npm test
```

Chaque suite s'exécute trois fois : sur SQLite, sur PostgreSQL (PGlite, un vrai PostgreSQL compilé en
WebAssembly) et sur PostgreSQL à travers le pilote `pg` et le protocole réseau, comme en production.

## Évolutions possibles

Fournisseurs et bons de commande, dépenses et charges (résultat net), clôture de caisse avec
comptage des espèces, gestion fine des droits, mode hors ligne.
