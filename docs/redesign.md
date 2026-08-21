# Refonte de l'interface PanelFlow

**But :** une seule identité visuelle sur les quatre façades, un lecteur qui
s'efface, une bibliothèque qui donne une raison de revenir tous les jours — sans
que rien de tout ça ne bouge plus qu'il ne faut.

Écrit pour être exécuté tâche par tâche, comme [`roadmap.md`](roadmap.md).
Chaque phase porte un identifiant stable (`R1`…`R5`) : demander « fais R2 » suffit.

**Date :** 18/08/2026 — état mesuré sur le dépôt à cette date.

---

## 0. Rapport aux autres documents

Ce document **reprend et remplace** deux tâches de la feuille de route :

| Tâche d'origine | Où elle atterrit ici |
| --- | --- |
| `B1` — thème clair (§9.6 du comparatif) | **R1**, comme effet de bord des jetons |
| `B2` — barre d'outils mobile à 375 px (§9.7) | **R2**, avec la refonte de l'en-tête |

`B3` (les petits accrocs) et `B4` (gestes et molette sous test) ne sont **pas**
touchés : ce sont des corrections de comportement, pas d'apparence.

> **Le 19/08/2026, `B3` a quand même été fait** — avant R3 et non dedans, parce
> que le fil des nouveautés se serait construit sur une notion de « nouveau »
> fausse. Détail en `roadmap.md` §B3. Ce qui change pour la suite : `newChapters()`
> dans `shared/library-view.js` est désormais la seule réponse à « qu'est-ce qui
> est nouveau », dossier compris, et R3 doit s'en servir plutôt que de refiltrer.

> ⚠️ Tant que `roadmap.md` n'a pas de renvoi vers ce fichier, `B1` et `B2` ont
> deux propriétaires. C'est exactement le genre de dérive que le dépôt essaie
> d'éviter — une ligne dans la phase B suffit à la refermer.

---

## 1. État des lieux, mesuré

### 1.1 Quatre façades, deux palettes, aucune source commune

| Façade | Fichiers | Palette |
| --- | --- | --- |
| Application web | `web/styles.css` (775 l.), `web/index.html` (517 l.), `web/app.js` (2 317 l.) | **indigo froid** — `--bg #14141c`, `--accent #7c6cf0` |
| Popup de l'extension | `extension/popup/popup.css` (716 l.), `popup.html` | **pierre chaude** — `--bg #1c1917`, `--accent #e87f56` |
| Accueil + web mobile | `extension/welcome/welcome.css`, `mobile/www/app.css` | **pierre chaude**, mêmes noms de jetons |
| Lecteur | `extension/content/reader.css` (389 l.) | **aucun jeton** — plus de 40 hex en dur, mélangeant les deux |

**Le constat qui décide de tout le reste : la migration est déjà faite aux
trois quarts.** Popup, accueil et mobile partagent
`--bg / --surface / --surface-hi / --line / --text / --muted / --accent / --danger`
au caractère près. Seule l'application web est restée sur l'indigo, et le lecteur
n'a jamais eu de variable à migrer.

Ce n'est donc pas « choisir une direction », c'est **finir celle qui a déjà été
choisie, et rendre la dérive impossible ensuite**.

Preuve chiffrée que la dérive est déjà commencée : `--ok` vaut `#6fdc8c` dans
`welcome.css` et `#6cc08b` dans `mobile/www/app.css`. Deux verts pour la même
idée, dans deux fichiers copiés l'un de l'autre.

### 1.2 Le seul système de design existant

Un jeton traverse réellement les quatre façades : `--unread: #e0a15c`,
délibérément **différent** de l'accent — le commentaire de `web/styles.css:12`
explique pourquoi (« vous avez quelque chose à lire » ne doit pas ressembler à
« ceci est cliquable »).

Avec la règle des trois états de `shared/library-view.js` (`readState` : lu /
en cours / non lu), c'est tout ce qui tient lieu de système. Les deux sont
conservés tels quels : **seul leur rendu change**.

### 1.3 Mouvement

- **10 transitions CSS dans tout le dépôt.** Aucune animation, aucun `@keyframes`.
- **Zéro `prefers-reduced-motion`**, nulle part.

Ce n'est pas un défaut à corriger en ajoutant du mouvement : c'est une base
saine sur laquelle en ajouter très peu.

### 1.4 Détails datés, relevés

- `.cover-fallback` est un dégradé violet à 135° (`web/styles.css:283`).
- Les actions de l'en-tête web sont des émojis employés comme boutons :
  `⇩ ⇧ ⇄ 🔄 ＋ 📨`.
- Tout est en `system-ui` ; la prose du lecteur est en Georgia.
- Sombre en dur, sans `prefers-color-scheme` ni réglage (§9.6).
- La barre d'outils mobile casse sur quatre lignes à 375 px (§9.7).

---

## 2. Ce qui a été regardé ailleurs

### 2.1 Honnêteté sur la méthode

Comme dans [`comparatif-a-b.md`](comparatif-a-b.md), il faut dire d'où vient
l'information avant d'en tirer quoi que ce soit.

**Aucune de ces applications n'a été installée ni manipulée pour ce document.**
Ce qui suit vient de documentation technique publique (le wiki de code de Mihon),
d'une critique UX universitaire de l'application WEBTOON iOS, de la documentation
produit de Readwise Reader et de l'aide Amazon pour Kindle. C'est donc de la
**seconde main**, et les motifs retenus le sont pour leur logique, pas parce
qu'on les a mesurés à l'usage.

### 2.2 Les quatre motifs qui valent d'être repris

**① L'interface disparaît pendant la lecture et revient exactement quand on la
demande.**
Mihon associe des zones de l'écran à Suivant / Précédent / **Ouvrir le menu**, et
superpose des **réglages par série** aux réglages globaux. Readwise Reader masque
sa barre d'actions en vue de lecture et ne laisse remonter que la progression et
l'apparence. PanelFlow a déjà les zones de tap et le masquage automatique. Ce qui
manque, c'est **la surcharge par série** — et c'est précisément elle qui donne
l'impression que le lecteur se souvient de vous. Un webtoon et un tankōbon en
lecture droite→gauche n'ont rien à faire avec le même mode global.

**② L'habitude quotidienne vit dans un fil de nouveautés, pas dans une grille.**
Chez Mihon, la surface qu'on ouvre le matin est une liste antéchronologique de ce
qui est sorti depuis la dernière fois. PanelFlow possède déjà toute la donnée
(`lastKnownChapter`, `chaptersBehind`, la progression, l'historique) mais
l'expose comme un **bouton** (`🔄 Check for new chapters`) et disperse des
pastilles NEW dans une grille qu'il faut balayer des yeux.

C'est le motif à plus fort rendement du lot, et **il ne demande aucun changement
au backend** : la donnée est déjà là, servie, testée.

**③ La progression exprimée en termes humains, et débrayable.**
Kindle affiche « temps restant dans le chapitre », calculé sur le rythme réel du
lecteur, et laisse le masquer — parce que certains lecteurs ne veulent pas savoir
que le chapitre se termine. `chaptersBehind` calcule déjà le bon nombre chez nous ;
il ne sert aujourd'hui que de clé de tri. « 3 chapitres de retard » vaut mieux
qu'une pastille.

**④ La fin d'un chapitre est le moment de la décision.**
Les analyses citées à propos de WEBTOON placent le moment de rétention dans les
20 % derniers d'un épisode. PanelFlow, lui, **rend la main au site d'origine** à
la fin d'un chapitre. Un panneau de fin de chapitre dans le lecteur (chapitre
suivant, progression écrite, marquer comme lu) garde le flux à l'intérieur du
Reader Mode — ce qui est la thèse même du produit.

### 2.3 Ce qu'on ne copie pas

- **Le fil d'accueil de WEBTOON.** Recommandations algorithmiques, tendances,
  choix de la rédaction et bannières promotionnelles empilés sans hiérarchie :
  la critique relevée pointe la charge cognitive et un modèle mental éclaté
  (bibliothèque, service de streaming, fil social et jeu freemium à la fois).
  **PanelFlow n'a pas de catalogue — on n'invente pas une surface de découverte.**
- **Tout ce qui est modal à un pic émotionnel.** Le reproche le plus net fait à
  WEBTOON : le péage tombe à la fin de l'épisode sans signal préalable.
  Corollaire chez nous : le panneau de fin de chapitre est **de la navigation et
  rien d'autre** — pas d'invitation à noter, pas de relance tracker, pas de
  « activez les notifications ».
- **La densité Android de Mihon telle quelle.** Des feuilles de filtres et des
  rangées de puces recopiées littéralement donnent un portage Android dans un
  navigateur.
- **Daté :** dégradés sur les couvertures de repli, émojis en guise d'icônes,
  cartes à ombre portée flottant sur fond sombre, squelettes à reflet animé.

---

## 3. Direction visuelle — « encre & papier journal »

Ancrée dans le manga imprimé plutôt que dans les conventions des applications de
streaming : noirs chauds (encre sur papier bon marché, pas noir bleuté d'OLED),
un seul accent vermillon déjà présent dans le dépôt, l'ambre réservé pour
toujours à « non lu ».

### 3.1 Palette

Prolonge la rampe « pierre » que popup, accueil et mobile utilisent déjà, et
ajoute le thème clair (ce qui livre `B1`).

| Jeton | Sombre | Clair |
| --- | --- | --- |
| `--bg` | `#12100F` | `#F7F4EC` |
| `--surface` | `#1C1917` | `#FFFFFF` |
| `--surface-hi` | `#262220` | `#EDE8DC` |
| `--line` | `#38332F` | `#DDD5C6` |
| `--text` | `#FAFAF9` | `#1A1714` |
| `--muted` | `#A8A29E` | `#6B635C` |
| `--accent` | `#E8613C` | `#C64A28` |
| `--danger` | `#F2705F` | `#C4382A` |
| `--unread` | `#E0A15C` | `#E0A15C` |

`--unread` est le seul jeton **identique dans les deux thèmes** : c'est une
information, pas une couleur d'ambiance.

Le violet disparaît du dépôt. **Le lecteur reste sombre par défaut dans les deux
thèmes**, mais en tant que réglage explicite au lieu d'être subi — c'est le bon
choix pour lire des planches, et §9.6 reprochait l'imposition, pas le sombre.

### 3.2 Typographie — IBM Plex

- **Interface et titres :** IBM Plex Sans, et **IBM Plex Sans Condensed** pour les
  titres de couverture et les numéros de chapitre — la condensée lit comme une
  tranche de tankōbon et tient dans une carte de 150 px.
- **Prose (chapitres texte) :** IBM Plex Serif remplace Georgia.
- **Chiffres tabulaires** partout où un numéro de chapitre apparaît, pour que la
  molette et la grille cessent de sautiller quand le nombre change.

Industrielle, un peu technique, libre, auto-hébergeable, et ce n'est pas Inter.

**Contrainte de chargement, à ne pas contourner :** le lecteur est injecté dans
la page d'un tiers. Y charger une police veut dire `web_accessible_resources` et
une bagarre CSP par site. **Le lecteur garde donc la pile système** ; la police de
marque ne s'applique qu'à l'application web, la popup, les options et l'accueil.
Le lecteur tire son identité de sa palette et de sa mise en page, pas de sa fonte.

### 3.3 Autres décisions

- **Couvertures de repli :** première lettre du titre en condensée sur une teinte
  chaude déterministe dérivée d'un hachage du titre. Plus de dégradé.
- **Cartes :** perdent leur panneau de fond, gagnent un filet de 1 px `--line`.
  La grille lit comme une étagère de couvertures, pas comme un mur d'habillage.
- **Icônes :** un petit jeu de SVG en ligne remplace les émojis de l'en-tête.

---

## 4. Invariants à respecter

Repris de [`roadmap.md §0`](roadmap.md) — ils cassent en silence si on les ignore.

1. **`shared/*` est la source.** `extension/shared`, `web/shared` et
   `mobile/www/shared` sont générés par `npm run sync:shared` et **font partie du
   commit**. Ajouter `theme.css` veut donc dire éditer `TARGETS` dans
   `scripts/sync-shared.mjs:55`, pas déposer une copie à la main.
2. **`reader.css` est copié tel quel** dans `ios/Generated/inject/` par
   `ios/Sources/PageScripts.swift:29`. Il **ne peut pas** faire d'`@import`, et il
   est injecté dans la page de quelqu'un d'autre : il ne doit restyler que ce qui
   est sous `#panelflow-reader`. Ses jetons sont donc déclarés **en ligne, sur
   `#panelflow-reader`**, pas sur `:root`.
3. **`backend/test/ui-hidden.test.js` échoue** si une feuille de style perd sa
   règle `[hidden] { display: none !important }`. Toute nouvelle feuille hérite
   de cette obligation, et de son entrée dans la liste `PAGES`.
4. **L'interface est hors tests (§9.9).** Les invariants CSS se testent donc
   **comme du texte**, à la méthode de `ui-hidden.test.js` — lire le fichier livré
   et vérifier la règle. Jamais une deuxième copie de la règle dans le test.
5. **Rien de copié de MangaPin.** Parité fonctionnelle, pas copie.

---

## 5. Les cinq phases

### R1 — Les jetons et le thème ✅ fait (18/08/2026)

Rien ne change à l'écran. Tout devient changeable.

**Fichiers**

- **nouveau** `shared/theme.css` — source unique des jetons, les deux thèmes.
- `scripts/sync-shared.mjs` — `theme.css` ajouté aux cibles `web/shared`,
  `extension/shared`, `mobile/www/shared`.
- `web/styles.css`, `extension/popup/popup.css`, `extension/welcome/welcome.css`,
  `mobile/www/app.css`, `extension/options/options.html` — pointent sur les jetons.
- `extension/content/reader.css` — jetons **en ligne sous `#panelflow-reader`**.
- Réglage à trois états (système / clair / sombre) dans les réglages web et la
  page d'options, plus l'interrupteur « le lecteur reste sombre » (coché par défaut).
- **nouveau** `backend/test/theme.test.js`.

**Fini quand :** aucune couleur en dur hors de `theme.css` (le test le vérifie
sur chaque feuille), `sync:shared --check` est vert, et basculer le système de
clair à sombre change les quatre façades sans toucher au lecteur.

> « Rien ne change à l'écran » n'est pas tout à fait tenu, et c'était
> inévitable : la popup, la page d'accueil et la coque mobile partageaient une
> rampe décalée d'un cran par rapport à celle retenue (leur fond était le
> `--surface` du thème, leur `--surface` le `--surface-hi`, etc.) et leur accent
> était un ton plus clair. Ces trois façades descendent donc d'un cran et
> l'orange s'assombrit un peu. C'est le seul moyen d'avoir une palette : deux
> rampes voisines, c'est exactement la dérive qu'on retire.

**Ce qui a été livré**, et les trois écarts avec ce qui est écrit plus haut :

- `shared/theme.css` (les deux palettes, chaque valeur écrite une fois),
  `shared/theme.js`, `backend/test/theme.test.js` — quatre tests : aucune
  couleur hors de `theme.css`, aucune couleur dans le lecteur hors de ses deux
  blocs de jetons, les deux blocs sombres de `theme.css` identiques caractère
  pour caractère, et les jetons du lecteur égaux à ceux du thème.
- Les six façades pointent sur les jetons : `web/styles.css`, `popup.css`,
  `welcome.css`, `mobile/www/app.css` et les `<style>` en ligne de
  `options.html` et `offline.html`. Zéro littéral restant, `#6fdc8c` /
  `#6cc08b` compris.
- 858 tests verts, `sync:shared --check` vert. Vérifié dans le navigateur : les
  trois états basculent, et aucun texte de l'app web ne descend sous 3:1 dans
  l'un ou l'autre thème.

1. **`shared/theme.js` n'était pas prévu.** Le choix doit être posé sur `<html>`
   *avant* la première peinture, sinon la page clignote. Cela exclut
   `chrome.storage`, qui est asynchrone : le réglage vit donc dans
   `localStorage`. Toutes les pages de l'extension partagent une origine et se
   mettent d'accord sans que rien ne se synchronise ; l'app web garde sa propre
   réponse, ce qui est correct — le navigateur où l'on lit et celui d'où l'on
   administre ne sont pas toujours la même machine.
   **Revenu dessus le 19/08/2026** : voir « Hors phases — les réglages suivent
   le compte » plus bas. La peinture reste locale (elle ne peut pas ne pas
   l'être), mais la *réponse* appartient désormais au compte, et « suivre le
   système » est ce qui garde le comportement par appareil pour qui le veut.
2. **`sync:shared` ne régénère pas `ios/Generated/inject/reader.css`.** C'est
   `ios/Scripts/bundle-assets.sh` qui le copie, au moment de la compilation
   Xcode, et l'arbre `ios/Generated` n'est pas versionné. Rien à faire ici — et
   rien de vérifiable ici non plus, faute de chaîne iOS sur cette machine.
3. **Le lecteur clair suit le système, pas le réglage.** Il tourne sur
   l'origine du site de scan et ne peut pas lire le `localStorage` de
   l'extension : `prefers-color-scheme` est la seule réponse que les deux côtés
   entendent. L'interrupteur « le lecteur reste sombre » (coché par défaut,
   `readerPrefs.readerDark`) passe par `chrome.storage`, lui, et pose
   `.pf-follow-system` sur l'overlay. La pilule de détection reste sombre :
   c'est une pastille posée sur la page d'un autre, pas une surface de lecture,
   et `detect.js` n'a aucune raison de charger les préférences du lecteur pour
   teinter un bouton.

---

### R2 — Bibliothèque et navigation ✅ fait (18/08/2026)

**Fichiers**

- `web/styles.css` — grille, cartes, en-tête, `#views`, `#tabs`,
  `#library-tools`, étagère « continuer », dialogues, réglages, statistiques.
- `web/index.html` — en-tête restructuré, jeu d'icônes SVG, `flex-wrap` sur la
  barre d'outils (**c'est `B2`**).
- `web/app.js` — `renderLibrary`, `renderContinue`, `renderTabs`, `coverEl`,
  `fallbackCover`.
- `extension/popup/popup.css` + `popup.html` — le plus petit écart des trois,
  la popup est déjà sur la bonne palette.

**Ce qui change vraiment :** les cartes passent au filet, les couvertures de
repli perdent leur dégradé, les émojis deviennent des SVG, et la ligne de
progression dit « 3 chapitres de retard » (motif ③) au lieu de ne montrer qu'une
pastille — la pastille reste, elle ne porte plus l'information toute seule.

**Fini quand :** rien ne casse à 375 px (vérifié au preset mobile), la bannière
« N séries ont de nouveaux chapitres » tient sur sa propre ligne sous 480 px, et
la règle `readState` de `library-view.js` n'a pas bougé d'une ligne.

**Ce qui a été livré**, et les quatre écarts avec ce qui est écrit plus haut :

- Les cartes sont au filet : `border: 1px solid var(--line)` sur `.card`, et le
  survol comme l'état « non lu » ne touchent que `border-color` — repeindre un
  bord ne déplace rien, en ajouter un décale toute la grille d'un pixel.
- Les couvertures de repli sont une lettre en Plex Condensed sur une teinte
  chaude que le titre décide, sans dégradé. La ligne de progression dit
  « 3 chapters behind » à côté de la pastille, pas à sa place.
- Onze dessins dans un `<symbol>` en tête de `web/index.html`, stampés par
  `<use>` : plus un seul émoji dans l'app web. `web/app.js` a une fonction
  `icon(name)` de trois lignes et rien d'autre.
- La barre d'outils passe à la ligne, et la phrase de statut prend la sienne
  sous 480 px. À 375 px `documentElement.scrollWidth` vaut exactement 375 ; ce
  qui dépasse est dans `#views` et `.shelf`, qui défilent horizontalement par
  construction.
- **nouveau** `backend/test/typography.test.js` (6 tests) et
  **nouveau** `backend/test/library-shelf.test.js` (9 tests). 873 tests verts,
  `sync:shared --check` vert.

1. **Plex Serif n'est pas embarqué**, contrairement à ce que dit la § 3.2. Le
   seul consommateur de `--font-serif` est `extension/content/reader.css:159`,
   et le lecteur est injecté sur le site d'un autre : il ne peut ni `@import`,
   ni charger une police en toute sécurité. Embarquer une fonte que personne ne
   peut demander, c'est deux fichiers woff2 dans trois répertoires générés pour
   rien. Georgia reste, et `theme.css` dit pourquoi à l'endroit où on la lit.
2. **Deux boutons hashés sur la couverture de repli, pas un.** Avec un seul
   (une teinte entre l'accent et l'ambre, diluée à une force fixe), six séries
   sans couverture donnaient six nuances du même orange à 1,5 % près — les deux
   jetons sont des oranges chauds et la dilution effaçait le peu qui restait.
   `--tint` choisit la teinte, `--tint-weight` (22–40 %) décide de sa force :
   douze titres, douze rectangles distincts, vérifié dans le navigateur.
3. **L'échelle des graisses est retombée à 400 / 600 partout**, sur les six
   façades, pas seulement sur celles listées ici. On ne dessine que ces deux
   graisses en woff2 ; une règle qui demande 500 obtient 400 et une qui demande
   700 obtient 600, silencieusement. Autant que la feuille dise ce qui va
   arriver. `typography.test.js` refuse maintenant toute autre valeur.
4. **`#export-open` n'avait jamais eu de style** — ni avant R2, `git show
   HEAD:web/styles.css` le confirme. La règle des boutons de la barre était une
   liste d'identifiants, et il n'y figurait pas : un bouton sur cinq était un
   bouton de navigateur brut, gris, deux pixels plus court que ses voisins.
   Corrigé ici, et la règle devient `.library-actions button:not(.primary)` —
   une liste d'identifiants est une liste qu'il faut penser à compléter. Les
   quatre boutons secondaires font désormais 38,3 px, le primaire 40,3 px,
   centrés sur la même ligne.

---

### Hors phases — les réglages suivent le compte ✅ fait (19/08/2026)

Pas une phase de la refonte : une demande arrivée pendant R2, après une capture
de la page d'options. « Quand tu changes un réglage dans cette page, change-le
aussi dans le site et l'application mobile. »

Le problème était réel et plus large que le thème. Les mêmes questions étaient
posées sur trois surfaces et chacune gardait sa propre réponse : on choisissait
le sens de lecture dans l'extension et le site restait en vertical.

**La distinction posée.** Il y a deux sortes de réglage, et elles étaient
confondues. `settings` dans le cœur, c'est *cette installation* — essentiellement
`backendUrl`, qui ne peut pas vivre sur le compte puisque c'est l'adresse du
serveur où le compte se trouve. Tout le reste parle de la personne. La liste des
dix réponses qui appartiennent au lecteur est dans `shared/prefs.js`, un seul
fichier pour le serveur et les trois clients.

**L'invariant qui rend la synchro sûre.** `GET /api/prefs` ne renvoie que les
questions auxquelles le compte a effectivement répondu — jamais les valeurs par
défaut. Un appareil qui se connecte doit pouvoir distinguer « le compte dit
clair » de « on n'a jamais posé la question au compte », parce que dans le second
cas ses propres réglages sont la meilleure réponse. Un endpoint serviable qui
remplirait les trous ferait de chaque première connexion une instruction, et le
lecteur verrait ses réglages écrasés par un haussement d'épaules.

**Peindre puis adopter.** `shared/theme.js` tourne depuis `<head>` avant la
première peinture et ne peut pas attendre le réseau. Chaque surface est donc
peinte depuis `localStorage`, puis corrigée par `panelflowTheme.adopt(...)` une
fois la réponse du compte arrivée — et `adopt` réécrit `localStorage`, si bien
que la bascule n'a lieu qu'une fois par appareil.

Livré :

- **nouveau** `shared/prefs.js`, `backend/src/prefs.js`, `backend/src/routes/prefs.js`,
  table `prefs` dans le schéma.
- `shared/panelflow-core.js` : `getAccountPrefs` / `pullAccountPrefs` /
  `saveAccountPrefs`, trois `case` de plus dans le hub, et `auth` qui attend la
  synchro et la renvoie. La copie locale bouge la première et sans condition :
  un PUT raté est une chose à retenter, pas une raison de faire revenir un
  interrupteur sous le doigt du lecteur.
- Les quatre surfaces câblées : page d'options (adopte au chargement, pousse au
  changement), popup (réponse en cache, jamais d'attente réseau pour dessiner
  une fenêtre de barre d'outils), site, téléphone.
- L'alarme `pf-check-chapters` rafraîchit le cache. Sans elle, l'extension
  n'apprendrait un thème choisi sur le site que le jour où quelqu'un ouvre sa
  page d'options, c'est-à-dire jamais.
- **nouveau** `backend/test/prefs.test.js` (12) et `backend/test/account-settings.test.js` (6) ;
  `options-page.test.js` et `web-settings.test.js` étendus. 896 tests verts.

Écarts et limites :

1. **Le téléphone n'a pas d'écran de réglages, et n'en gagne pas un.** Il obéit.
   `mobile/www/app.js` n'a donc pas pu être exécuté — il n'y a pas de chaîne iOS
   ni Android sur cette machine. Ce qui est vérifié l'est au niveau du texte,
   par `account-settings.test.js`.
2. **`backendUrl` n'est délibérément pas de la liste.** Un appareil qui la
   prendrait sur le compte pourrait être envoyé n'importe où par un autre.
3. **Une clé inconnue est ignorée, pas refusée.** Un vieux serveur ne doit pas
   rejeter le thème d'un téléphone récent parce que la même requête portait
   autre chose ; une clé *connue* avec une mauvaise valeur, elle, est nommée
   dans `refused` et le reste du patch passe quand même.

---

### R3 — Le fil des nouveautés ✅ fait (22/08/2026)

Motif ②. **Aucune route backend nouvelle** : la donnée est déjà servie.

**Fichiers**

- `web/index.html` — un onglet `Updates` dans `#views`, sa section.
- `web/app.js` — `renderUpdates()`, et `showView` qui en fait l'atterrissage par
  défaut quand il y a quelque chose dedans.

**Contenu :** liste antéchronologique de « ce qui est sorti depuis la dernière
fois », une ligne par série, construite depuis `lastKnownChapter` +
`chaptersBehind` + progression. Chaque ligne ouvre le chapitre, pas la fiche.
`🔄 Check for new chapters` reste, mais devient l'action *de cette vue* au lieu
d'un bouton perdu dans la barre d'outils de la bibliothèque.

**Tranché le 19/08/2026 :** `B3` est passé avant. Une série **Completed**
n'affiche plus de pastille NEW, parce que `newChapters()` compte l'écart *en tant
que nouvelle* et rend zéro dans un dossier que la veille ne regarde pas. R3 n'a
donc rien à refiltrer : il appelle la même fonction que les étagères, et une
série terminée n'entre pas dans le fil.

**Fini quand :** ouvrir l'application après un check montre la liste, elle est
vide et discrète quand il n'y a rien, et aucune série terminée n'y apparaît.

**Livré le 22/08/2026.** Ce qui a demandé une décision :

- **« Antéchronologique » n'avait pas de date à quoi se raccrocher.** La
  bibliothèque n'en porte aucune : `backend/src/routes/meta.js` dit en toutes
  lettres qu'un check ne touche pas `updated_at`, *parce que vérifier ne doit pas
  réordonner la bibliothèque*. Trier là-dessus aurait donc trié par « qui a édité
  la fiche en dernier ». La seule vraie date du schéma est `news.found_at`,
  écrite par la veille de nuit, et le commentaire de cette table dit qu'elle
  existe pour que le site puisse montrer une liste « depuis ton absence ».
  `GET /api/news?all=1` la sert déjà : **aucune route nouvelle**, comme demandé.
  Les séries que la veille n'a jamais datées passent *après* les datées, classées
  par l'écart puis par titre — pas au début du temps, ce qui enterrerait les plus
  gros retards sous ce que la veille a attrapé cette nuit.
- **`?all=1`, et jamais `/news/seen`.** `seen` est le drain de la notification,
  et il appartient au core de l'extension. Le marquer en ouvrant le site
  éteindrait une alerte que le téléphone n'a peut-être jamais montrée.
- **Rien n'est refiltré**, conformément à la ligne du 19/08 : le fil appelle
  `PanelFlowView.newChapters()` et lit `PanelFlowFolders.WATCHED`. Le portillon
  du dossier est passé *en premier*, sinon une série Completed pour laquelle le
  dernier check a trouvé un chapitre rentrerait par `freshIds`.
- **Un chapitre trouvé mais non numéroté compte quand même.** Sur les sites qui
  écrivent « Nouveau chapitre », il n'y a rien à soustraire : `newChapters()`
  rend 0 et le fil aurait sauté la ligne — donnant un check qui annonce 3 séries
  au-dessus d'une liste de 2. Ces lignes entrent par `freshIds` et disent
  « New chapter » sans nombre.
- **`#check-status` a quitté la barre d'outils de la bibliothèque** avec le
  bouton. Le compte de B2 (le statut seul sur la première ligne à 375 px) reste
  vrai, mais dans `#updates-view` maintenant.

`backend/test/updates-feed.test.js` — 16 tests. Le filtre des dossiers, l'ordre
daté/non daté, le nombre, le chapitre non numéroté, et l'horodatage SQLite lu en
UTC (`"2026-08-21 09:00:00"` sans fuseau, qui à l'est de Greenwich se lit sinon
comme trouvé dans le futur). Vérifiés en mutant le code : retirer le portillon
`watched` et lire la date en heure locale font tomber exactement 2 tests. Suite
complète : **996 tests**, tous verts.

Mesuré à 375 px : trois lignes de 76 px de haut, aucun débordement horizontal,
titre et sous-titre coupés à l'ellipse plutôt que renvoyés à la ligne — une
colonne dont les lignes n'ont pas la même hauteur est une colonne que l'œil ne
peut pas descendre. Le rendu du fil pour un compte réel n'a pas pu être vu d'ici :
le site exige une connexion, et je n'ai pas de mot de passe à y entrer.

---

### R4 — Le lecteur 🟠

**Fichiers**

- `extension/content/reader.css` — jetons (posés en R1), panneau de fin de
  chapitre, chrome.
- `extension/content/reader.js` — surcharge des préférences **par série**
  (motif ①) et panneau de fin de chapitre (motif ④).
- Régénération de `ios/Generated/inject/reader.css`.

**Surcharge par série :** un mode de lecture, un sens et une largeur retenus pour
*cette* série, avec repli sur les réglages globaux — la hiérarchie de Mihon.
Écrit à côté de la progression, pas dedans.

**Panneau de fin de chapitre :** chapitre suivant, progression écrite, marquer
comme lu. **Navigation et rien d'autre** (§2.3).

**Fini quand :** ouvrir deux séries de sens opposés ne demande plus de rebasculer
le mode à la main, et arriver au bout d'un chapitre ne renvoie plus sur le site
d'origine. La molette et les gestes restent hors tests — c'est `B4`, pas ici.

---

### R5 — La passe de mouvement 🟡

Les dix animations du §6, les blocs `prefers-reduced-motion`, et le test qui les
tient.

**Fichiers**

- Les six feuilles de style.
- **nouveau** `backend/test/motion.test.js` — chaque feuille qui déclare une
  `transition` déclare aussi un bloc `@media (prefers-reduced-motion: reduce)`.

**Fini quand :** le test est vert, et l'application entière est utilisable avec
« réduire les animations » activé au niveau du système sans qu'aucune information
ne disparaisse.

---

## 6. Les animations

Dix au total, dont **quatre existent déjà**. La refonte en ajoute six et n'en
retire aucune. Chacune est enveloppée dans
`@media (prefers-reduced-motion: reduce)`, qui ramène la durée à `0.01ms` pour
tout déplacement et **conserve les fondus lorsque le fondu *est* l'information**.

| # | Animation | Durée | Ce qu'elle sert |
| --- | --- | --- | --- |
| 1 | Chrome du lecteur : glissement + fondu | 200 ms *(existe)* | Confirme que le tap a été pris. En mouvement réduit : opacité seule, pas de `translate`. |
| 2 | Couverture en fondu au `decode()` | 150 ms | Masque l'apparition par paliers d'un JPEG progressif. Pas d'échelle. Repère teinté fixe, **sans reflet animé**. |
| 3 | Survol de carte : filet + luminosité | 80 ms | Affordance de cible pour un clic qui fait quitter la page. **Ni élévation, ni échelle, ni ombre.** |
| 4 | Changement de vue (Bibliothèque ⇄ Nouveautés ⇄ Stats) | 120 ms fondu croisé + 4 px de montée, panneau entrant seulement | Dit « même application, autre contenu » au lieu de clignoter, et couvre le rendu synchrone de ~200 cartes. |
| 5 | Changement de statut / carte quittant un onglet filtré | 180 ms fondu + repli | Confirme une écriture optimiste **avant** la réponse du serveur : une carte qui disparaît d'un coup se lit comme un bug. |
| 6 | Barre de progression du lecteur | 120 ms linéaire *(existe)* | Montre que le tour de page a abouti. |
| 7 | Couleur des lignes de la molette | 120 ms *(existe)* | Marque la ligne qui va s'ouvrir. `scroll-snap` conservé, **aucun ressort**. |
| 8 | Entrée d'une ligne dans le fil des nouveautés | 150 ms fondu | Les lignes arrivées après un check ne doivent pas surgir. **Le compteur, lui, ne s'anime jamais** — on est en train de le lire pendant qu'il change. |
| 9 | Toast | 200 ms opacité *(existe)* | Déjà correct. |
| 10 | Panneau de fin de chapitre | 160 ms fondu + 6 px de montée | Il arrive sans qu'on l'ait demandé : il doit se lire comme *arrivant*, pas comme un saut de la page. |

### Écartées délibérément

- **La transition de tour de page en mode paginé.** Un glissement de 200 ms à
  chaque page se ressent comme de la latence pour qui lit vite. Proposée comme
  réglage, **désactivée par défaut**.
- Élévation ou agrandissement des cartes au survol.
- Squelettes à reflet animé.
- Entrée en cascade de la grille.
- Parallaxe sur les couvertures, corne de page, physique à ressort, dégradés
  animés, agrandissement couverture → fiche.

---

## 7. Ce qui n'est pas touché

- Le backend, entièrement.
- Le moteur de détection.
- La règle `readState` de `shared/library-view.js` — les trois états restent une
  seule règle, seul leur rendu change.
- L'adblock, les trackers, l'import/export, la migration entre sites.
- Les coques iOS et Android au-delà de la régénération de `reader.css` : pas de
  toolchain mobile sur ce poste (§0.6), donc rien n'y sera compilé ni vérifié ici.

---

## 8. Risques et points ouverts

1. **`B1`/`B2` à deux propriétaires** tant que `roadmap.md` ne renvoie pas ici (§0).
2. ~~**La pastille NEW sur les séries terminées** (§9.8) devient beaucoup plus
   visible avec R3. Ordre à trancher : `B3` avant R3, ou filtrage dans R3.~~
   **Réglé le 19/08/2026** : `B3` est passé avant, et la réponse est partagée
   (`newChapters()`). Le risque résiduel est l'inverse du précédent — un écran
   qui appellerait encore `chaptersBehind()` pour dire « nouveau » recommencerait
   le bug ; `read-state.test.js` interdit aux trois clients de faire l'arithmétique
   eux-mêmes.
3. **`reader.css` duplique ses jetons** par nécessité (§4.2). Le test de R1 doit
   donc vérifier que les valeurs du lecteur et celles de `theme.css` coïncident,
   sinon la dérive du §1.1 recommence exactement au même endroit.
4. **L'interface reste hors tests** au-delà des invariants de texte. R1→R5
   n'améliorent pas cette couverture ; c'est `B4`.
5. **Le poids des polices.** IBM Plex en trois familles (Sans, Sans Condensed,
   Serif) doit être sous-ensemblé, sinon le budget de démarrage de `E3` en pâtit.
