# Prendre PanelFlow en main

Pour quelqu'un qui ouvre ce dépôt aujourd'hui. Ce fichier ne raconte pas
*pourquoi* les choses sont comme elles sont — c'est le travail de
[`ARCHITECTURE.md`](ARCHITECTURE.md) — il dit **où elles sont**, dans quel ordre
les lire, et quel fichier ouvrir quand on veut changer quelque chose.

Lecture recommandée, dans l'ordre : ce fichier (15 min), puis
[`ARCHITECTURE.md`](ARCHITECTURE.md) (45 min), puis
[`DEBUG.md`](DEBUG.md) le jour où quelque chose casse.

---

## 1. Le projet en cinq lignes

PanelFlow est un **navigateur avec un mode lecture**, pas un catalogue. Le
lecteur va sur le site de scan qu'il utilise déjà ; PanelFlow détecte que la
page est un chapitre, propose une pastille « 📖 Reader Mode », et remplace la
page par un lecteur propre. Sa bibliothèque, sa progression et ses alertes de
nouveaux chapitres le suivent d'un appareil à l'autre.

**Le pari architectural, et c'est celui qui explique la forme du dépôt :** le
moteur de détection, le lecteur et toutes les règles de bibliothèque sont du
**JavaScript ordinaire, écrit une fois**. Chrome les charge comme content
scripts ; iOS et Android injectent *les mêmes fichiers* dans leurs WebViews.
Un moteur, quatre plateformes.

---

## 2. La carte

Cinq façades, un cœur. Les flèches vont toujours dans le même sens : une
interface parle au **hub**, le hub parle au **cœur**, le cœur parle à l'**API**.

```
     extension/popup     web/app.js      mobile/www/app.js     ios/  android/
     extension/content        │                  │                 │
            │                 │                  │                 │
            │  sendMessage    │  fetch           │  bridge         │  bridge
            ▼                 │                  ▼                 ▼
    ┌───────────────┐         │        ┌──────────────────┐  ┌──────────────┐
    │ background.js │         │        │ mobile/www/      │  │ WorkerHost   │
    │  (MV3 worker) │         │        │   worker.js      │  │ .kt / .swift │
    └───────┬───────┘         │        └────────┬─────────┘  └──────┬───────┘
            │                 │                 │                   │
            └─────────────────┼─────────────────┴───────────────────┘
                              │
                    createHub ▼  ← shared/panelflow-core.js
                    createCore
                              │  apiFetch
                              ▼
                      backend/src/index.js
                      backend/src/routes/*.js
                      backend/src/db.js  (SQLite / Turso)
```

Le web est le seul client qui ne passe pas par le hub : il parle directement à
l'API avec son propre `api()` (`web/app.js`), parce qu'il est déjà servi par le
backend et n'a pas de worker à traverser.

### Les fichiers qui comptent vraiment

Dix fichiers portent l'essentiel. Le reste en dépend.

| Fichier | Ce qu'il décide |
|---|---|
| `shared/panelflow-core.js` | **Le cœur.** Ce qu'est une bibliothèque : ajouter, dédupliquer, migrer une série d'un site à l'autre, avancer une progression, décider qu'un chapitre est nouveau. `createCore` + `createHub`. |
| `shared/series-match.js` | Est-ce que ces deux entrées sont **le même livre** ? `seriesKey` (même site, déterministe) et la comparaison de titres (sites différents, une devinette qui ne fusionne jamais toute seule). |
| `shared/site-rules.js` | **Quel site est-ce ?** Une fonction pure sur les règles + un DOM ou une chaîne. Le content script, le worker mobile et le serveur y répondent pareil. |
| `shared/detection-rules.json` | Les règles elles-mêmes : moteurs (thèmes CMS), domaines, sélecteurs, bruit de titre. Servi par `/api/rules`, mis en cache 6 h côté client. **Corriger un site = éditer ce JSON**, pas republier l'extension. |
| `shared/folders.js` | Les cinq statuts (`reading`, `paused`, `plan`, `completed`, `dropped`) et `folderStatus()`. Aucune autre liste n'existe. |
| `shared/library-view.js` | L'ordre et le filtrage d'une étagère. Pur : des lignes entrent, des lignes sortent. |
| `extension/content/detect.js` | La détection sur une page vivante : score heuristique, pastille opt-in. Ne bascule **jamais** tout seul. |
| `extension/content/reader.js` | Le lecteur : cinq modes, zoom sans retour en place, zones de tap, préchargement, hors-ligne. |
| `backend/src/index.js` | Le montage de l'API : quelle route est derrière `requireAuth`, laquelle ne l'est pas et pourquoi. **La table des matières du serveur.** |
| `backend/src/db.js` | Le schéma et les migrations. |

### Points d'entrée par façade

| Façade | On commence par | Puis |
|---|---|---|
| Backend | `backend/src/index.js` | `routes/library.js`, `db.js` |
| Extension Chrome | `extension/manifest.json` (ordre de chargement) | `background.js`, `content/detect.js` |
| Site web | `web/index.html` | `web/app.js` (2 800 lignes, mais sectionnées : `grep -n "^/\* ----" web/app.js`) |
| Coque mobile | `mobile/www/worker.html` | `mobile/www/worker.js`, `mobile/inject/chrome-shim.js` |
| iOS | `ios/Sources/PageScripts.swift` | `WorkerHost.swift`, `Bridge.swift` |
| Android | `android/.../PageScripts.kt` | `WorkerHost.kt`, `NativeBridge.kt` |

Les gros fichiers sont tous découpés par bannières de section. Pour en avoir le
sommaire sans les ouvrir :

```bash
grep -n '^\s*\(//\|/\*\) ---' extension/content/reader.js
```

---

## 3. Le chemin d'une action, de bout en bout

Le lecteur clique « Ajouter à la bibliothèque » dans la modale d'une page de
chapitre. Suivre ce chemin une fois vaut mieux que lire dix fichiers :

1. `extension/content/library-modal.js:577` — `send({ type: 'addToLibrary', entry })`
2. `chrome.runtime.sendMessage` → `extension/background.js`, qui a monté le hub
3. `shared/panelflow-core.js` → `createHub`, `case 'addToLibrary'`
4. `createCore` → `addToLibrary()` : nettoie le titre, cherche un doublon
   (`findEntry`), écrit dans `chrome.storage.local`
5. Si un jeton existe → `apiFetch('/api/library', { method: 'POST' })`
6. `backend/src/index.js` → `app.use('/api/library', requireAuth, libraryRouter)`
7. `backend/src/routes/library.js` → `backend/src/db.js`

Sept sauts, et **les quatre du milieu sont les mêmes sur les quatre
plateformes**. C'est tout l'intérêt du montage.

---

## 4. Ce qu'on n'édite jamais à la main

Ces fichiers sont **générés**. Les modifier fonctionne jusqu'au prochain
`npm run sync:shared`, qui les écrase — et le test `shared sources are in sync`
échoue en attendant. Un hook `PreToolUse` refuse déjà l'édition et nomme la
source ; ceci est la même liste, pour un humain.

| Généré | Source | Générateur |
|---|---|---|
| `extension/shared/*`, `mobile/www/shared/*`, `web/shared/*` | `shared/*` | `scripts/sync-shared.mjs` |
| `extension/rules/adblock.json`, `ios/Resources/blocker-rules.json` | `shared/adblock-list.json` | `scripts/build-adblock.mjs` |
| `extension/_locales/*`, `web/messages.js`, `mobile/www/messages.js` | `shared/_locales/en\|fr/messages.json` | `scripts/build-messages.mjs` |
| `host_permissions` / `matches` dans `extension/manifest.json` | `shared/detection-rules.json` | `scripts/sync-shared.mjs` |
| `ios/Generated/*` | `extension/content/*` | `ios/Scripts/bundle-assets.sh` |

**Le piège classique :** `shared/panelflow-core.js` et
`extension/shared/panelflow-core.js` ont le même nom. Le second est une copie.

**Le second piège :** `backend/src/panelflow-core.js`, `series-match.js`,
`site-rules.js`, `compat.js` et `folders.js` sont des **façades ESM écrites à la
main**. Elles ré-exportent les globales publiées par les IIFE de `shared/`. Un
nouvel export dans `shared/` n'existe pour les tests que si on l'ajoute là
aussi, à la main.

---

## 5. Où mettre un changement

| Je veux… | J'ouvre |
|---|---|
| Faire marcher un site qui ne détecte pas | `shared/detection-rules.json` (jamais du code) |
| Changer une règle de bibliothèque, de doublon ou de progression | `shared/panelflow-core.js` — et nulle part ailleurs |
| Changer l'ordre ou le filtrage de l'étagère | `shared/library-view.js` |
| Ajouter un statut ou toucher aux dossiers | `shared/folders.js` |
| Ajouter une route API | `backend/src/routes/*.js` + le montage dans `index.js` |
| Toucher au schéma | `backend/src/db.js` (une migration, jamais une colonne posée à la main) |
| Ajouter une phrase visible | `shared/_locales/en/messages.json` **et** `fr` |
| Ajouter une couleur | `shared/theme.css` — la seule endroit où une couleur est écrite |
| Ajouter un message au hub | `createHub` dans `shared/panelflow-core.js` |
| Bloquer un domaine publicitaire | `shared/adblock-list.json` |

Règle générale : **si deux façades doivent être d'accord, la réponse est dans
`shared/`.** Si une seule façade est concernée, elle est chez elle.

---

## 6. Faire tourner et tester

```bash
npm install          # à la racine — le dépôt est un workspace npm
npm test             # la suite complète (~90 s, 1 171 tests)
npm start            # backend sur :8787, qui sert aussi le site web
npm run sync:shared  # régénère les copies (le hook le fait déjà après chaque édition)
```

`npm test` sans `npm install` échoue avec une centaine de lignes `test failed`
sans cause visible : c'est le module manquant, pas le code.

Un test seul :

```bash
node --test backend/test/library.test.js
```

**Ce que les tests couvrent :** l'API en process avec une base temporaire, plus
le code livré des clients — `detect.js` et `reader.js` sont des IIFE sans
exports, donc la règle testée est **extraite du fichier livré** avec
`new Function(...)`, jamais réécrite dans le test. Modèle :
`backend/test/spa-navigation.test.js`.

**Ce que les tests ne couvrent pas :** rien de mobile ne compile ici (ni Xcode,
ni Android SDK), et un tiers des sites de scan sont bloqués depuis ce poste.
Une détection qui échoue localement n'est pas la preuve qu'un site est mort.

---

## 7. Les invariants, en une page

Ce sont ceux qui cassent **silencieusement** quand on les ignore. La version
longue est en §0 de [`roadmap.md`](roadmap.md).

1. **`shared/` est la source.** Les copies sont générées et font partie du commit.
2. **Les façades ESM du backend sont manuelles.** Un export ajouté d'un côté doit
   être ajouté de l'autre.
3. **Ordre de chargement :** `series-match.js` puis `site-rules.js` **avant**
   `detect.js` / `compat.js`, dans les cinq clients. `backend/test/site-rules.test.js`
   échoue si un client en oublie un.
4. **Une règle testée est extraite du fichier livré**, jamais recopiée.
5. **Jamais d'écriture sur un compte de tracker en production** (AniList / MAL) :
   c'est irréversible sans sauvegarde.
6. **Le mode lecture ne s'active jamais tout seul.** Il est opt-in par
   activation, ce qui fait qu'une extraction ratée coûte un onglet normal et
   rien d'autre.
