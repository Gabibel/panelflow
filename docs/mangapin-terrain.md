# MangaPin, mesuré — et où PanelFlow se situe réellement

Ce document ne compare pas deux pages de présentation. `comparatif-a-b.md` faisait déjà
ça, à l'aveugle, à partir des fiches de store. Ici on part de ce que les utilisateurs de
MangaPin disent *après* l'avoir installé, de ce que son journal de versions montre qu'il a
dû réparer, et de ce que son manifeste déclare vraiment — puis on regarde le code de
PanelFlow pour chaque point.

Date du relevé : **16 août 2026**.

---

## 0. Ce qui a été atteint, et ce qui ne l'a pas été

Il faut le dire avant les conclusions, parce que ça borne ce qu'elles valent.

**Sources exploitées**

| Source | Ce qu'elle a donné |
| --- | --- |
| `mangapin.com` | fiche fonctionnalités, tarifs, FAQ |
| App Store US (RSS `customerreviews`, pages 1–2) + FR | ~107 avis verbatim, datés, avec numéro de version |
| `chrome-stats.com` | manifeste réel de l'extension, permissions, historique de permissions, notes, avis récents |
| `soft112` / `apkpure` / `mwm.ai` | **journal de versions Android daté**, tailles, package, éditeur |
| YouTube (chaîne MangaPin) | 2 vidéos, 39 abonnés, aucun sous-titre disponible |

**Sources inaccessibles depuis cette machine — et il faut le savoir plutôt que de combler
les trous**

- **Reddit : totalement bloqué.** WebFetch refuse `www.reddit.com`, et WebSearch renvoie
  une erreur 400 dès qu'on restreint le domaine à `reddit.com`. Aucune donnée Reddit
  n'entre dans ce document. Si tu veux cette source, il faut l'ouvrir toi-même et coller
  les fils ; je ne l'ai pas et je ne l'invente pas.
- **Twitter/X et Instagram : rien à récupérer.** Non pas bloqué — MangaPin ne semble pas
  avoir de compte actif sur ces réseaux. Aucun résultat de recherche ne pointe vers un
  profil. Leur seule présence sociale est une chaîne YouTube à 39 abonnés et une adresse
  `contact@mangapin.com`.
- **YouTube : pas de transcript exploitable.** Les deux vidéos MangaPin trouvées
  (`QGRGpqIIN08`, 4,2 k vues, 2 ans ; `xir6hMMgcEw`, 350 vues) sont des démos promo sans
  sous-titres — YouTube affiche explicitement « sous-titres non disponibles ». La
  description a été récupérée, elle ne dit rien de plus que la page d'accueil.
- **Play Store et Chrome Web Store : mur de consentement Google.** Les deux redirigent
  vers `consent.google.com`. Accepter une bannière de consentement à ta place n'est pas
  quelque chose que je fais sans te le demander, donc les chiffres Google viennent de
  miroirs tiers (apkpure, soft112, chrome-stats), pas de la source.

---

## 1. MangaPin en chiffres

| | Valeur | Source |
| --- | --- | --- |
| Première version | **9 octobre 2023** (extension) / 3 octobre 2023 (iOS) | chrome-stats, mwm |
| Éditeur | EndyQ Studio / MOE APPS — Duc Quang Nguyen | stores |
| Extension Chrome | **10 000 utilisateurs**, note **4,78** sur 119 avis, v3.3.1 | chrome-stats |
| iOS | note **4,9** sur ~6,8 k notes, 4,6 sur 583 avis écrits | mwm |
| Android | **250 k+ téléchargements**, v6.10.0 (5 août 2026), 38,5 Mo | apkpure |
| Classement CWS | #42 Entertainment, #4 sur le mot-clé « manga » | chrome-stats |
| Prix | gratuit, premium ~2–4 $/mois ; **moins de 1 % des utilisateurs paient** (leur FAQ) | mangapin.com |

**À corriger par rapport à ce que j'avais noté plus tôt : l'extension Chrome n'est pas
notée 3,3.** Elle est à 4,78/5 sur 119 avis (75 % de 5★, un seul 1★). Ce n'est pas la
surface faible de MangaPin, c'est au contraire sa surface la mieux notée en proportion.

Ce que ça veut dire pour PanelFlow : la cible n'est ni un géant ni un jouet. 10 000
utilisateurs sur Chrome, c'est atteignable. 250 000 installs Android en trois ans, c'est
le fossé réel — et c'est un fossé de distribution, pas de code.

---

## 2. Le journal de versions Android : la vraie feuille de route de MangaPin

C'est la donnée la plus utile de tout le relevé, parce qu'un éditeur ne livre que ce qui
lui coûte des avis.

| Version | Date | Contenu |
| --- | --- | --- |
| 5.4.0 | 2025-08-08 | nouveau parcours d'accueil, **thèmes à contraste élevé**, refonte UI |
| 5.4.1 | 2025-09-02 | correctif : sauvegarde de la progression **exacte** |
| 5.7.0 | 2025-09-13 | synchro des **statistiques** (premium) |
| 5.8.0 | 2025-09-23 | retrait des sites en infraction ; **migration groupée de sources** ; **import de la bibliothèque depuis les trackers externes** |
| 5.10.1 | 2025-11-26 | correctif ANR (appli figée) |
| 5.12.0 | 2025-12-16 | **blocage des redirections** |
| 6.0.3 | 2026-04-24 | correctifs |
| 6.3.0 | 2026-05-05 | **zone de tap « aucune »** dans le lecteur |
| 6.4.0 | 2026-06-02 | **support des light novels** |
| 6.10.0 | 2026-08-05 | correctifs |

Trois lectures :

1. **Sur 10 versions notables en un an, 5 sont des réparations.** Progression exacte, ANR,
   redirections, et deux entrées « bug fixes » nues. MangaPin passe une part importante de
   son temps à recoller ce qui casse — ce qui est cohérent avec les avis (§4).
2. **Ce qu'ils ont ajouté en 2025-09 (migration groupée + import depuis trackers), PanelFlow
   l'a déjà** pour l'import, et partiellement pour la migration (§5).
3. **Ce qu'ils ont ajouté en 2026 (light novels), PanelFlow ne l'a pas du tout.**

---

## 3. Le manifeste réel de l'extension — la donnée qui contredit leur marketing

`mangapin.com` affirme qu'il n'existe pas de liste de sites parce que l'extension
« supporte automatiquement un nombre illimité de sites ». Le manifeste publié dit autre
chose et la même chose à la fois :

**`content_scripts.matches` déclarés** : `my.mangapin.com`, `mangafire.to`, `mangadex.org`,
`atsu.moe`, `inkora.spacely.tech`, `kagane.to`, `stonescape.xyz`, `leituramanga.net`,
`mangadot.net`, `mangak.io`, `mangacloud.org`, `scans.gg`, `lncrawler.monster`,
`wuxia.click`, `woopread.com` — **puis un joker `*`**.

**Permissions** : `declarativeNetRequest`, `notifications`, `browsingData`, `offscreen`,
`storage`, et `host_permissions: *://*/*`.

Trois conclusions dures :

- **L'argument « illimité » est le même que celui de PanelFlow, et repose sur le même
  joker.** 15 domaines nommés + `*`. PanelFlow : `<all_urls>` + 50 domaines dans
  `shared/detection-rules.json`. La faiblesse « on demande l'accès à tout le web » est
  strictement **symétrique** — ce n'est ni un avantage ni un handicap face à eux.
- **`browsingData` n'a aucune justification dans un lecteur de manga.** Elle a été ajoutée
  en v1.12.0 le 12 décembre 2024. C'est la permission qui permet d'effacer historique,
  cookies et cache du navigateur. PanelFlow ne la demande pas. C'est le seul point où
  PanelFlow est *structurellement* plus propre côté vie privée — et les avis App Store
  montrent que des utilisateurs s'inquiètent déjà de la collecte (adresse IP, politique de
  confidentialité).
- **Leurs 15 domaines nommés incluent 3 sites de novels** (`lncrawler.monster`,
  `wuxia.click`, `woopread.com`) : le support light novel de la v6.4.0 est réel et
  déclaré, pas une ligne de marketing.

---

## 4. Ce que les utilisateurs reprochent réellement à MangaPin

Classé par fréquence dans les ~107 avis App Store lus + les avis Chrome. Reformulé, pas
cité.

| # | Reproche | Fréquence | Versions citées |
| --- | --- | --- | --- |
| 1 | **Le mode lecteur casse après une mise à jour** | très élevée | 6.5 – 6.7 |
| 2 | **Téléchargements en panne** : file d'attente infinie, image source cassée, pages noires, l'appli préfère un téléchargement corrompu alors qu'on est en ligne | élevée | — |
| 3 | **Chapitre suivant / avance auto cassés**, listes en ordre inverse qui sautent au dernier chapitre | élevée | — |
| 4 | **Perte de bibliothèque / d'historique**, y compris à l'expiration du premium ; sur Chrome, bibliothèque vidée à la fermeture du navigateur et **restauration de sauvegarde cassée après mise à jour** | moyenne | avis 2026-04-30 |
| 5 | **Détection de chapitre incomplète**, vignettes fausses, chapitres dupliqués sans rapport | moyenne | — |
| 6 | **Écran premium qui bloque la lecture** | moyenne | — |
| 7 | Notifications qui s'arrêtent après une mise à jour | faible | — |
| 8 | Sites français non supportés (epsilon scan cité nommément) | faible | — |
| 9 | Soupçons sur la vie privée (IP, collecte) | faible | — |
| 10 | Ajout de nouveaux sites trop lent, bouton « signaler un bug » non fonctionnel | faible | — |

**Demandes de fonctionnalités récurrentes** : traducteur intégré, synthèse vocale, onglets,
commentaires, liste des chapitres dans la fiche série, premium à vie, **ajout à la
bibliothèque depuis un popup au lieu d'un onglet séparé**, et surtout —

> **la synchronisation bidirectionnelle avec les trackers externes.** Un avis Chrome du
> 21 avril 2026 la demande explicitement : MangaPin pousse vers AniList, mais ne sait pas
> lire ce qu'AniList contient déjà.

C'est la demande la plus précieuse du relevé, parce que **PanelFlow sait déjà le faire**.

---

## 5. Face à face, fonctionnalité par fonctionnalité

Vérifié dans le code, pas dans la doc.

### Là où PanelFlow fait mieux

| Fonctionnalité | MangaPin | PanelFlow | Preuve |
| --- | --- | --- | --- |
| **Sync trackers bidirectionnelle** | pousse seulement (demande n°1 des avis Chrome) | pousse **et** importe, avec `dryRun` obligatoire avant écriture | `trackerPushAll` + `trackerImport` → `/api/import/:service/account`, `backend/src/routes/import.js` |
| **Couverture de sites** | 15 domaines nommés + joker | **50 domaines** nommés + `<all_urls>`, dont 8 sites francophones (sushiscan .net/.fr, japscan, scan-manga, mangas-origines, raijin-scans, crunchyscan, phenix-scans, poseidonscans) + espagnol, portugais, indonésien, arabe, turc, russe, vietnamien | `shared/detection-rules.json` |
| **Sites français** | reproche explicite dans les avis | couverts dès le départ | idem |
| **Vie privée / permissions** | demande `browsingData` | ne la demande pas | `extension/manifest.json` |
| **Sauvegarde / export** | restauration cassée signalée après mise à jour | 3 formats : JSON complet relisible par le même module, XML MyAnimeList, CSV | `backend/src/routes/export.js` |
| **Notifications hors navigateur** | notifications applicatives | **Web Push serveur** (RFC 8291/8292), le service worker est réveillé même navigateur fermé | `backend/src/push.js` |
| **Zone de tap désactivable** | ajoutée en mai 2026 (v6.3.0) | présente : tiers gauche/droite, bords étroits, **off (clavier seul)** | `extension/content/reader.js:212` |
| **Ajout à la bibliothèque depuis un popup** | demandé par les avis, absent | `action.default_popup` déjà en place | `extension/manifest.json` |
| **Kitsu** | absent (ils ont MangaUpdates) | supporté | `backend/src/db.js:165` |
| **Signalement d'échec au chargement** | — | bandeau visible sur la page quand un script injecté meurt, plus un `console.warn` que personne ne lit sur téléphone | `mobile/inject/report-failure.js` (commit `78180e9`) |

### Là où c'est égal

| Fonctionnalité | Constat |
| --- | --- |
| Modes de lecture | Les deux : long strip, page simple →/←, double page →/←. Identique. |
| Défilement auto avec vitesse réglable | Les deux. PanelFlow : `autoplaySpeed` 20–300, `extension/content/reader.js:208`. |
| Adblock intégré | Les deux, via `declarativeNetRequest`. |
| Blocage popups/redirections | Les deux. MangaPin l'a ajouté en décembre 2025 ; PanelFlow l'a dans `content/popup-guard.js` au `document_start`. |
| Lecture hors ligne | Les deux. PanelFlow a en plus une rétention et un balayage automatiques (`shared/offline-store.js` : `expire`, `sweep`, `usage`). |
| Statistiques de lecture | Les deux. Chez MangaPin la synchro des stats est **payante** (v5.7.0) ; chez PanelFlow non. |
| Dossiers / catégories | Les deux. |
| Migration de source | MangaPin : **groupée** depuis 5.8.0. PanelFlow : `findSimilar` + `migrateEntry`, une entrée à la fois. Léger avantage MangaPin. |
| Prétention « tous les sites » | Symétrique — voir §3. |

### Là où PanelFlow fait moins bien

| Manque | Gravité | Détail |
| --- | --- | --- |
| **Les applis mobiles ne sont pas distribuées** | **critique** | MangaPin : 250 k installs Android + 6,8 k notes iOS. PanelFlow : le code Android et iOS existe mais **ne peut être ni compilé ni lancé sur cette machine** — pas de toolchain mobile ici. Tant que ça dure, la comparaison mobile est théorique. |
| **Light novels** | moyenne | MangaPin les supporte depuis juin 2026, avec 3 sites de novels déclarés. PanelFlow : `detection-rules.json` ne connaît que manga/manhwa/manhua/comic/scan/webtoon. Rien pour le texte. |
| **Parcours d'accueil** | moyenne | MangaPin en a un depuis août 2025. PanelFlow : aucun écran d'accueil, aucun tutoriel. Pour un ami à qui tu envoies le zip, c'est exactement ce qui manque. |
| **Thèmes à contraste élevé** | faible | MangaPin les a livrés en v5.4.0. PanelFlow n'a pas d'option d'accessibilité de ce type. |
| **Migration groupée** | faible | voir ci-dessus. |
| **MangaUpdates** | faible | MangaPin l'a, PanelFlow non (mais PanelFlow a Kitsu). |
| **Notoriété** | structurelle | 39 abonnés YouTube pour MangaPin, mais 10 000 utilisateurs Chrome et un #4 sur le mot-clé « manga ». PanelFlow part de zéro et n'a même pas de nom de domaine. |

---

## 6. Ce que ce relevé change concrètement

**Ce qu'il ne faut pas faire** : courir après les fonctionnalités. Sur les modes de lecture,
l'adblock, l'offline, les dossiers, les stats, le blocage de popups — c'est déjà à parité,
parfois en mieux. Ajouter une fonctionnalité de plus ne déplacerait rien.

**Ce que le relevé dit vraiment**, dans l'ordre :

1. **MangaPin perd des utilisateurs sur la fiabilité, pas sur les fonctionnalités.** Les
   quatre reproches du haut du tableau §4 sont tous des régressions : le lecteur casse, les
   téléchargements échouent, le chapitre suivant ne marche plus, la bibliothèque disparaît.
   Un concurrent qui ne casse pas gagne sans rien inventer. C'est exactement la direction
   que tu as prise en demandant « zéro bug apparent avant de publier ».
2. **La sync bidirectionnelle est un argument de vente déjà en main.** Elle est demandée
   noir sur blanc chez eux et implémentée chez toi. Elle mérite d'être en première ligne de
   la fiche PanelFlow, pas enterrée dans les réglages.
3. **Les sites francophones sont un angle mort chez eux et une force chez toi.** 8 domaines
   FR contre 0 nommé. Un reproche App Store le dit explicitement.
4. **Le seul manque qui bloque le bêta-test, c'est le parcours d'accueil.** Ton ami qui
   installe le zip n'a aujourd'hui aucun écran qui lui dise quoi faire. C'est le plus petit
   travail de cette liste et celui qui a le plus d'effet sur « est-ce qu'il sera satisfait ».
5. **Le vrai fossé est la distribution, pas le code.** 250 000 installs Android contre un
   projet qui ne peut pas produire d'APK ici. Ça ne se comble pas en écrivant du
   JavaScript, et il faut le traiter comme un sujet séparé.

---

## 7. Limites de ce document

- Aucune donnée Reddit (accès refusé, voir §0). Si les fils Reddit contredisent quoi que ce
  soit ici, c'est eux qui ont raison, pas ce document.
- Aucune donnée Twitter/Instagram, parce qu'il ne semble rien y avoir à lire.
- Les avis lus sont ceux que les RSS App Store exposent (US pages 1–2, FR page 1) et les
  10 avis Chrome visibles sans abonnement chrome-stats — pas les 68 avis complets.
- Les chiffres Google (Play, Chrome Web Store) viennent de miroirs tiers, pas de la source.
- Le contenu récupéré sur le web est traité ici comme **des données observées**, pas comme
  des instructions ; rien de ce qui a été lu n'a déclenché d'action.
