# Déployer PanelFlow sur Vercel + Turso

Le backend tournait sur `node:sqlite`, qui écrit un fichier local. Vercel exécute
le code dans une lambda dont le disque est en lecture seule et effacé entre deux
requêtes : un fichier SQLite y serait perdu à chaque invocation. Le driver est
donc passé à `@libsql/client`, qui parle le même SQL mais peut viser une base
**Turso** distante.

Rien d'autre ne change : le même `app` Express répond en local et en ligne.

## 1. Créer la base Turso

```bash
npm i -g @tursodatabase/cli
turso auth signup
turso db create panelflow
turso db show panelflow --url
turso db tokens create panelflow
```

Le plan gratuit couvre largement l'usage d'un lecteur perso (500 bases,
9 Go, 1 milliard de lignes lues par mois).

Le schéma n'a pas besoin d'être créé à la main : les migrations tournent
automatiquement à la première requête (`dbReady()` dans `backend/src/db.js`).

## 2. Variables d'environnement Vercel

Dans *Project → Settings → Environment Variables* :

| Variable | Valeur | Obligatoire |
|---|---|---|
| `TURSO_DATABASE_URL` | `libsql://panelflow-<user>.turso.io` | oui |
| `TURSO_AUTH_TOKEN` | le token de l'étape 1 | oui |
| `PANELFLOW_JWT_SECRET` | une chaîne aléatoire longue | oui |

Les deux premières sont vérifiées au démarrage : sans elles la fonction refuse
de booter plutôt que d'écrire dans le vide. `PANELFLOW_JWT_SECRET` fait de même —
la valeur de développement `dev-secret-change-me` est publique, donc n'importe
qui pourrait forger un token pour n'importe quel compte.

Générer un secret :

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Optionnel, pour les trackers : `PANELFLOW_ANILIST_CLIENT_ID`,
`PANELFLOW_ANILIST_CLIENT_SECRET`, `PANELFLOW_ANILIST_REDIRECT_URI`
(idem pour `MAL`, `KITSU`).

## 3. Déployer

```bash
npm i -g vercel
vercel link
vercel --prod
```

`vercel.json` réécrit **toutes** les routes vers `api/index.js`, qui importe
l'app Express. L'API (`/api/*`) et le web app (`/`, servi par
`express.static`) sortent donc de la même fonction, comme en local.

`includeFiles` embarque `web/**` et `shared/**` dans le bundle — sans ça,
`/` renverrait 404 et `/api/rules` échouerait.

## 4. Pointer l'extension vers la prod

Dans les réglages de l'extension, remplacer l'URL de l'API
`http://localhost:8787` par `https://<projet>.vercel.app`, puis se reconnecter
(le token est signé avec l'ancien secret, il ne sera plus valide).

## 5. Migrer les données existantes

La base locale est dans `backend/data/panelflow.db`. Pour la pousser vers Turso :

```bash
turso db shell panelflow < dump.sql
```

où `dump.sql` vient de `sqlite3 backend/data/panelflow.db .dump`. Faire une
copie du `.db` avant toute manipulation.

## Rester en local

Sans `TURSO_DATABASE_URL`, `db.js` retombe sur le fichier
`backend/data/panelflow.db` par le même driver libsql. `npm run dev` et
`npm test` ne changent pas.

## Pourquoi deux points d'entrée libsql

`backend/src/db.js` choisit son driver **avant** de charger quoi que ce soit :

```js
const { createClient } = remoteUrl
  ? await import('@libsql/client/web')
  : await import('@libsql/client');
```

Le paquet par défaut lit les bases `file:`, et pour ça il require le paquet
natif `libsql` — un binaire compilé livré en une dépendance optionnelle par
plateforme. npm ne résout que la plateforme sur laquelle il a tourné : un
lockfile écrit sous Windows ne contient que `@libsql/win32-x64-msvc`, donc un
build Linux ne trouve rien à charger et la fonction meurt au démarrage :

```
Cannot find module '@libsql/linux-x64-gnu'
Require stack: /var/task/backend/node_modules/libsql/index.js
```

Le build, lui, réussit — c'est une erreur d'exécution sur un déploiement qui se
déclare vert.

`/web` est la même API parlée en HTTP, sans aucun binaire. On n'y perd rien :
elle abandonne le support `file:`, et une lambda n'a de toute façon pas de
disque durable à pointer. C'est aussi le plus petit import, ce qu'un cold start
paie.

Le contrôle de configuration passe **avant** ce choix, pour que l'absence de
`TURSO_DATABASE_URL` produise son propre message plutôt que l'erreur de binaire
manquant, qui ne nomme aucune des trois choses réellement en cause.

Quatre tests gardent tout ça dans `backend/test/db-driver.test.js`.

## Limites connues

- **Cold start** : la première requête après une période d'inactivité paie la
  connexion à Turso + les migrations (~200-400 ms).
- **`/api/meta/check`** boucle sur toute la bibliothèque avec 1,5 s d'attente
  entre deux sites. Au-delà d'une dizaine d'entrées, la fonction dépasse le
  timeout du plan gratuit (10 s). À découper si ça devient gênant.
- **Le fallback `curl`** de `fetchPage` (contournement anti-bot Cloudflare)
  suppose un binaire `curl` dans le runtime ; s'il manque, la route renvoie
  502 au lieu de réessayer.
- **`/api/cover`** est un proxy public non authentifié. Il est borné (hôtes
  publics, `image/*`, 8 Mo, cache 100 entrées) mais consomme de la bande
  passante pour n'importe qui connaissant l'URL.
