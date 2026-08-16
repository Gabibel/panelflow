# Feuille de route PanelFlow

**But :** que PanelFlow soit un concurrent réel de MangaPin, et qu'il soit *utilisable
par quelqu'un d'autre que son auteur* — j'envoie un lien ou un zip, un ami installe,
ça marche sans que je sois derrière lui.

Ce document est écrit pour être exécuté par Claude, tâche par tâche. Chaque tâche
porte un identifiant stable (`A1`, `C3`…) : demander « fais A2 » suffit.

Dernière mise à jour : **16/08/2026** — 678 tests, tous verts.

---

## 0. Ce qu'il faut savoir avant de toucher au dépôt

Ces règles ne sont pas des préférences, ce sont les invariants qui cassent
silencieusement quand on les ignore. À relire au début de chaque tâche.

### 0.1 Fichiers générés

`shared/*` sont les **sources**. Sont **générés** et ne doivent jamais être édités
à la main :

- `extension/shared/*`, `mobile/www/shared/*`
- `extension/rules/adblock.json`, `ios/Resources/blocker-rules.json`

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

1. Aucun **paquet distribuable** : pas de zip, pas de mode d'emploi d'installation.
2. L'extension demande `<all_urls>` — l'écran d'installation dit « lire et modifier
   toutes vos données sur tous les sites ». Difficile à faire accepter par un tiers.
3. Les **coques téléphone n'ont jamais été compilées**. Il n'existe aucun APK.
4. Les **trackers n'ont jamais tourné sur un vrai fournisseur** : aucun identifiant
   OAuth configuré, donc le code du callback n'a jamais été exécuté en vrai.
5. Le domaine est en `*.vercel.app`, que les antivirus signalent par réputation.
6. Les titres restent sales (`Blue Box Scan VF / FR Gratuit (Webtoon)`).

---

## 2. Phase A — « le zip marche chez un inconnu » 🔴 bloquant beta

C'est la phase à finir avant d'envoyer quoi que ce soit à qui que ce soit.

### A1 — Nettoyer les titres (§9.3 du comparatif)

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

---

### A2 — Réduire la surface d'injection : sortir de `<all_urls>`

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

---

### A3 — Fabriquer le paquet

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

---

### A4 — Le premier lancement chez quelqu'un qui n'a pas de compte

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

---

### A5 — Le domaine

**Pourquoi.** Les antivirus signalent `*.vercel.app` par réputation d'hébergeur.
Un testeur dont l'antivirus bloque l'appel conclut que l'app est cassée — ou pire.

**Travail.** Acheter un domaine, le brancher sur le projet Vercel `panelflow-backend`,
changer l'URL **au seul endroit prévu pour ça** (le fichier unique introduit par
`479e546`), relancer `npm run health`.

**Critère d'acceptation.** `npm run health` vert sur le nouveau domaine, et l'ancien
`*.vercel.app` continue de répondre le temps de la transition.

**⚠️ Décision utilisateur** — nécessite un achat. À valider avant.

---

## 3. Phase B — la finition qu'un testeur remarque 🟠

### B1 — Thème clair (§9.6)

`background: rgb(20, 20, 28)` est en dur, il n'y a ni `prefers-color-scheme` ni
`data-theme`. Sortir les couleurs en variables CSS dans les trois interfaces
(`web/`, `extension/popup/`, `extension/content/reader.css`), respecter le système
par défaut, et ajouter un réglage à trois états (système / clair / sombre).
**Le lecteur reste sombre par défaut même en thème clair** — c'est le bon choix pour
lire des planches, mais il devient explicite au lieu d'être subi.

### B2 — Barre d'outils mobile à 375 px (§9.7)

La bannière « 2 séries ont de nouveaux chapitres ! » se casse sur quatre lignes à
côté de cinq boutons. Passer la barre en `flex-wrap` avec la bannière sur sa propre
ligne sous 480 px. Vérifier au `resize_window` preset mobile.

### B3 — Les petits accrocs (§9.8)

- Le menu « Move a whole site » ne rafraîchit pas ses compteurs après migration.
- Une série **Completed** affiche quand même une pastille NEW.
- `/api/push/key` en 503 écrit une erreur console alors que l'UI gère le cas.

Trois corrections indépendantes, un test chacune.

### B4 — Les gestes et la molette sous test (§9.9)

Restent hors tests : le rendu, les gestes, la molette du sélecteur de chapitre, et
toute l'application web. Prendre d'abord **la molette** (elle décide où va
l'utilisateur) et **les zones de tap** (elles décident si la lecture est agréable),
avec la même méthode d'extraction que `page-turn.test.js`.

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
A1 ─ A2 ─ A3 ─ A4 ──────────────► zip envoyable à un ami
              │
              └─ A5 (achat)

B1 ─ B2 ─ B3 ─ B4 ──────────────► l'app ne fait plus amateur

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
