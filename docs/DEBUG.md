# Trouver la source d'un bug

Ce que fait ce fichier : transformer « ça ne marche pas » en un nom de fichier,
sans relire la chaîne d'appels.

Le problème que ça résout est réel et structurel. PanelFlow est un cœur partagé
derrière quatre façades : une action du lecteur traverse une interface, un hub,
le cœur, une requête HTTP, une route et la base. À chaque étage, un `catch`
transformait l'échec en une **phrase pour le lecteur** — « connecte à nouveau ce
tracker » — ce qui est le bon message à afficher, et absolument tout ce qui
restait. Ni la pile, ni le type de message, ni l'URL qui a répondu 502.

La phrase n'a pas changé. Ce qui l'accompagne, oui.

---

## 1. Les trois champs à connaître

Toute erreur qui traverse le cœur porte maintenant sa provenance, posée par la
frame la plus **interne** qui la connaît (une frame plus haute ne réécrit jamais
un champ déjà rempli — sinon l'étiquette du hub écrase l'endpoint qui a
réellement cassé) :

| Champ | Ce qu'il dit | Exemple |
|---|---|---|
| `err.pfOrigin` | l'opération qui a échoué | `apiFetch` |
| `err.pfPath` | la requête, quand il y en avait une | `/api/trackers/anilist/pull` |
| `err.pfStatus` | ce qu'elle a répondu | `502` |
| `err.pfRef` | la référence que le serveur a mise dans son propre log | `k3f9az` |

Et toute réponse du hub qui échoue porte `failedAt` à côté de `error` :

```js
{ error: "connecte à nouveau ce tracker", failedAt: "hub:trackerPull", ref: "k3f9az" }
```

`error` est inchangé — c'est ce que les clients affichent. `failedAt` nomme
lequel des ~50 messages du hub est mort, ce que la chaîne ne disait jamais.

---

## 2. Les goulots

Tout passe par une poignée d'endroits. Un point d'arrêt dans l'un d'eux attrape
beaucoup plus qu'un point d'arrêt dans un handler.

| Goulot | Fichier | Ce qui y transite |
|---|---|---|
| **Le hub** | `shared/panelflow-core.js` → `createHub` | toutes les actions de l'extension, d'iOS et d'Android |
| **`apiFetch`** | `shared/panelflow-core.js` | tous les appels API de ces trois clients |
| **`unwrap`** | `web/app.js` | tous les appels API du site |
| **Le middleware d'erreur** | `backend/src/index.js`, tout en bas | toute exception non étiquetée des ~100 routes |
| **`send`** | `extension/send.js` | toutes les réponses du worker vers popup / options / welcome |
| **`send`** | `mobile/www/bridge.js` | idem, côté téléphone |

Les content scripts (`reader.js`, `library-modal.js`) ne peuvent pas charger
`send.js` — ils ont chacun leur `send` local, avec la même ligne dedans.

### Le filet en dessous

Un handler `async` branché sur un bouton dont le corps lève produit **une
promesse rejetée que personne n'attend** : le clic ne fait rien, aucun `catch`
ne tourne, la console reste vide. Il y en a une quarantaine dans le dépôt, et
les emballer un par un est une bataille qu'on perd à la première ligne ajoutée.

Un écouteur `unhandledrejection` par contexte long les nomme tous :

| Contexte | Fichier |
|---|---|
| Service worker MV3 | `extension/background.js` (passe par `diag.report`, donc va dans le `trail`) |
| Popup, options, welcome | `extension/send.js` (les trois pages qui le chargent) |
| Site web | `web/app.js` |
| Écran du téléphone | `mobile/www/app.js` |

Ça ne répare rien. Ça transforme « le bouton est cassé » en une ligne qui nomme
ce qui a levé.

---

## 3. Selon ce qu'on observe

### Un message d'erreur s'affiche, on ne sait pas d'où il vient

Ouvrir la console **du bon contexte** — c'est la moitié du problème :

| Client | Où est la console |
|---|---|
| Extension, page de chapitre | DevTools de l'onglet (content scripts) |
| Extension, popup / options | clic droit sur le popup → Inspecter |
| Extension, service worker | `chrome://extensions` → *Inspect views: service worker* |
| Site web | DevTools ordinaires |
| Téléphone | rien de lisible sur l'appareil — voir §4 |

La ligne à chercher a toujours la même forme :

```
[panelflow] hub:trackerPull failed in apiFetch at /api/trackers/anilist/pull → 502: …
```

Elle nomme le message, l'opération, la requête et le code. C'est le fichier à
ouvrir.

### La console était fermée quand ça a cassé

C'est le cas normal sur un service worker MV3 ou une WebView hors-écran : le
contexte s'endort, et la console est vide quand on pense à l'ouvrir. Les
quarante dernières défaillances sont gardées :

```js
PanelFlowCore.diag.trail()
```

À taper dans la console du service worker (ou à faire coller par le testeur).
Chaque entrée porte `at`, `scope`, `origin`, `path`, `status`, `message`.

### Le serveur a répondu « internal error »

Ce message ne dit rien — c'est le but, il part chez un inconnu. Mais la réponse
porte maintenant un `ref`, et le log serveur porte la même :

```
[500 k3f9az] POST /api/library/42/migrate  Error: …
```

Donc : récupérer le `ref` (visible dans l'onglet réseau, dans le `trail()`, ou
dans la réponse du hub), puis le chercher dans le log Vercel. On atterrit sur la
pile, pas sur cent handlers.

Un 4xx n'a pas de `ref` et n'en a pas besoin : c'est un refus délibéré, et son
message *est* la cause (« invalid url », « connect that tracker first »).

### Le mode lecture ne se propose pas sur un site

Presque jamais un bug de code. Dans l'ordre :

1. Le site est-il dans `shared/detection-rules.json` ? Sinon la détection est
   purement heuristique — c'est prévu, elle marche sur des sites inconnus, mais
   moins bien.
2. L'extension a-t-elle la permission sur cette origine ? Le manifeste ne nomme
   que les domaines du fichier de règles ; le reste se demande site par site
   depuis le popup.
3. Le score : `detect.js` §*scoring*. Un `knownEngine` vaut 40, délibérément
   **sous** le seuil.
4. Sur téléphone seulement : un script injecté est peut-être mort. Voir §4.
5. Depuis ce poste : un tiers des sites de scan sont bloqués par l'antivirus ou
   Cloudflare. Ne pas conclure « le site est mort » d'ici.

### Une série apparaît deux fois

C'est le mode de défaillance que `shared/series-match.js` combat. Deux couches,
deux questions différentes : `seriesKey(url)` pour le même site (déterministe,
fusionne en silence), la comparaison de titres pour deux sites différents (une
devinette, qui demande toujours). Un doublon sur le **même** site est un bug de
`seriesKey` ; entre deux sites, c'est un seuil.

### Les quatre clients ne sont pas d'accord

Si l'extension et le site affichent la même étagère dans deux ordres différents,
le bug n'est pas dans l'un des deux : c'est qu'un des deux a cessé d'appeler
`shared/library-view.js` et trie chez lui. `backend/test/library-view.test.js`
vérifie exactement ça.

Plus généralement, un désaccord entre façades se cherche dans `shared/`, ou dans
une copie générée devenue périmée :

```bash
npm run sync:shared -- --check
```

### Le test échoue mais le code a l'air juste

Vérifier d'abord que la règle testée est bien **extraite du fichier livré**
(`new Function(...)`) et non recopiée dans le test. Une deuxième copie de
l'arithmétique reste verte pendant que la vraie pourrit.

---

## 4. Sur téléphone

Il n'y a pas de console lisible, donc l'échec doit venir à l'écran tout seul.
`mobile/inject/report-failure.js` est injecté **avant** tous les autres scripts
et ne dépend de rien (pas même du shim `chrome.*`, qui est lui-même un des
fichiers qui peuvent mourir). Quand une coque native attrape l'exception d'un
script injecté, elle l'appelle, et une ligne s'affiche sur la page.

Sans ça, le symptôme observable de `detect.js` mort est *une pastille qui
n'apparaît pas* — ce qui remonte sous la forme « ça ne marche pas sur ce site »,
et ne suffit pas pour agir.

### Quand l'écran reste bloqué 45 secondes puis dit « timed out »

C'est le natif qui a jeté l'enveloppe, pas le worker qui a été lent.
`mobile/www/bridge.js` tient chaque requête sur un minuteur de 45 s ; si la
coque native laisse tomber le message avant qu'il arrive au worker, le seul
message est ce délai, et il accuse le mauvais étage.

Les trois endroits où une enveloppe peut être jetée nomment maintenant ce qu'ils
jettent, des deux côtés (`WorkerHost.kt`, `WorkerHost.swift`) : un JSON
illisible, une enveloppe sans `msg`, une réponse dont l'id n'attend plus
personne. Où les lire :

| Plateforme | Commande |
|---|---|
| Android | `adb logcat -s panelflow` |
| iOS | Console.app, filtré sur `panelflow` |

C'est la seule fenêtre sur cette couche : elle ne compile sur aucun poste de
développement ici, et aucun test ne l'exécute — `backend/test/traceability.test.js`
ne peut que vérifier que les six points de journal sont toujours là, et que les
deux coques restent symétriques.

---

## 5. Ajouter de la traçabilité à du code neuf

Le contrat tient en deux appels.

**Une opération qui peut échouer et qui sait quelque chose d'utile :**

```js
throw diag.tag(err, 'monOperation', { pfPath: url, pfStatus: resp.status });
```

**Un endroit qui rattrape et qui ne relance pas :**

```js
const seen = diag.report('scope:quelquechose', err);
return { error: seen.message, failedAt: seen.scope };
```

Deux règles :

- **Ne jamais changer `error`.** C'est la phrase du lecteur, et elle est écrite
  pour lui. La provenance voyage à côté, pas dedans.
- **Ne pas rapporter deux fois.** Un `catch` qui relance étiquette (`tag`) ; seul
  celui qui absorbe rapporte (`report`). Sinon un échec écrit quatre lignes et
  on cherche laquelle est la vraie.

Un `catch {}` silencieux reste parfaitement légitime quand l'échec **est** la
réponse — un `JSON.parse` sur un corps qui n'est pas du JSON, un cache froid,
un site injoignable dont on sait qu'on réessaiera. La règle n'est pas « ne rien
avaler », c'est **« ne pas avaler ce qu'on ne s'attendait pas à avaler »**.
