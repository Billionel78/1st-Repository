# 🧊 ICE MANAGER – Gestion de bar

Application web simple pour gérer un bar : familles de produits, produits, tables, commandes,
paiements (Cash et Mobile Money), historique et statistiques quotidiennes.
Elle s'utilise depuis un navigateur sur ordinateur, tablette ou téléphone.

## Démarrage rapide

Prérequis : **Node.js 22.5 ou plus récent** (la base SQLite est intégrée à Node, rien d'autre à installer).

```bash
npm install
npm start
```

Ouvrez ensuite <http://localhost:3000> (ou `http://<adresse-ip-du-poste>:3000` depuis une tablette
ou un téléphone connecté au même réseau Wi-Fi).

Premier compte : **admin / admin123**. Changez ce mot de passe dès la première connexion
(menu en haut à droite → « Changer mon mot de passe »).

Au premier lancement, l'application crée un catalogue d'exemple (Bières, Vins, Liqueurs, Boissons
non alcoolisées, Sucreries, Autres produits), 8 tables et les moyens de paiement Espèces,
Orange Money, MTN Mobile Money et Wave. Tout est modifiable dans **Gestion**.

### Variables d'environnement (facultatives)

| Variable | Rôle | Défaut |
|---|---|---|
| `PORT` | Port HTTP | `3000` |
| `DB_FILE` | Emplacement de la base de données | `data/ice-manager.db` |
| `ADMIN_PASSWORD` | Mot de passe du compte `admin` créé au premier lancement | `admin123` |
| `DEMO_CATALOG` | `0` pour démarrer sans le catalogue d'exemple | `1` |
| `TZ` | Fuseau horaire utilisé pour regrouper les ventes par jour (ex. `Africa/Abidjan`) | fuseau du système |
| `COOKIE_SECURE` | `1` si l'application est servie en HTTPS | — |

Sauvegarde : il suffit de copier le dossier `data/` (application arrêtée).

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
statistiques par jour ou par période (aujourd'hui, hier, 7 jours, mois, dates libres), impression.

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
  db.js             schéma SQLite et données initiales
  routes/catalog.js familles, produits, tables, moyens de paiement
  routes/orders.js  commandes, ajouts d'articles, paiements, annulation, transfert
  routes/stats.js   tableau de bord et statistiques
  routes/users.js   utilisateurs
public/             interface web (HTML/CSS/JS sans framework)
test/               tests de l'API (node:test)
```

Tables de la base : `users`, `sessions`, `settings`, `families`, `products`, `bar_tables`, `orders`,
`order_items`, `payment_methods`, `payments`. Les statistiques sont calculées à la demande à partir des
commandes et paiements enregistrés.

Sécurité : mots de passe hachés (scrypt), session par cookie `HttpOnly` / `SameSite=Strict`,
limitation des tentatives de connexion, contrôle des rôles côté serveur, en-têtes de sécurité (CSP).

## Tests

```bash
npm test
```

## Évolutions possibles

Gestion avancée des stocks (entrées, inventaires, alertes), rapports financiers exportables (PDF/Excel),
impression de tickets, gestion fine des droits, mode hors ligne.
