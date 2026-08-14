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

### Les trackers (optionnel)

Trois variables par service, sinon le service s'affiche grisé côté client au
lieu de proposer un bouton qui répondrait `501` :

| Variable | Où la trouver |
|---|---|
| `PANELFLOW_ANILIST_CLIENT_ID` / `_CLIENT_SECRET` | AniList → Settings → Developer → Create New Client |
| `PANELFLOW_ANILIST_REDIRECT_URI` | `https://<ton-deploiement>/api/trackers/anilist/callback` |
| `PANELFLOW_MAL_CLIENT_ID` / `_CLIENT_SECRET` | MyAnimeList → Account settings → API → Create ID |
| `PANELFLOW_MAL_REDIRECT_URI` | `https://<ton-deploiement>/api/trackers/mal/callback` |

L'URL de redirection doit être **identique au caractère près** à celle
enregistrée chez le tracker : c'est elle qui est renvoyée lors de l'échange du
code, et un slash en trop fait échouer l'échange, pas l'autorisation — donc
l'erreur n'arrive qu'à la fin.

Kitsu n'a pas d'équivalent : son OAuth réclame le mot de passe du compte, que
PanelFlow ne demande pas. Aucune variable ne le rendra connectable.

### Le watcher de chapitres

`CRON_SECRET` (ou `PANELFLOW_CRON_SECRET`, même chose) — même
génération que ci-dessus. Vercel l'envoie en `Authorization: Bearer` quand le
cron déclenche `/api/watch/run` ; sans elle la route répond `503` et le watcher
ne tourne pas du tout. C'est volontaire : une route ouverte qui fait aller
chercher des dizaines de pages tierces est un amplificateur gratuit pour qui
trouve l'URL.

L'horaire est dans [vercel.json](../vercel.json) : une passe par jour à 5 h UTC.
C'est la limite du plan Hobby (un cron par jour) ; en Pro, `0 */6 * * *` donne
quatre passes et donc des notifications moins en retard. Une passe traite les
150 séries vues le moins récemment et s'arrête d'elle-même à 240 s — la suivante
reprend là où celle-ci s'est arrêtée, donc une bibliothèque plus grosse qu'une
passe finit quand même par être couverte entièrement.

### Les notifications navigateur fermé (optionnel)

Sans ça, le watcher continue de tout trouver et de tout stocker : la nouvelle
attend simplement l'ouverture d'un client. Avec, elle arrive pendant la nuit.

Génère la paire toi-même — la clé privée ne doit jamais passer par un dépôt ni
par une conversation :

```bash
node scripts/vapid-keys.mjs
```

Les trois lignes affichées vont dans les variables d'environnement Vercel :
`PANELFLOW_VAPID_PUBLIC_KEY`, `PANELFLOW_VAPID_PRIVATE_KEY` et
`PANELFLOW_VAPID_SUBJECT` (un `mailto:` par lequel un service de push peut te
joindre s'il a un problème avec tes envois). Sans les deux premières,
`/api/push/key` répond `503` et le bouton 🔔 ne s'affiche pas du tout.

**Génère-la une fois.** Chaque abonnement enregistré par un navigateur est lié à
la clé publique du moment : en changer invalide silencieusement tous les
abonnements déjà pris, et personne ne reçoit plus rien sans qu'aucune erreur
n'apparaisse nulle part.

Pour vérifier la chaîne sans attendre qu'un chapitre sorte, une fois le 🔔
activé dans le navigateur : le bouton 📨 apparaît à côté dans l'en-tête du web
app, et le résultat s'écrit à côté de « Check for new chapters ». En ligne de
commande, c'est la même route :

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" https://<ton-déploiement>/api/push/test
```

La route envoie une notification de démonstration aux navigateurs de ton propre
compte et renvoie `{sent, dropped, failed, subscriptions}`. C'est le seul moyen
de savoir que les clés sont bonnes : une dérivation fausse ne remonte aucune
erreur — le service de push accepte le corps chiffré et le navigateur le jette
en silence. `503` = pas de clés VAPID, `409` = aucun navigateur enregistré,
`dropped` = un abonnement que le navigateur a jeté (sa ligne vient d'être
supprimée), `failed` = un service de push en panne, à réessayer plus tard.

Le push ne marche qu'en HTTPS (Vercel l'est) et il est propre au web app —
l'extension Chrome n'a pas d'API push, et n'en a pas besoin puisqu'elle ne
tourne que quand le navigateur est ouvert.

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

La base locale est dans `backend/data/panelflow.db`.
`backend/scripts/migrate-to-turso.mjs` la recopie vers Turso sans dépendre de
`sqlite3` ni de la CLI `turso` — il parle aux deux bases par les deux points
d'entrée libsql décrits plus bas.

Il lui faut les deux identifiants Turso dans `backend/.env` (gitignoré) :

```
TURSO_DATABASE_URL=libsql://panelflow-<org>.turso.io
TURSO_AUTH_TOKEN=...
```

**`vercel env pull` ne les fournira pas.** Les variables marquées sensibles dans
Vercel sont en écriture seule : la CLI les renvoie sous forme de chaînes vides.
Les valeurs se reprennent sur le tableau de bord Turso — l'URL est affichée sur
la page de la base, et un nouveau token peut être créé sans invalider les
précédents.

Puis, depuis `backend/` :

```bash
node scripts/migrate-to-turso.mjs
```

Il affiche, table par table, ce qu'il y a en local, ce qui existe déjà à
distance et ce qu'il insérerait — **sans rien écrire**. Ajouter `--commit` pour
que ça parte pour de bon.

Trois propriétés à connaître :

- **Le fichier local n'est jamais ouvert.** Il est copié dans un fichier
  temporaire et c'est la copie qui est lue, puis supprimée. Le serveur de dev
  peut donc tourner en même temps, et un bug du script ne peut pas atteindre
  l'original.
- **Relancer est sans danger.** Les lignes sont appariées par clé primaire et
  celles déjà présentes ne sont pas touchées : le distant gagne toujours. Une
  interruption à mi-chemin se rattrape en relançant.
- **L'ordre des tables suit les clés étrangères** (`users`, puis `library`,
  puis `progress` et `trackers`). Turso les fait respecter, contrairement à un
  fichier local où elles sont désactivées par défaut.

Le schéma distant doit exister avant : il est créé par les migrations au premier
appel de l'API déployée. Si le script dit qu'une table est absente, appeler
`/api/health` une fois et réessayer.

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
