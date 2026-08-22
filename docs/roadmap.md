# Feuille de route PanelFlow

**But :** que PanelFlow soit un concurrent réel de MangaPin, et qu'il soit *utilisable
par quelqu'un d'autre que son auteur* — j'envoie un lien ou un zip, un ami installe,
ça marche sans que je sois derrière lui.

Ce document est écrit pour être exécuté par Claude, tâche par tâche. Chaque tâche
porte un identifiant stable (`A1`, `C3`…) : demander « fais A2 » suffit.

Dernière mise à jour : **22/08/2026** — 1048 tests, tous verts.

---

## 0. Ce qu'il faut savoir avant de toucher au dépôt

Ces règles ne sont pas des préférences, ce sont les invariants qui cassent
silencieusement quand on les ignore. À relire au début de chaque tâche.

### 0.1 Fichiers générés

`shared/*` sont les **sources**. Sont **générés** et ne doivent jamais être édités
à la main :

- `extension/shared/*`, `mobile/www/shared/*`, `web/shared/*`
- `extension/rules/adblock.json`, `ios/Resources/blocker-rules.json`
- `extension/_locales/*` (copie verbatim), `web/messages.js`, `mobile/www/messages.js`

Les phrases ont leur source dans `shared/_locales/en|fr/messages.json`. Chrome
lit `_locales/` lui-même et exige du JSON à la racine de l'extension ; le site et
le téléphone ne peuvent pas aller le chercher à temps (iOS charge sa coque en
`file://`, où une origine opaque refuse `fetch`), donc `scripts/build-messages.mjs`
leur en fabrique un `<script>` bloquant.

Un hook `PostToolUse` lance `npm run sync:shared` après chaque édition de `shared/`
et annonce les copies réécrites. **Elles font partie du commit.**

### 0.2 Les deux façades ESM

`backend/src/panelflow-core.js`, `backend/src/site-rules.js` et
`backend/src/compat.js` sont **écrits à la main** : ils ré-exportent les globales
que publient les IIFE de `shared/`. Un nouvel export dans `shared/` n'existe pour
les tests que s'il est ajouté là aussi, à la main.

### 0.3 Ordre de chargement

`shared/series-match.js` puis `shared/site-rules.js` **avant** `detect.js` /
`compat.js`, dans **tous** les clients :

| Client | Fichier qui déclare l'ordre |
| --- | --- |
| Extension | `extension/manifest.json` |
| Web mobile | `mobile/www/worker.html` |
| Android | `android/app/src/main/java/dev/panelflow/PageScripts.kt` |
| iOS | `ios/Sources/PageScripts.swift` |
| Serveur | `backend/src/compat.js` |

`backend/test/site-rules.test.js` échoue si un client oublie un fichier. Les coques
téléphone enveloppent chaque script injecté dans son propre `try/catch` : d'où les
lectures défensives `window.PanelFlowSites?.…` dans le code partagé.

### 0.4 Comment on teste du code livré

`detect.js` et `reader.js` sont des IIFE navigateur sans exports. La règle testée
est **extraite du fichier livré** avec `new Function(...)`, jamais réécrite dans le
test — une deuxième copie de l'arithmétique resterait verte pendant que la vraie
pourrit. Modèle : `backend/test/spa-navigation.test.js`, `chapter-wheel-series.test.js`.

### 0.5 Ce qu'on ne touche pas

- **Jamais** la progression ni les comptes en production, ni ceux des trackers
  (AniList/MAL). Une écriture sur un compte tiers est irréversible sans sauvegarde.
- **Jamais** de code copié de MangaPin. On vise la parité fonctionnelle, pas la copie.
- Les secrets ne passent pas par la conversation ni par un commit.

### 0.6 Contraintes de la machine

- Pas de toolchain mobile ici : ni Xcode, ni Android SDK. Les coques ne peuvent pas
  être compilées sur ce poste — c'est le sujet de la **phase C**.
- Un tiers des sites de scan sont bloqués depuis ce poste (Kaspersky, Cloudflare).
  Voir `docs/` et la note mémoire : ne pas conclure « le site est mort » depuis ici.

---

## 1. État des lieux

### Ce qui est fini et prouvé

| Domaine | État |
| --- | --- |
| Détection + lecteur (5 modes, zoom, tap zones) | ✅ testé |
| Bibliothèque, progression, reprise de lecture | ✅ testé |
| Hors-ligne (CBZ, IndexedDB, tout-ou-rien) | ✅ testé bout en bout |
| Adblock + garde anti-popup | ✅ une liste, trois cibles |
| Veilleur serveur + Web Push | ✅ en production |
| Statistiques (12 compteurs + graphe) | ✅ au-dessus de MangaPin |
| MangaDex : numéro, navigation SPA, pages | ✅ corrigé le 16/08 (`97a9c54`) |
| Titres/chapitres faux (§9.1 du comparatif) | ✅ corrigé |
| Export MAL qui déclarait des chapitres non lus (§9.2) | ✅ corrigé |

### Ce qui manque pour que « ça marche chez un ami »

1. ~~Aucun **paquet distribuable** : pas de zip, pas de mode d'emploi
   d'installation.~~ ✅ **A3, 19/08/2026** : `npm run pack` et
   `docs/installation.md` — restent les trois captures d'écran.
2. ~~L'extension demande `<all_urls>` — l'écran d'installation dit « lire et modifier
   toutes vos données sur tous les sites ».~~ ✅ **A2, 19/08/2026** : le manifeste
   nomme les 50 sites du fichier de règles ; le reste se demande site par site.
3. Les **coques téléphone n'ont jamais été compilées**. Il n'existe aucun APK.
4. Les **trackers n'ont jamais tourné sur un vrai fournisseur** : aucun identifiant
   OAuth configuré, donc le code du callback n'a jamais été exécuté en vrai.
5. Le domaine est en `*.vercel.app`, que les antivirus signalent par réputation.
6. ~~Les titres restent sales (`Blue Box Scan VF / FR Gratuit (Webtoon)`).~~
   ✅ **A1, 19/08/2026** : nettoyage piloté par `shared/detection-rules.json`.

---

## 2. Phase A — « le zip marche chez un inconnu » 🔴 bloquant beta

C'est la phase à finir avant d'envoyer quoi que ce soit à qui que ce soit.

### A1 — Nettoyer les titres (§9.3 du comparatif) ✅ fait (19/08/2026)

**Pourquoi.** Le titre est pris tel quel dans `og:title`/`<title>`. En base et sur
chaque carte on lit `Blue Box Scan VF / FR Gratuit (Webtoon)`. Ça déborde des cartes,
ça pollue les trois exports, ça s'affiche dans la migration de site, et c'est la
première chose qu'un testeur voit.

**Fichiers.** `shared/panelflow-core.js` (`cleanTitle`, l. 373), qui ne coupe
aujourd'hui que la ponctuation aux extrémités.

**Travail.**
- Retirer les suffixes SEO en fin de titre : `Scan VF`, `VF`, `FR`, `Gratuit`,
  `Webtoon`, `Manga`, `Lecture en ligne`, `Read online`, `- Nom du site`,
  et les parenthèses finales qui ne contiennent que ces mots.
- La règle doit être **pilotée par les données** (une liste dans
  `shared/detection-rules.json`, section globale + surcharge par domaine), pas une
  regex figée dans le code : les sites changent sans qu'on republie l'extension.
- Ne jamais renvoyer une chaîne vide : si le nettoyage vide le titre, garder l'original.

**Critère d'acceptation.** Sur sushiscan.fr, la carte affiche `Blue Box`, pas
`Blue Box Scan VF / FR Gratuit (Webtoon)`. Un titre déjà propre est inchangé.

**Tests.** `backend/test/clean-title.test.js` : les cas réels observés, un titre
propre, un titre qui ne survit pas au nettoyage (retour à l'original), une règle
par domaine, et une règle mal écrite qui ne casse que son site.

**Fait le 19/08/2026.** 13 tests dans `backend/test/clean-title.test.js`, suite
complète à 923.

Ce qui existait déjà : `displayTitle()` (`shared/series-match.js`) coupait déjà
le mobilier SEO, avec la bonne prudence — **deux mots minimum**, jamais un seul,
parce que « Sword Art Online », « Manga Dogs » et « Free! » sont de vrais titres
faits de mots de la liste. Sa doc citait littéralement le critère d'acceptation
ci-dessus. Ce qui manquait, c'était tout le reste :

- **La liste est devenue une donnée.** Section `titleNoise` (`words` / `keep`) en
  tête de `shared/detection-rules.json`, plus une surcharge par domaine
  (`domains["*.sushiscan.fr"].titleNoise`). Le fichier arrive chez tous les
  clients avec un TTL de 6 h : un site qui renomme sa queue coûte une ligne de
  JSON, pas une republication de l'extension. `keep` fait l'inverse — il rend un
  mot à un site précis sans affaiblir la règle pour les 49 autres.
- **`cleanTitle` (l. 373) ne coupait que la ponctuation.** Il délègue maintenant
  à `displayTitle`, prend `{ host, rules }`, et garde son double filet : la
  chaîne d'origine si le nettoyage vide tout.
- **Le nettoyage se fait à l'entrée**, dans `addToLibrary`, et **uniquement à la
  création** (`!existing`). Ré-ajouter est aussi la façon dont la modale
  d'édition enregistre : quelqu'un qui a retapé « Manga Dogs » par-dessus notre
  proposition ne doit pas se la faire reprendre au prochain Enregistrer.
- **Aucune requête sur ce chemin.** La première version appelait `getRules()`,
  ce qui a fait tomber le test « everything works signed out, and nothing is sent
  anywhere » — et il avait raison. Un `storedRules()` a été ajouté à côté :
  il lit le cache que le détecteur remplit déjà, sans TTL et sans réseau. Des
  règles un peu vieilles, c'est une liste de mots un peu généreuse ; une requête
  envoyée pour les rafraîchir, c'est une promesse cassée.
- **Plus personne ne garde sa copie privée.** `extension/content/detect.js`
  portait sa propre regex de quatre mots SEO, figée dans un fichier qui ne change
  qu'à la republication : supprimée. `backend/src/routes/meta.js` et
  `routes/search.js` passent maintenant l'hôte et le fichier de règles, pour que
  le titre gratté par le serveur et le même titre lu dans le DOM par l'extension
  s'écrivent pareil — sinon la même série cesse de se ressembler à elle-même.

`detection-rules.json` passe en version 6.

---

### A2 — Réduire la surface d'injection : sortir de `<all_urls>` ✅ fait (19/08/2026)

**Pourquoi.** `extension/manifest.json` injecte cinq scripts sur **tous les sites** —
la banque, la boîte mail, tout. MangaPin déclare ses sites un par un. C'est le seul
point où PanelFlow est *plus* intrusif que le concurrent, et c'est exactement ce
qu'un ami regarde avant d'installer un zip.

**Fichiers.** `extension/manifest.json`, `extension/background.js`,
`shared/detection-rules.json`, `extension/popup/popup.js`.

**Travail.**
- `content_scripts` déclare uniquement les domaines connus du fichier de règles.
- Ajouter `optional_host_permissions: ["<all_urls>"]` et un bouton « Activer
  PanelFlow sur ce site » dans le popup, qui demande la permission pour l'origine
  courante puis injecte via `chrome.scripting.executeScript`.
- Le worker réinjecte à la volée sur les origines déjà accordées
  (`chrome.permissions.getAll()` au démarrage).
- Conserver `declarativeNetRequest` tel quel : il ne dépend pas de l'injection.

**Critère d'acceptation.** L'écran d'installation ne dit plus « toutes vos données
sur tous les sites ». Sur un site inconnu, le popup propose l'activation en un clic
et la détection démarre sans rechargement.

**Tests.** Un test qui lit le manifeste et échoue si `<all_urls>` revient dans
`content_scripts` ou `host_permissions`; un test qui vérifie que la liste des
`matches` est bien dérivée de `shared/detection-rules.json` (pas de dérive).

**Note.** Tâche structurante : à faire **avant** A3, sinon le zip est à refaire.

**Fait le 19/08/2026.** 13 tests dans `backend/test/host-access.test.js`, 3 de plus
dans `popup-page-state.test.js` et 4 dans `options-page.test.js` ; suite complète
à 943.

L'écran d'installation ne dit plus « toutes vos données sur tous les sites » : il
nomme les 50 sites que `shared/detection-rules.json` connaît, et rien d'autre.

- **`host_permissions` aussi, pas seulement `content_scripts`.** La consigne
  ci-dessus ne parlait que des `content_scripts`, mais c'est `host_permissions`
  qui écrit la phrase du dialogue d'installation — et cette phrase est tout le
  « Pourquoi » de la tâche. Les deux ont été réduits à la même liste.
- **Le manifeste est un fichier généré.** `scripts/sync-shared.mjs` en fabrique
  les listes d'hôtes depuis `shared/detection-rules.json` (`hostMatches()`,
  `manifestHosts()`), au même titre que les copies de `shared/` — donc
  `npm run sync:shared -- --check` échoue sur la dérive, et un domaine ajouté aux
  règles sans le manifeste ne peut plus passer. C'est une réécriture *textuelle*
  et pas un `JSON.stringify` : le manifeste est mis en forme à la main, et le
  re-sérialiser réécrirait chaque ligne d'un fichier dont les diffs se lisent.
  `*://*.exemple.com/*` couvre l'apex **et** les sous-domaines, pour la même
  raison que les clés du fichier de règles s'écrivent `*.exemple.com` : un site
  qui passe en `ww6.` du jour au lendemain.
- **L'entrée du relais est laissée tranquille.** `content/site-bridge.js` garde
  ses deux origines fixes (le backend, et `localhost:8787`) ; c'est
  `site-bridge.test.js` qui la garde.
- **Le popup a un quatrième état.** Le silence d'un onglet voulait dire « recharge
  la page » ; il veut maintenant dire deux choses. Sur une origine accordée, c'est
  toujours le rechargement ; sur une origine qui ne l'est pas, c'est
  `pageStateUngranted` et un bouton qui demande **cette origine-là** —
  `chrome.permissions.request` n'accepte qu'un vrai clic, ce qui est exactement
  pourquoi ce bouton est là et pas dans le worker.
- **Accorder n'injecte pas.** Chrome donne la permission et s'arrête là. Le worker
  rejoue les entrées `content_scripts` du manifeste sur les origines accordées
  (`syncOptionalSites()`, `chrome.scripting.registerContentScripts` avec
  `persistAcrossSessions`), en les **lisant** du manifeste plutôt qu'en tenant une
  seconde liste : un fichier ajouté au manifeste arrive tout seul sur les sites
  accordés. `world: 'MAIN'` est conservé pour `popup-guard.js` — enregistré dans
  le monde isolé il aurait l'air correct et ne bloquerait rien.
- **Et sans rechargement.** Un enregistrement ne vaut que pour la navigation
  suivante ; l'onglet ouvert est justement celui pour lequel on a cliqué. Le
  message `syncSites` porte le `tabId` et le worker y injecte à la main
  (`injectNow()`). Seule exception, assumée : `popup-guard.js` est en
  `document_start` — il remplace `window.open` avant les scripts de la page, ce
  qui ne se rattrape pas après coup. Il démarre au chargement suivant, qui est de
  toute façon le premier moment où il aurait pu servir.
- **Une case « tous les sites » dans les réglages.** Restreindre `host_permissions`
  casse deux choses réelles : `ensureRefererRule()` (le `modifyHeaders` de
  `declarativeNetRequest` exige la permission sur l'URL demandée) et
  `fetchImageB64()` (le CBZ). Or les images ne sont presque jamais sur le domaine
  du site — asurascans sert depuis `gg.asuracomic.net`, comick.io depuis
  `meo.comick.pictures` — donc sur un hébergeur qui vérifie le `Referer`, la
  couverture tombe en 403 et le téléchargement échoue. D'où une case unique dans
  `options.html` (`#allSites`), branchée sur
  `chrome.permissions.request/remove/contains` : révocable là où elle a été
  accordée, décochée d'elle-même si la demande est refusée, et le texte à côté dit
  ce qu'elle achète. Ce n'est pas un réglage — elle ne passe pas par `patch()` et
  n'a donc rien à faire dans le site ni dans l'app mobile.
- **Pas de double injection.** Accorder `<all_urls>` fait que Chrome ne rapporte
  plus que cette origine-là, celle qui absorbe les 50 autres. Sans précaution,
  chaque site listé recevrait `detect.js`, la modale et le lecteur une deuxième
  fois — deux lecteurs qui se défont l'un l'autre. Les enregistrements portent
  donc un `excludeMatches` égal aux `host_permissions` du manifeste.
- **`declarativeNetRequest` intact.** Les règles de blocage sont des `block` ;
  elles ne dépendent pas de l'injection et n'ont pas bougé.

---

### A3 — Fabriquer le paquet ⚠️ fait (19/08/2026), sauf les captures

**Pourquoi.** Il n'existe aujourd'hui aucune commande qui produise l'artefact à envoyer.

**Fichiers.** `scripts/pack-extension.mjs` (nouveau), `package.json`,
`docs/installation.md` (nouveau).

**Travail.**
- `npm run pack` : lance `sync:shared`, vérifie que `git status` est propre, écrit
  `dist/panelflow-<version>.zip` avec seulement ce qui est livrable (pas de tests,
  pas de `.map`, pas de `node_modules`).
- La commande refuse de produire un zip si `npm test` échoue.
- Elle imprime le SHA-256 du zip — c'est ce qu'on donne avec le lien.
- `docs/installation.md` : trois captures et six lignes — `chrome://extensions`,
  mode développeur, « Charger l'extension non empaquetée », ce que l'écran de
  permissions va dire, et comment vérifier que ça marche (la pastille sur un
  chapitre). Écrit pour quelqu'un qui n'a jamais installé d'extension.

**Critère d'acceptation.** `npm run pack` sur un dépôt propre produit un zip qui
s'installe dans un Chrome vierge et détecte un chapitre sushiscan sans réglage.

**Fait le 19/08/2026.** 7 tests dans `backend/test/pack.test.js` ; suite complète
à 950.

**Il reste les trois captures d'écran.** Elles demandent un Chrome, une main et
une touche Impr. écran ; elles ne peuvent pas être produites depuis le dépôt. Les
trois emplacements sont marqués en commentaire HTML dans `docs/installation.md`,
avec le cadrage exact attendu, et le chemin où déposer le fichier
(`docs/img/install-1-extensions.png`, `-2-charger`, `-3-detecte`). Le texte se
tient sans elles ; il sera meilleur avec.

- **Le zip n'est pas fabriqué depuis le dossier, mais depuis `git ls-files`.**
  Zipper `extension/` à la main embarque ce qui traîne dedans — et ce qui traîne
  dedans, c'est `_metadata/generated_indexed_rulesets/`, que Chrome compile
  lui-même au chargement et sur lequel il refuse d'écrire : « Could not load the
  indexed ruleset », l'extension entière rejetée. C'est de très loin la façon la
  plus probable dont ce zip échoue sur une autre machine. Deux exclusions en
  tout : ce dossier, et `icons/make-icons.cjs` qui dessine les icônes sans en
  être une.
- **Il refuse, il n'avertit pas.** `sync:shared`, puis `git status` propre, puis
  `npm test` — dans cet ordre, parce que si la synchro a bougé le manifeste,
  l'arbre est sale *maintenant* et c'est ça l'information. Pas de `--force` :
  ce serait le drapeau que tout le monde utilise.
- **Les octets sont reproductibles.** Horodatages figés au 01/01/1980, ordre de
  fichiers trié, écriture du ZIP à la main (`zlib.deflateRawSync` + CRC32, une
  centaine de lignes). Sans ça le SHA-256 imprimé change à chaque exécution et
  ne vaut rien à donner avec le lien. Aucune dépendance ajoutée — le dépôt n'en
  a pas hors du backend, et l'outil qui fabrique l'artefact qu'on installe est un
  drôle d'endroit pour prendre la première.
- **Le test remonte des fichiers vers le zip, pas l'inverse.** `pack.test.js` lit
  le manifeste *et* chaque page HTML livrée, résout tous les `src=`/`href=`
  locaux, et vérifie que chacun est dans le lot. Un fichier référencé et absent
  ne donne pas d'erreur lisible chez le testeur : Chrome refuse le dossier, ou
  pire, l'accepte et une page s'ouvre vide. Le zip est ensuite relu par un
  lecteur qui suit les mêmes décalages que Chrome — un writer qui se trompe
  d'offset produit un fichier qui a l'air correct jusqu'à ce que quelque chose
  l'ouvre.
- **`dist/` est ignoré.** Le zip est entièrement décrit par son commit et son
  empreinte ; le committer, ce serait stocker le dépôt deux fois.

---

### A4 — Le premier lancement chez quelqu'un qui n'a pas de compte ✅ fait (19/08/2026)

**Pourquoi.** Tout le parcours a toujours été testé avec un compte existant et un
`chrome.storage` déjà peuplé. Un profil vierge est un chemin non exploré.

**Fichiers.** `extension/popup/popup.js`, `extension/options/`, `web/app.js`.

**Travail.**
- Vérifier qu'un profil neuf, **sans compte**, obtient une bibliothèque locale
  fonctionnelle : détection, lecture, progression, statistiques. Le compte doit
  rester facultatif (free = local, premium = sync).
- Un écran d'accueil de trois lignes au premier ouverture du popup : ce que fait
  l'extension, où est le bouton, comment créer un compte si on veut la sync.
- Vérifier que `/api/rules` et `/api/adblock` répondent avant login (sinon un
  testeur sans compte n'a ni règles ni adblock).

**Critère d'acceptation.** Chrome vierge → installation → aller sur un chapitre →
lire → fermer → rouvrir : la reprise de lecture retrouve la page. Sans jamais
avoir créé de compte.

**Tests.** Un test qui vérifie que les routes de règles et d'adblock ne sont pas
derrière `requireAuth`.

**Fait le 19/08/2026.** 8 tests dans `backend/test/first-run.test.js` ; suite
complète à 958.

- **Les statistiques répondaient « connectez-vous » à propos de lectures
  qu'elles avaient elles-mêmes enregistrées.** C'était le vrai trou d'A4 :
  `getStats()` rendait `null` sans jeton, donc un profil sans compte lisait,
  voyait son historique local se remplir, ouvrait le panneau et se faisait dire
  qu'il n'y avait rien à compter. Le commentaire d'origine avait raison sur le
  fond — une seconde implémentation au-dessus de la copie locale répond à une
  autre question en ayant l'air de répondre à la même — mais seulement quand il
  y a un compte : c'est le serveur qui additionne plusieurs appareils. Sans
  compte il n'y a rien à additionner, cette copie *est* le tout. `localStats()`
  n'est donc atteint que dans ce cas-là, et rend `local: true` avec ses chiffres
  pour que le panneau puisse dire d'où ils viennent.
- **Les deux calculs sont comparés, pas seulement écrits.** Deux réponses à
  « chapitres lus » qui divergent, c'est une connexion qui a l'air de perdre de
  la lecture. Le test fait passer les mêmes trois jours par le compte et par
  l'appareil et exige l'égalité sur onze champs plus le graphe des jours et le
  haut du classement — séries, série en cours, plus longue série, moyenne des
  notes, relectures. `streaks()` refait exactement la marche de
  `backend/src/routes/history.js`.
- **Ce que la copie locale ne peut pas promettre est dit à l'écran.** Elle est
  élaguée à `HISTORY_LIMIT` lignes : sur une installation ancienne les totaux
  « depuis toujours » sont un plancher, pas un total. C'est ce que dit
  `statsLocalOnly`, qui remplace `statsSignedOut`.
- **Les séries sont groupées par entrée, pas par URL.** Une série dont l'adresse
  a bougé en cours de lecture est un seul livre ; la compter deux fois gonflerait
  « séries lues » précisément chez ceux qui lisent le plus.
- **Les trois lignes se ferment à la main.** Le tour d'installation s'ouvre dans
  un onglet, et un onglet ouvert par une extension est un onglet que beaucoup
  ferment avant qu'il ait dit quoi que ce soit — la première chose vue de
  PanelFlow est alors ce menu, sans rien qui explique à quoi il appartient. La
  carte est écrite comme lue au clic sur « compris » et non à l'affichage : un
  popup se ferme dès que le focus le quitte, ce qui arrive par accident assez
  souvent pour que « montré » et « lu » ne soient pas la même chose. Le drapeau
  va dans le stockage local et non sur le compte : c'est cette barre d'outils et
  cette installation-là dont il parle.
- **`/api/rules` et `/api/adblock` étaient déjà publics** — montés avant et hors
  de `requireAuth`. Ce qui manquait, c'est le test qui les y garde : une ligne
  déplacée dans `index.js` transforme une installation neuve en extension qui ne
  détecte rien, avec un 401 que personne ne voit dans une console que personne
  n'a ouverte. Le test vérifie les deux sens — ces deux routes répondent sans
  jeton, et les sept qui portent les données de quelqu'un répondent 401.
- **Le critère d'acceptation est prouvé par test, pas à la main.** Un Chrome
  vierge ne se pilote pas depuis cette machine. `bootWorker` fait tourner le vrai
  `background.js` ; on lit un chapitre, on récupère le `chrome.storage` obtenu,
  on redémarre un worker neuf dessus — c'est exactement « fermer et rouvrir
  Chrome », service worker perdu, stockage gardé. La reprise retrouve la page 9
  sur 20, la bibliothèque a son entrée, le raccourci « continuer » pointe sur le
  bon chapitre, et aucun appel de tout le parcours n'a porté d'en-tête
  `Authorization`.

**Reste à vérifier à la main** (impossible d'ici) : que le zip se charge
réellement dans un Chrome vierge et détecte un chapitre sushiscan. Tout le reste
du parcours est sous test.

---

### A5 — Le domaine ⚠️ préparé (19/08/2026), l'achat reste à faire

**Pourquoi.** Les antivirus signalent `*.vercel.app` par réputation d'hébergeur.
Un testeur dont l'antivirus bloque l'appel conclut que l'app est cassée — ou pire.

**Travail.** Acheter un domaine, le brancher sur le projet Vercel
`panelflow-backend`, changer l'URL, relancer `npm run health`.

**Critère d'acceptation.** `npm run health` vert sur le nouveau domaine, et l'ancien
`*.vercel.app` continue de répondre le temps de la transition.

**⚠️ Décision utilisateur** — nécessite un achat. À valider avant.

**Préparé le 19/08/2026.** La procédure complète est écrite au §5 de
[docs/deploy-vercel.md](deploy-vercel.md) — sept étapes, dont trois qu'on
n'aurait pas devinées le jour venu. Rien n'a été acheté.

- **« Le seul endroit prévu pour ça » était faux.** Cette ligne était dans cette
  feuille de route ; l'URL est en réalité dans six fichiers. Un seul est la
  source (`shared/panelflow-core.js`) ; cinq en gardent une copie littérale parce
  qu'ils sont lus par un compilateur, un système de build ou Chrome lui-même —
  Gradle, `ios/project.yml`, `NativeMessages.swift`, le `placeholder` de la page
  d'options, et **le manifeste de l'extension**. Le tableau est au §4 du même
  document.
- **Le manifeste est le plus silencieux des cinq.** C'est lui qui autorise le
  pont entre le web app et l'extension (`content/site-bridge.js`). Une adresse
  qui n'y figure pas donne une page de réglages qui ne voit pas l'extension, sans
  erreur nulle part. Il n'était couvert par aucune liste ; il l'est maintenant.
- **Le test qui garde tout ça se serait tu le jour du changement.**
  `backend/test/backend-url.test.js` cherchait `https://<hôte>.vercel.app` : le
  jour où l'URL cesse d'être un `vercel.app`, il ne trouve plus rien à comparer
  et passe au vert en ne surveillant plus rien — sur le seul changement pour
  lequel il existe. Il est maintenant écrit contre `DEFAULTS.backendUrl`, et le
  balayage `vercel.app` reste comme seconde moitié : après la bascule, c'est lui
  qui nommera les fichiers restés sur l'ancien hôte. `site-bridge.test.js` avait
  la même URL en dur et l'importe désormais.
- **Ce que le §5 ajoute et qui ne se déduit pas de « changer l'URL ».**
  `PANELFLOW_PUBLIC_URL` est ce qui est écrit dans les liens de réinitialisation
  de mot de passe — laissée sur l'ancien domaine, elle envoie les gens exactement
  là où leur antivirus proteste, et Vercel ne réinjecte pas une variable dans un
  déploiement déjà construit, donc il faut redéployer. `PANELFLOW_MAIL_FROM` a
  pour défaut `no-reply@panelflow.app`, ce qui rend le domaine `panelflow.app`
  gratuit en configuration s'il est celui qu'on achète — mais dans tous les cas
  il faut poser SPF et DKIM chez Resend, sans quoi les mails partent en spam. Un
  mot de passe oublié qui n'arrive jamais ne remonte jamais non plus.
- **Et l'ancienne adresse ne se coupe pas.** Toute installation où Save a été
  cliqué une fois a l'URL écrite en dur dans son `chrome.storage` ; elle ne suit
  pas le changement de défaut.

---

## 3. Phase B — la finition qu'un testeur remarque ✅ fait (21/08/2026)

### B1 — Thème clair (§9.6) ✅ fait (par R1/R2, vérifié le 21/08/2026)

`background: rgb(20, 20, 28)` est en dur, il n'y a ni `prefers-color-scheme` ni
`data-theme`. Sortir les couleurs en variables CSS dans les trois interfaces
(`web/`, `extension/popup/`, `extension/content/reader.css`), respecter le système
par défaut, et ajouter un réglage à trois états (système / clair / sombre).
**Le lecteur reste sombre par défaut même en thème clair** — c'est le bon choix pour
lire des planches, mais il devient explicite au lieu d'être subi.

**Déjà livré par la refonte (R1/R2).** Rien n'a été réécrit ici : la tâche a été
vérifiée en marche plutôt que refaite. Ce qui existe :

- `shared/theme.css` porte les deux palettes en `--dark-*` / `--light-*`, et c'est
  la seule copie — les trois interfaces la reçoivent par `sync:shared`.
- `shared/theme.js` est chargé depuis le `<head>` **sans `defer`** et lit
  `localStorage['pf-theme']` avant le premier rendu, sinon la page s'affiche en
  sombre puis bascule en clair sous les yeux du lecteur.
- Les trois états sont réels : `système` **efface** la clé et l'attribut
  `data-theme` au lieu d'écrire « system » dedans, ce qui est la seule façon que
  `prefers-color-scheme` reprenne la main.
- Le lecteur ne voit pas le `localStorage` de l'extension — il tourne sur
  l'origine du site de scans. `extension/content/reader.css` répond donc au
  `prefers-color-scheme` **plus** la classe `.pf-follow-system`, pilotée par la
  préférence `readerDark` (défaut : vrai). D'où « reste sombre par défaut ».

Vérifié le 21/08/2026 dans le navigateur, contre le backend local : les jetons
résolvent bien dans les trois états (sombre `#12100f`, clair `#f7f4ec`, système
sans attribut `data-theme`).

### B2 — Barre d'outils mobile à 375 px (§9.7) ✅ fait (par R2, mesuré le 21/08/2026)

La bannière « 2 séries ont de nouveaux chapitres ! » se casse sur quatre lignes à
côté de cinq boutons. Passer la barre en `flex-wrap` avec la bannière sur sa propre
ligne sous 480 px. Vérifier au `resize_window` preset mobile.

**Déjà livré, et mesuré plutôt que regardé.** À 375 × 812, `#check-status` occupe
seule la première ligne (`left 12, top 212, largeur 351`), les cinq boutons passent
en dessous sur deux rangs, et surtout `scrollWidth === innerWidth === 375` : rien
ne dépasse à droite. C'est ce dernier chiffre qui compte — une barre qui tient
visuellement mais déborde de deux pixels donne une page qui glisse
horizontalement à chaque geste de lecture.

**Déplacé depuis, le 22/08/2026.** R3 a emmené `#check-status` et
`🔄 Check for new chapters` dans la vue `Updates`, dont ils sont l'action. La
mesure ci-dessus reste vraie — le statut prend toujours sa ligne à 375 px, rien
ne déborde — mais elle décrit `#updates-view` maintenant, et la barre de la
bibliothèque n'a plus que trois boutons.

### B3 — Les petits accrocs (§9.8) ✅ fait (19/08/2026)

- ~~Le menu « Move a whole site » ne rafraîchit pas ses compteurs après migration.~~
- ~~Une série **Completed** affiche quand même une pastille NEW.~~
- ~~`/api/push/key` en 503 écrit une erreur console alors que l'UI gère le cas.~~

Trois corrections indépendantes, un test chacune — c'est ce qui a été fait, mais
deux d'entre elles ne tenaient pas dans le fichier où le symptôme apparaissait :

**Les compteurs.** La liste « from » se construisait à l'ouverture de la boîte de
dialogue, dans le gestionnaire de clic. Extraite en `fillMigrateSources()` et
rappelée après le déplacement — donc après le `refresh()` qui recharge la
bibliothèque, sinon elle recompterait les lignes que le déplacement vient
d'invalider. Un site vidé disparaît de la liste, et la sélection retombe sur
« Every site » plutôt que sur un menu blanc. `migrate-dialog.test.js`, 6 tests.

**La pastille NEW.** La vraie cause n'était pas la pastille : `shared/folders.js`
dit depuis toujours quels dossiers la veille regarde (`WATCHED = reading,
paused`), le serveur y obéit, et **aucun client ne le lisait**. Une série passée
en Completed gardait l'écart que le dernier contrôle avait laissé, pour toujours.
`shared/library-view.js` gagne `newChapters(entry, progress, categories)` : c'est
l'écart *en tant que nouvelle*, zéro dans un dossier que plus personne ne suit.
`chaptersBehind` reste la mesure brute et reste non filtré — c'est sur lui que
trie « Chapters behind », et une série arrêtée trois chapitres avant la fin l'est
vraiment. Le téléphone, lui, portait **une deuxième copie de l'arithmétique** :
il ne chargeait pas `library-view.js` du tout. Il le charge maintenant, et son
`unread()` local a disparu. `read-state.test.js`, 7 tests de plus.

**Le 503.** Le `try/catch` de la page attrapait déjà l'erreur : ce n'était pas
elle qui s'écrivait en console, c'était la couche réseau du navigateur, qui
enregistre toute requête échouée quoi que fasse la page. Aucun `catch` ne pouvait
la faire taire. `GET /api/push/key` répond donc `200 { key: null }` quand le
serveur n'a pas de paire VAPID — c'est une **question** (« le push est-il proposé
ici ? »), posée à chaque chargement, et un déploiement sans clés n'est pas en
panne. `/api/push/test` garde son `503` : celui-là est une **action**, le lecteur
a appuyé sur un bouton et on lui doit la raison. `push.test.js`, 1 test de plus
et l'ancien retourné.

### B4 — Les gestes et la molette sous test (§9.9) ✅ fait (21/08/2026)

Restent hors tests : le rendu, les gestes, la molette du sélecteur de chapitre, et
toute l'application web. Prendre d'abord **la molette** (elle décide où va
l'utilisateur) et **les zones de tap** (elles décident si la lecture est agréable),
avec la même méthode d'extraction que `page-turn.test.js`.

**Fait le 21/08/2026.** Les zones de tap l'étaient déjà : `page-turn.test.js`
couvre les 17 cas de la tourne et de l'appariement des doubles pages. Manquait la
molette, et il fallait d'abord voir ce qui restait vraiment à couvrir :
`chapter-wheel.test.js` et `chapter-wheel-series.test.js` testent la *dérivation*
de la liste (quels liens comptent pour un chapitre), pas la molette elle-même.
D'où `backend/test/chapter-wheel-ui.test.js`, 22 tests, même méthode que
`page-turn.test.js` — le vrai bloc est extrait de `extension/content/reader.js`
et branché sur un DOM bouchon qui enregistre ce qu'on lui demande.

Ce que ça arrête :

- **L'arithmétique.** `centreOn(i)` → `centreIndex()` fait l'aller-retour sur
  chaque ligne, la première et la dernière comprises ; une position entre deux
  lignes tombe sur la plus proche ; un survol élastique (scroll négatif, ou très
  au-delà de la fin) nomme quand même une ligne réelle, sinon `Entrée` ne fait
  rien sur une molette qui a visiblement une ligne au centre.
- **Le contrat avec la feuille de style.** `centreOn` multiplie l'index par la
  hauteur de ligne, ce qui n'est juste que tant que la molette est rembourrée de
  la moitié de sa hauteur aux deux bouts. Changez ce `padding`, `--pf-rows`, ou
  la bande centrale, et tout continue de tourner en pointant une ligne à côté :
  rien ne lève. Le CSS est donc testé en texte, à côté du code qui en dépend —
  `--pf-rows` impair, `padding = ligne × (rows − 1) / 2`, la bande peinte
  exactement là où le rembourrage s'arrête et haute d'une ligne.
- **Le filtrage.** « Masquer les chapitres lus » ne retire jamais le chapitre en
  cours (une molette dont la ligne courante manque a l'air d'avoir sauté), et
  `wheelIndex` compte les lignes qui existent, pas les chapitres. Tant que
  l'historique n'a pas répondu (`readChapters === null`), aucune couleur n'est
  affirmée.
- **La note.** Elle dit combien de lignes sont masquées, dans les chaînes qui
  sont livrées (`readerHiddenOne` / `readerHiddenMany`, une clé par forme
  plurielle), et ne porte pas d'URL : `Entrée` dessus ne navigue nulle part.
- **Les touches.** Chaque branche, y compris celle qui n'existe pas : une touche
  dont la molette n'a pas l'usage est **rendue au lecteur** (`return false`),
  sinon une molette ouverte gèlerait le lecteur derrière elle.
- **Les écouteurs.** Vingt ouvertures/fermetures ne laissent pas une pile de
  `pointerdown` sur le document, et l'écouteur se retire tout seul une fois le
  lecteur parti — il est sur le `document`, qui lui survit.

Les deux mutations témoins (`--pf-rows: 8`, et le filtre qui oublie le chapitre
en cours) font tomber le fichier ; la suite est à 980 tests.

---

## 4. Phase C — le téléphone existe 🔴 bloquant beta mobile

**Le trou structurel : les deux coques n'ont jamais été compilées.** Il n'existe
aucun APK, aucun `.ipa`. Tant que ça reste vrai, « je fais installer l'app sur
téléphone à un ami » est impossible — et aucune quantité de tests ne le remplace.

Cette machine n'a ni Android SDK ni Xcode. La solution n'est donc pas locale.

### C1 — Compiler Android dans la CI

**Fichiers.** `.github/workflows/android.yml` (nouveau — le dépôt n'a aujourd'hui
aucun workflow).

**Travail.** Un workflow qui, sur push et sur demande manuelle, installe le JDK,
lance `./gradlew assembleDebug` et publie l'APK en artefact. Première exécution :
s'attendre à ce que ça ne compile pas — c'est précisément le but, découvrir la
liste des erreurs qui dorment depuis l'écriture de la coque.

**Critère d'acceptation.** Un APK téléchargeable depuis l'onglet Actions.

### C2 — Faire tourner l'APK

Installer sur un téléphone réel, ouvrir un chapitre, vérifier que les scripts
injectés (`PageScripts.kt` : `popup-guard`, `chrome-shim`, `series-match`,
`site-rules`, `detect`, `library-modal`, `reader`) s'exécutent tous — le `try/catch`
par fichier fait qu'un script mort est **silencieux**. Ajouter une remontée : si un
script échoue, l'app doit le dire, pas continuer à moitié.

**Critère d'acceptation.** Un ami installe l'APK, ouvre un chapitre, le lit.

### C3 — iOS

Même démarche (`xcodebuild` dans un runner macOS), mais l'installation chez un tiers
demande TestFlight, donc un compte développeur payant. **À planifier après C2** :
Android prouve la coque à moindre coût.

**⚠️ Décision utilisateur** — compte développeur Apple (99 $/an).

### C4 — Push natif (APNs / FCM)

Le web a Web Push ; une app endormie sur iOS ne reçoit rien. Sans ça, la promesse
« nouveau chapitre » ne tient pas sur téléphone. Réutiliser `backend/src/push.js`
comme point d'entrée, ajouter les deux transports à côté du transport Web Push.

---

## 5. Phase D — parité fonctionnelle 🟠

### D1 — Brancher les trackers pour de vrai

**Le code OAuth d'AniList et MAL n'a jamais tourné en conditions réelles** : aucun
identifiant configuré, donc le callback n'a jamais été exécuté ailleurs que dans les
tests. C'est la fonction la plus visible du concurrent et celle où PanelFlow est le
plus fragile.

Configurer `PANELFLOW_<SERVICE>_CLIENT_ID` / `_CLIENT_SECRET` / `_REDIRECT_URI`
(voir `backend/src/routes/trackers.js:18`), puis dérouler le parcours complet **sur
un compte de test créé pour ça** — jamais sur le compte personnel : une écriture de
progression sur un compte tiers ne se défait pas.

**Rappel :** MAL est déclaré *Non-Commercial*. À basculer en *Commercial* le jour où
l'offre premium existe.

### D2 — MangaUpdates

Troisième tracker de MangaPin, absent chez PanelFlow. À ajouter derrière la même
abstraction que les deux autres une fois D1 prouvé.

### D3 — Couverture des sites

Le vrai avantage compétitif se joue là : le nombre de sites qui marchent du premier
coup. Établir une liste des 30 sites les plus utilisés, vérifier chacun, et écrire
une règle de domaine quand l'heuristique ne suffit pas. Attention : depuis ce poste,
un tiers des sites sont bloqués par Kaspersky/Cloudflare — un échec ici n'est pas
une preuve, il faut le distinguer.

---

## 6. Phase E — tenir la charge et la durée 🟡

### E1 — `POST /library/migrate-bulk`

Jusqu'à 200 allers-retours Turso séquentiels (`backend/src/routes/library.js:419`).
C'est **délibéré** : chaque élément échoue isolément et on sait lequel. Le remplacer
par `db.batch` (déjà utilisé l. 306) demande de conserver cette propriété — sinon
ne pas y toucher. Mesurer avant de décider.

### E2 — Ce qui a déjà été optimisé (ne pas refaire)

- `document.body.innerText` dans `scorePage()` forçait une mise en page complète du
  document **à chaque mutation**. Il n'est plus lu que lorsque le score est à portée
  du seuil et que le bonus de densité peut le faire basculer. Un domaine connu
  (score 100 pour un seuil de 50) ne le paie plus jamais.
- Deux `[...querySelectorAll('a, button')].slice(0, 400)` matérialisaient **toutes**
  les ancres de la page avant d'en garder 400. Remplacés par `someClickable()`, qui
  itère la `NodeList` et s'arrête au premier oui.
- `reader.js` utilise déjà `loading="lazy"` en mode vertical et un `preload()` borné.

### E3 — Budget de démarrage

Mesurer le coût de `detect.js` sur une page lourde (Performance panel) et se donner
un budget explicite. Aujourd'hui la boucle d'adresse coûte une comparaison de chaîne
par seconde et par onglet — négligeable, mais c'est le genre de chose qui s'accumule.

---

## 7. Phase F — distribution 🟡

- **F1** — Chrome Web Store : compte développeur (5 $ une fois), fiche, captures,
  politique de confidentialité. C'est ce qui remplace « je t'envoie un zip ».
- **F2** — Play Store / App Store, une fois C2/C3 prouvés.
- **F3** — Facturation (StoreKit 2 / Play Billing), connexion Apple/Google.
  Déclenche le passage de MAL en *Commercial*.

**⚠️ Décisions utilisateur** — comptes payants, à valider un par un.

---

## 8. Ordre d'exécution

```
A1 ─ A2 ─ A3 ─ A4 ──────────────► zip envoyable à un ami   ✅ 19/08/2026
              │
              └─ A5 (achat)

B1 ─ B2 ─ B3 ─ B4 ──────────────► l'app ne fait plus amateur   ✅ 21/08/2026

C1 ─ C2 ────────────────────────► APK installable
     └─ C3 (compte Apple) ─ C4

D1 ─ D2                          ► parité trackers
D3 ─────────────────────────────► parité sites (le vrai différenciateur)

E1 ─ E3                          ► dette assumée
F1 ─ F2 ─ F3                     ► magasins
```

**Le chemin le plus court vers « ça marche pour tous » : A2 → A1 → A3 → A4, puis C1 → C2.**
Le reste améliore un produit qui marche déjà ; ces six tâches-là décident s'il
existe en dehors de cette machine.

---

## 9. Définition de « fini » pour la beta

Une case cochée = vérifiée par quelqu'un qui n'est pas l'auteur, sur sa machine.

- [ ] Un ami installe le zip en suivant `docs/installation.md`, seul.
- [ ] L'écran de permissions ne parle pas de « tous les sites ».
- [ ] Il ouvre un chapitre sur trois sites différents : la pastille apparaît.
- [ ] Il lit, ferme, rouvre : la reprise retrouve la page.
- [ ] Il n'a créé aucun compte et tout ce qui précède marche.
- [ ] Il crée un compte : sa bibliothèque locale monte au serveur sans perte.
- [ ] Un ami installe l'APK et lit un chapitre.
- [ ] `npm test` vert, `npm run health` vert, `npm run pack` produit le zip.
