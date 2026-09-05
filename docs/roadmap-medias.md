# Feuille de route — light novels et animes

**But :** que PanelFlow suive trois sortes d'œuvres au lieu d'une, sans que la
bibliothèque, les trackers ou le lecteur aient à deviner laquelle ils regardent.

Ce document complète [`roadmap.md`](roadmap.md), qui reste la référence pour les
phases A→F (beta, téléphone, distribution). Les invariants du §0 de ce fichier-là
s'appliquent ici sans exception — en particulier « `shared/` est la source » et
« une règle testée est extraite du fichier livré ».

---

## 0. Ce que l'audit a trouvé avant d'écrire ce plan

Trois faits mesurés dans le dépôt, pas supposés. Ils décident de tout le reste.

**Les light novels sont déjà à moitié construits.** `extension/content/detect.js`
a une section « prose chapters » complète (conteneur, planchers de longueur,
densité de navigation), `reader.js` sait rendre du texte (`state.novel`,
`paragraphs`, `screens`, un curseur de taille de police), et `shared/compat.js`
rend le même verdict côté serveur depuis du markup brut. Trois fichiers de tests
couvrent déjà ce chemin. **Ce qui manque n'est pas la lecture, c'est tout ce qui
vient après.**

**Rien dans le modèle ne dit de quelle sorte d'œuvre il s'agit.** Ni le schéma
`shared/schemas/library-entry.schema.json` (17 champs, aucun ne nomme le média),
ni la table `library` en base. Une entrée est implicitement « un manga sur un
site de scan ». Un light novel ajouté aujourd'hui est indiscernable d'un manga ;
un anime le serait aussi.

**Les trackers sont câblés en manga, à six endroits.** `type: MANGA` dans les
requêtes AniList (`tracker-push.js` l. 64 et 96, `routes/import.js` l. 23) et
`/v2/manga/` dans les appels MyAnimeList (l. 200, 223, 155, 205).

Conclusion : **une seule décision structurelle débloque les deux fonctionnalités**,
et tant qu'elle n'est pas prise, tout le reste est du travail à refaire.

---

## 1. La décision qui gouverne tout : `medium`

Un champ, trois valeurs : `manga` (défaut), `novel`, `anime`.

### Pourquoi un champ et pas une étagère

Un dossier (`folder`) dit *où en est le lecteur*. Le média dit *ce que la chose
est*. Les confondre reproduirait exactement le bug que `ARCHITECTURE.md` décrit
pour les catégories : « deux colonnes admettent un état où une entrée est dans un
dossier intégré *et* sur une étagère, et alors chaque ligne d'onglet doit décider
quel mensonge raconter ».

Un média ne change jamais après la création — une adaptation anime d'un manga est
**une autre entrée**, pas la même qui change de nature. C'est ce qui le rend sûr
comme clé de routage.

### Pourquoi `manga` par défaut et non `null`

Toute la bibliothèque existante est du manga. Un défaut nul obligerait chaque
lecture à répondre « je ne sais pas », et la première chose que ferait chaque
client serait de le traiter comme du manga — c'est-à-dire écrire la règle à
quatre endroits au lieu d'un.

### Où il vit

| Endroit | Ce qu'il faut faire |
|---|---|
| `shared/schemas/library-entry.schema.json` | ajouter `medium`, énuméré, défaut `manga` |
| `backend/src/db.js` | `ALTER TABLE library ADD COLUMN medium` via `migrate()`, jamais à la main |
| `shared/prefs.js` | rien — c'est une propriété de l'œuvre, pas du lecteur |
| `shared/library-view.js` | un filtre par média, à côté des tags |

**Critère d'acceptation.** Une bibliothèque existante migre sans qu'aucune entrée
ne change d'apparence. Un test vérifie que la colonne arrive par migration et non
par recréation de table.

---

## 2. Phase G — les light novels finissent ce qu'ils ont commencé 🟢

La phase la moins chère du document : le lecteur existe, il faut le reste.

### G1 — Le média est détecté, pas deviné

`detect.js` sait déjà qu'il regarde de la prose (`novelContent()` répond). Ce
verdict doit atterrir dans l'entrée à la création, dans `addToLibrary`.

**Fichiers.** `shared/panelflow-core.js` (`addToLibrary`), `extension/content/detect.js`
(passer le verdict dans `meta`), `shared/compat.js` (même champ dans `analyze`).

**Piège.** Comme pour `cleanTitle`, ce doit être **à la création uniquement**.
Ré-ajouter une entrée est aussi la façon dont la modale enregistre : quelqu'un qui
a corrigé le média à la main ne doit pas se le faire reprendre au prochain
Enregistrer.

**Tests.** Une page de chapitre dessinée → `manga`. Une page de roman → `novel`.
Une correction manuelle survit à un ré-ajout.

### G2 — « Chapitre » n'est pas le bon mot partout

Un light novel a des **volumes** et des **chapitres**, et les sites de romans
comptent souvent en volumes. `shared/site-rules.js` a déjà `volumeNumber()`, et
`backend/test/volume-pages.test.js` existe — donc la brique est là, elle n'est
pas branchée sur l'affichage.

**Travail.** Le libellé d'une progression demande au média comment se nommer. Une
seule fonction, dans `shared/`, parce que le popup, le site et le téléphone
doivent dire le même mot.

**Ce qu'on ne fait pas.** Inventer une hiérarchie volume→chapitre en base. La
progression reste une chaîne libre (`chapterLabel`) : c'est ce qui lui permet de
survivre à un site qui compte autrement, et la contrainte a déjà été payée.

### G3 — Des règles pour les sites de romans

`shared/detection-rules.json` a 50 domaines, **aucun n'est un site de romans**. Le
moteur générique les attrape déjà (c'est tout l'intérêt des heuristiques), mais
sans règle par domaine la précision est celle du zéro-shot.

**Travail.** Ajouter une poignée de sites de light novels au fichier de règles, en
suivant `.claude/skills/add-site/SKILL.md` — « ajouter un moteur, pas un nom
d'hôte » : les sites de romans partagent quelques thèmes CMS, donc un `engine`
couvre plus qu'un domaine.

**Rappel de contrainte.** Un tiers des sites sont bloqués depuis ce poste
(antivirus, Cloudflare) : ne pas conclure « le site est mort » d'ici.

### G4 — Les trackers savent que c'est un roman

AniList traite les light novels comme `type: MANGA` avec un `format: NOVEL` ;
MyAnimeList les met sous `/v2/manga/` avec un `media_type`. **Donc les six points
câblés en dur ne sont pas tous à changer** — c'est le `format` qui compte, pas le
`type`. À vérifier avant de coder : c'est le genre de détail qui, mal lu, envoie
la progression d'un roman sur l'entrée manga du même titre.

**Rappel §0.5.** Jamais d'écriture sur un compte tracker de production pendant le
développement. Une écriture sur un compte tiers est irréversible sans sauvegarde.

---

## 3. Phase H — les animes, et pourquoi c'est un autre produit 🔴

**À lire avant d'écrire une ligne de code.** Cette phase n'est pas la suite de la
précédente ; c'est un changement de nature, et deux choses le rendent risqué.

### H0 — Ce que ça coûte à la position du produit

`docs/ARCHITECTURE.md` §« Store compliance » dit, en toutes lettres :

> The app is a **browser with a reading mode**, not a content aggregator: no
> hosted catalog, no featured sites, no content indexing. Position it exactly
> like Safari Reader / Firefox Reader View in review notes.

Cette phrase est ce qui rend l'app défendable devant Apple et Google. Un mode
lecture sur une page que l'utilisateur a lui-même ouverte est un précédent établi
(Safari Reader). **Un lecteur vidéo sur des sites de streaming n'a pas ce
précédent.** Les deux stores sondent explicitement sur la facilitation du piratage,
et la vidéo est le terrain où ils sont les plus durs.

Ce n'est pas un avis juridique et je n'en donne pas. C'est le constat que la
phrase ci-dessus a été écrite pour tenir un examen, et qu'ajouter la vidéo la
rend fausse. **Trois issues possibles, à trancher avant de coder :**

1. **Suivi seulement, sans lecture.** PanelFlow enregistre qu'un épisode a été vu,
   la progression, l'envoi au tracker — et n'affiche jamais de vidéo. La position
   « navigateur » est intacte, le tracker AniList/MAL gagne sa moitié anime, et
   c'est de loin le moins cher. **C'est ce que je recommanderais de faire d'abord.**
2. **Lecture vidéo dans l'extension seulement**, jamais dans les apps de store.
   Chrome MV3 est nettement plus permissif que l'App Store sur ce point.
3. **Lecture partout**, en assumant de réécrire les notes de revue et de
   probablement perdre iOS. À ne choisir qu'en connaissance de cause.

### H1 — Ce qui se réutilise, et ce qui ne se réutilise pas

**Se réutilise tel quel :** la bibliothèque, les dossiers, les étagères, la
déduplication, la migration entre sites, les statistiques, le veilleur de
nouveaux épisodes (c'est le même « quelque chose est sorti »), le Web Push, les
trackers, l'export.

**Ne se réutilise pas :** le lecteur. `reader.js` est bâti sur une bande d'images
ou un flot de paragraphes ; une vidéo n'est ni l'un ni l'autre. Pas de zoom, pas
de pagination, pas de zones de tap — mais une position en secondes, un volume, des
sous-titres, une reprise à la seconde près.

**Le point de conception à ne pas rater :** `progress.chapterLabel` est une chaîne
libre et `page`/`pageCount` sont des entiers. Une position vidéo est un nombre de
secondes. **Ne pas réutiliser `page` pour ça** — ce serait un champ qui veut dire
deux choses, et c'est le motif que `folderStatus` et `medium` existent tous les
deux pour éviter. Un champ `seconds`, nul pour tout ce qui n'est pas une vidéo.

### H2 — La détection d'un épisode

Le pendant de `detect.js` pour la vidéo : reconnaître qu'une page est un épisode
plutôt qu'une page de série. Les signaux existent et sont différents — un
`<video>` ou un `<iframe>` de lecteur, un numéro d'épisode dans l'URL, une
navigation épisode suivant/précédent.

**À écrire là où le reste vit** : une section de plus dans `detect.js`, sous les
mêmes poids et le même seuil que le fichier de règles distribue, et un `compat.js`
qui rend le même verdict depuis du markup. Les deux doivent rester d'accord — un
test verrouille déjà les constantes de prose entre les deux fichiers, le même
verrou vaudra ici.

### H3 — Le veilleur, sans nouvelle requête

`backend/src/routes/watch.js` cherche « le dernier chapitre » sur une page de
série. Pour un anime c'est « le dernier épisode », et c'est la même opération. Le
veilleur tourne déjà avec `ETag`/`Last-Modified` et un budget mural — **ne pas
lui ajouter un second passage** : le média décide de quoi on parle, la boucle ne
change pas.

---

## 4. Ordre d'exécution recommandé

```
    medium            ← la décision, avant tout le reste
      │
      ├── G1 détection ─→ G2 vocabulaire ─→ G3 règles de sites ─→ G4 trackers
      │                                                              │
      │                                     light novels finis ──────┘
      │
      └── H0 la décision produit (suivi seul / extension / partout)
              │
              └── si suivi seul : G4 suffit, H1–H3 tombent
              └── sinon : H1 lecteur ─→ H2 détection ─→ H3 veilleur
```

**Pourquoi cet ordre.** Les light novels sont peu chers et prouvent le champ
`medium` sur un cas réel avant que la vidéo n'en dépende. Et si H0 se conclut par
« suivi seulement », la moitié de la phase H disparaît — ce qui est une raison de
plus de trancher H0 avant d'écrire du code, pas après.

**Ce qui reste prioritaire par-dessus tout ça :** la phase C de `roadmap.md`. Les
coques téléphone n'ont **jamais été compilées**, et neuf corrections récentes
vivent dedans sans qu'aucun compilateur ne les ait vues. Ajouter des médias à un
produit dont deux façades sur quatre ne démarrent pas, c'est élargir avant de
poser.

---

## 5. Définition de « fini »

**Light novels.** Un roman ajouté depuis un site inconnu se range comme roman,
s'affiche avec le bon vocabulaire, ouvre le lecteur texte, avance sa progression,
et arrive sur AniList sous le bon format. Une bibliothèque de manga existante est
inchangée, à l'octet près.

**Animes.** Dépend de H0, et ne peut pas être défini avant. Si « suivi seulement » :
un épisode vu s'enregistre et remonte au tracker, et rien dans l'app ne lit de
vidéo — y compris sur les téléphones, où c'est la condition de la soumission.
