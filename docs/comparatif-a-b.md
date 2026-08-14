# Comparatif à l'aveugle — App A vs App B

**Date des tests :** 14 août 2026
**Méthode :** les deux applications sont désignées par A et B pendant toute l'analyse. La correspondance des noms est révélée à la dernière section, après la conclusion, pour que le verdict ne soit pas écrit à l'avance.

---

## 0. Honnêteté sur la méthode

Les deux applications n'ont **pas été évaluées dans les mêmes conditions**, et il faut le dire avant toute conclusion.

| | App A | App B |
|---|---|---|
| Installée et utilisée | ❌ non | ✅ oui, de bout en bout |
| Code lu | ❌ non (bundle propriétaire, jamais ouvert) | ✅ intégralement |
| Sources | fiche du store, manifeste de permissions, site officiel + FAQ, avis utilisateurs, fiche Android | manipulation réelle sur une instance isolée + lecture du code + suite de tests |
| Compte créé | ❌ non (création de compte interdite dans ce contexte) | ✅ compte jetable sur base de données jetable |

Conséquence directe : **les défauts de B sont mesurés, ceux de A sont rapportés.** Une liste de bugs plus longue pour B ne veut pas dire que B est plus buggé — ça veut dire que B est le seul des deux que j'ai pu casser moi-même. J'en tiens compte dans le verdict.

Ce que je sais de A avec certitude (chiffres du store, permissions, plateformes) est solide. Ce que je sais de sa qualité réelle vient des avis, donc c'est de la seconde main.

---

## 1. Carte d'identité

| | App A | App B |
|---|---|---|
| Extension navigateur | ✅ MV3, 204 Ko, v3.3.1 (05/08/2026) | ✅ MV3, v0.1.0 |
| Application Android | ✅ v6.10.0, 38,5 Mo, Android 7+ | ⚙️ coquille WebView écrite, jamais compilée |
| Application iOS | ✅ publiée | ⚙️ coquille WKWebView écrite, jamais compilée |
| Application web | ✅ | ✅ |
| Utilisateurs | ~10 000 | 6 comptes (dont le tien) |
| Note publique | 4,78 / 5 sur 119 avis | — |
| Première publication | 09/10/2023 | 2026 |
| Modèle éco | gratuit + premium (sauvegarde cloud + sync multi-appareils) | 100 % gratuit, auto-hébergé |
| Hébergement des données | serveurs de l'éditeur | ton propre serveur |

**Écart le plus important, et il n'est pas technique :** A est un logiciel fini, installable, avec trois ans de terrain et quatre plateformes qui tournent. B a le même périmètre de fonctionnalités sur le papier, mais deux de ses quatre plateformes n'ont jamais été compilées.

---

## 2. Le lecteur (reader mode)

C'est la fonction phare des deux.

| Capacité | App A | App B |
|---|---|---|
| Bande verticale (webtoon) | ✅ | ✅ |
| Page simple gauche→droite | ✅ | ✅ |
| Page simple droite→gauche (manga) | ✅ | ✅ |
| Double page | ✅ | ✅ |
| Détection auto du sens de lecture | ? | ✅ (par règle de site, avec toast à l'ouverture) |
| Autoplay + vitesse réglable | ✅ | ✅ (20→300) |
| Plein écran | ✅ | ✅ (touche `F`) |
| Zoom | ✅ | ✅ **qui ne revient jamais en place** |
| Drag / pan | ✅ | ✅ |
| Double-tap pour zoomer sur une case | ? | ✅ |
| Luminosité | ? | ✅ (30→130 %) |
| Contraste | ? | ✅ |
| Espacement entre pages | ? | ✅ (0→40 px) |
| Largeur de la bande | ? | ✅ |
| Zones de tap + inversion | ? | ✅ |
| Molette de chapitres + masquer les lus | ? | ✅ |
| Préchargement des pages suivantes | ? | ✅ |
| Raccourcis clavier complets | ? | ✅ (`?` pour l'aide) |
| Sans pub | ✅ | ✅ (59 règles de blocage) |

**Avantage B, nettement.** Sur les axes que A annonce, les deux sont à égalité. Sur tout ce que A n'annonce pas — luminosité, contraste, gap, zones de tap, molette de chapitres — B ajoute des réglages que A ne mentionne nulle part. Et le zoom de B a un comportement délibéré que je n'ai vu écrit nulle part chez A : le cadrage survit au changement de page. Sur une planche double, ça change vraiment la lecture.

**Réserve sérieuse :** le lecteur de B, je l'ai **lu, pas exécuté**. 1 467 lignes, aucun fichier de test dans la suite ne le couvre. Les 507 tests portent sur le serveur et la logique partagée ; l'interface du lecteur n'a jamais été testée automatiquement. Le lecteur de A, lui, tourne chez 10 000 personnes depuis trois ans. En confiance opérationnelle, c'est A qui gagne cette ligne, même si en fonctionnalités c'est B.

---

## 3. Détection de sites

Deux philosophies opposées, et c'est le point le plus intéressant du comparatif.

**App A** déclare ses scripts de contenu **site par site** dans son manifeste (mangafire.to, mangadex.org, atsu.moe, kagane.to, stonescape.xyz… la liste continue). Le site officiel annonce « un nombre illimité de sites », donc il y a probablement un enregistrement dynamique par-dessus, mais la liste figée est bien là.

**App B** ne liste pas les sites, elle **reconnaît les moteurs** : 4 familles (`manganato`, `themesia`, `madara`, `foolslide`) qui sont les thèmes WordPress et les lecteurs open-source derrière l'immense majorité des sites de scan. Une règle `madara` couvre mille hôtes que personne n'a eu à trouver. Par-dessus : 50 domaines nommés pour les cas particuliers, avec jokers (`*.sushiscan.fr`) qui survivent à un site qui passe en `ww6.`, et des heuristiques génériques pour tout le reste.

Le reproche n°1 dans les avis de A est : **« ajout lent des nouveaux sites »** et **« trous de compatibilité »**. L'architecture de B est la réponse structurelle exacte à ce reproche. Un site de scan qui change de nom du jour au lendemain casse une liste d'hôtes ; il ne casse pas une détection de moteur.

**Avantage B, sur l'architecture.** Mais A a 50 sites vérifiés à la main sur trois ans, et B a 50 domaines dont je n'ai testé que trois. L'idée est meilleure chez B ; la vérification est meilleure chez A.

---

## 4. Bibliothèque et organisation

| | App A | App B |
|---|---|---|
| Statuts de lecture | ✅ | ✅ 5 (Reading / Paused / Plan / Completed / Dropped) |
| Étagères personnalisées | ? | ✅ |
| Tags + filtrage par tag | ? | ✅ (puces cliquables avec compteur) |
| Tri | ? | ✅ 7 clés + sens (récent, ajout, titre, chapitre, retard, note, site) |
| Filtre « non lus seulement » | ? | ✅ |
| Recherche instantanée | ? | ✅ (filtre en direct, « 1 sur 5 ») |
| Note / score | ? | ✅ (★ /10) |
| Langue de l'œuvre | ? | ✅ (badge JA / KO) |
| Couleur par chapitre lu/non lu | ✅ (gris / orange / demi-orange) | ❌ **absent** |
| Ajout par URL avec remplissage auto | ? | ✅ titre + couverture + dernier chapitre |
| Couvertures | ✅ | ✅ via proxy avec réécriture du referer + rattrapage au check |

**Quasi-égalité, léger avantage B** sur la richesse du tri et du filtrage. Le seul manque net de B est le **code couleur par chapitre** de A (gris = lu, orange = suivant, demi-orange = partiellement lu). C'est une petite chose visuellement, mais c'est ce qu'on regarde en premier quand on rouvre une série, et B ne l'a pas.

---

## 5. Migration entre sites

Les deux annoncent la migration en masse. Chez B, je l'ai testée pour de vrai.

Série « Vinland Saga » posée sur un domaine volontairement mort. Boîte de dialogue → menu « Leaving » avec le compte par site (`sushiscan.fr (3)`, `mangas-origines.fr (1)`, `old-dead-site.test (1)`) → destination `sushiscan.fr` → **« 1 sur 1 trouvé »**, avec l'ancien et le nouveau titre côte à côte et une case à cocher → « Move selected » → **« 1 moved »**. La carte est passée sur sushiscan.fr, le titre d'origine a été conservé (elle n'a pas écrasé « Vinland Saga » par le titre SEO du nouveau site, ce qui était le piège), et l'ancienne source est archivée dans `previousSources`.

Ça marche, et c'est bien fait. Deux réserves mineures constatées : le menu déroulant ne se rafraîchit pas après la migration (il propose encore `old-dead-site.test (1)`), et la série garde le numéro de chapitre de l'ancien site jusqu'au prochain check.

Les avis de A citent justement le changement de site comme un de ses points forts (« continuer à lire quand un site ferme »). **Égalité, avec une exécution vérifiée chez B.**

---

## 6. Import / export / sauvegarde

| | App A | App B |
|---|---|---|
| Import depuis MyAnimeList | ✅ | ✅ (XML, y compris .gz) |
| Import depuis AniList | ✅ | ✅ (par pseudo) |
| Import depuis une autre app | ❌ « non supporté », passer par MAL/AniList | ❌ idem |
| Export fichier JSON | derrière le premium (backup cloud) | ✅ gratuit |
| Export XML MyAnimeList | ? | ✅ gratuit |
| Export CSV | ? | ✅ gratuit |
| Sauvegarde cloud auto | 💰 premium | ✅ le serveur est le tien |
| Sync multi-appareils | 💰 premium | ✅ inclus |

Testé chez B : les trois exports répondent 200 avec le bon `Content-Disposition` et un contenu correct — JSON 3,6 Ko, XML MAL 2,4 Ko, CSV 911 o avec 15 colonnes.

**Avantage B, franc.** Les deux fonctions que A facture (sauvegarde et sync) sont la base gratuite de B, et B sort trois formats là où A en propose un. Nuance honnête : la FAQ de A précise que « moins de 1 % des utilisateurs » passent au premium, donc ce n'est pas un mur payant agressif.

**⚠️ Mais l'export MAL de B a un bug grave — voir §9.2.**

---

## 7. Suivi, notifications, statistiques

| | App A | App B |
|---|---|---|
| Notifications de nouveaux chapitres | ✅ | ✅ Web Push, prouvé de bout en bout |
| Historique de lecture inter-sites | ✅ | ✅ (onglet dédié + effacement) |
| Sync MyAnimeList | ✅ | ✅ |
| Sync AniList | ✅ | ✅ |
| Sync MangaUpdates | ✅ | ❌ **absent** |
| Kitsu | ? | ❌ écarté volontairement (demande un mot de passe et non une page d'autorisation) |
| Temps de lecture total | ✅ | ✅ |
| Chapitres lus au total | ✅ | ✅ |
| Séries lues | ? | ✅ |
| Série en cours / record de jours consécutifs | ? | ✅ |
| Moyenne par jour de lecture | ? | ✅ |
| Note moyenne, relectures, « lecteur depuis » | ? | ✅ |
| Graphe 30 derniers jours | ? | ✅ |
| Répartition par statut | ? | ✅ |

**Statistiques : avantage B, large.** A annonce deux compteurs, B en affiche douze plus un graphe.

**Trackers : avantage A**, il en a trois, B en a deux. Et surtout, les trackers de B n'ont **jamais été branchés sur un vrai fournisseur** — aucun identifiant OAuth n'est configuré, le code du callback n'a donc jamais tourné en conditions réelles. Chez A, c'est en production depuis trois ans.

---

## 8. Lecture hors-ligne

A annonce le téléchargement de chapitres sur les quatre plateformes. **Les avis rapportent que la fonction ne marche pas** — c'est le reproche le plus concret qui ressort des retours utilisateurs.

B a le stockage hors-ligne écrit (`offline-store.js`, 272 lignes, couvert par un fichier de tests), mais je n'ai pas pu le déclencher dans cet environnement.

**Match nul par forfait des deux côtés.** L'un l'annonce et ses utilisateurs disent qu'elle est cassée, l'autre l'a codée sans que je puisse la faire tourner.

---

## 9. Défauts mesurés sur App B

Cette section n'a pas d'équivalent pour A. C'est le prix de l'asymétrie de méthode : je ne peux pas produire la même liste pour un logiciel que je n'ai pas exécuté.

### 9.1 🔴 Le « dernier chapitre » est faux, et faux différemment à chaque chargement

**Le plus gros problème trouvé.**

Page testée : la fiche Kagurabachi sur sushiscan.fr. Vrai dernier chapitre : **125** (les liens de chapitres de la page pointent bien sur `kagurabachi-chapitre-125`).

Deux chargements consécutifs de la même page, à quelques secondes d'intervalle :

```
run 1 (209 097 octets)  serveur=268   extension=268
      268  ← texte "En Cours Sakamoto Days Chapitre 268 7.9"
      125  ← href https://sushiscan.fr/kagurabachi-chapitre-125/

run 2 (209 650 octets)  serveur=1515  extension=1515
      1515 ← texte "En Cours Hajime no Ippo Chapitre 1515 8.5"
      125  ← href https://sushiscan.fr/kagurabachi-chapitre-125/
```

La bonne réponse est là, dans les `href`. Elle est écrasée par le carrousel « autres séries » de la page, qui tourne à chaque rechargement — d'où **1527, puis 336, puis 348, puis 168, puis 268, puis 1515** sur la même série. Dans l'interface, la carte Kagurabachi affiche aujourd'hui `latest ch.1527`.

**Cause précise, et elle est identique des deux côtés :**

- Serveur — `maxChapterIn()` dans `shared/panelflow-core.js` : deux expressions régulières sont essayées, la première sur les `href` (bonne), la seconde sur le texte (`>Chapitre 348`). Mais le maximum est **accumulé sur les deux** au lieu de s'arrêter dès que la première a donné un résultat. Le carrousel gagne.
- Extension — `latestChapterInDom()` dans `extension/content/detect.js:350` : restreint aux `<a href>` et `<option>`, ce qui est déjà mieux, mais fait `target.match(re) || text.match(re)` **par élément**. Les vignettes du carrousel sont des `<a>` dont le texte contient « Chapitre 1515 ». Même résultat.

> Le commentaire au-dessus de `latestChapterInDom` dit que l'app A lit la liste des chapitres, et qu'un maximum sur toute la page renvoie autre chose. Le diagnostic est juste — mais le code ne l'applique qu'à moitié.

**Portée :** `last_known_chapter` en base, les pastilles NEW, le tri « chapitres de retard », les notifications push envoyées pour rien, et l'export MyAnimeList (§9.2).

**Direction de correction :** dans les deux fichiers, prendre les correspondances `href`/`value` **s'il y en a**, et ne retomber sur le texte que s'il n'y en a aucune.

### 9.2 🔴 L'export MyAnimeList déclare des chapitres jamais lus

`backend/src/routes/export.js:133` :

```js
`    <my_read_chapters>${chapterNum(e.progress?.chapterLabel ?? e.lastKnownChapter)}</my_read_chapters>`
```

Sans progression enregistrée, il replie sur le dernier chapitre **paru**. Constaté : Blue Box, progression « Not started », le fichier exporté contient `<my_read_chapters>237</my_read_chapters>`. Le CSV du même export, lui, dit bien « Chapter read : (vide) — Latest chapter : 237 ». Donc l'information juste existe, elle est perdue à l'écriture du XML.

Combiné à §9.1, le fichier annoncerait **1527 chapitres lus** pour Kagurabachi.

Et le fichier porte `<update_on_import>1</update_on_import>` — sans quoi MAL ignorerait le fichier. Donc l'import **écrase** la progression réelle de l'utilisateur sur son compte MyAnimeList.

**C'est le défaut le plus grave des deux applications réunies**, parce que le dégât sort de l'application : il tombe sur un compte tiers, et il est irréversible sans sauvegarde MAL.

### 9.3 🟠 Les titres ne sont pas nettoyés

Le titre est pris tel quel dans `og:title` ou `<title>`. Résultat en base et dans toutes les cartes :

- `Blue Box Scan VF / FR Gratuit (Webtoon)`
- `Vinland Saga Scan VF / FR Gratuit (Webtoon)`

Ça déborde des cartes, ça pollue les trois exports, et ça s'affiche dans la liste de correspondances de la migration de site. `cleanTitle` existe mais ne coupe que la ponctuation aux extrémités.

### 9.4 🟠 Les sites en JavaScript sont invisibles côté serveur

MangaDex, fiche Sakamoto Days : le serveur récupère **6 067 octets** — la coquille de l'application, pas la page. Titre, couverture, dernier chapitre : tous `null`, aux deux essais.

L'extension, elle, lit le DOM réel et s'en sort. Mais le veilleur en tâche de fond et les notifications push passent par le serveur. Donc **sur un des plus gros sites du monde, la surveillance automatique de B est aveugle**. A déclare mangadex.org explicitement dans ses scripts de contenu.

### 9.5 🟠 Une page anti-bot est acceptée comme un succès

Quand Cloudflare renvoie son interstitiel, le scrape répond `200` avec `{"title":"Just a moment...","coverUrl":null,"latestChapter":null}` au lieu de signaler que le site est injoignable. L'utilisateur se retrouve avec une série nommée « Just a moment… » dans sa bibliothèque.

### 9.6 🟡 Thème sombre uniquement

Aucun `prefers-color-scheme`, aucun `data-theme`, aucun réglage. `background: rgb(20, 20, 28)` en dur. Sur un système en clair, l'app reste sombre. Défendable pour un lecteur de manga, mais c'est un choix imposé.

### 9.7 🟡 Barre d'outils à l'étroit en mobile

À 375 px, la bannière « 2 séries ont de nouveaux chapitres ! » est comprimée dans une colonne étroite à côté de cinq boutons et se casse sur quatre lignes. Le reste de la mise en page mobile est propre (grille deux colonnes, dialogues bien dimensionnés).

### 9.8 🟡 Petits accrocs

- Le menu de « Move a whole site » ne rafraîchit pas ses compteurs après une migration.
- Une série marquée **Completed** affiche quand même une pastille NEW.
- `/api/push/key` en 503 écrit une erreur en console alors que l'interface gère le cas proprement.

### 9.9 🟡 Toute l'interface est hors tests

507 tests sur 35 fichiers, **tous verts**. Mais aucun ne couvre `reader.js` (1 467 lignes), ni le contenu injecté, ni l'application web. La couverture s'arrête au serveur et à la logique partagée.

---

## 10. Défauts rapportés sur App A

Pour rester équilibré, voici ce que remontent ses utilisateurs (source : synthèse des avis du store) :

- **trous dans la détection de chapitres** — le même mal que §9.1, en moins spectaculaire d'après la formulation ;
- **trous de compatibilité de sites** ;
- **ajout lent des nouveaux sites** ;
- **le téléchargement ne fonctionne pas**.

Et un point que je peux vérifier moi-même, celui-là : le manifeste demande **`browsingData`** — la permission qui permet d'effacer l'historique, le cache et les cookies du navigateur — pour une extension de lecture de manga. Elle a été ajoutée en version 1.12.0. Ce n'est pas une accusation, il y a des usages légitimes (nettoyer les cookies d'un site de scan), mais c'est une permission que B ne demande pas.

Symétriquement, **B injecte ses scripts de contenu sur `<all_urls>`** — donc sur ta banque, ta boîte mail, tout — là où A les déclare site par site. B est plus intrusif sur ce point précis. Aucune des deux n'est irréprochable côté surface d'attaque.

---

## 11. Tableau de synthèse

| Critère | Gagnant | Écart |
|---|---|---|
| Plateformes réellement livrées | **A** | énorme |
| Maturité, éprouvé en production | **A** | énorme |
| Lecteur — fonctionnalités | **B** | net |
| Lecteur — fiabilité prouvée | **A** | net |
| Architecture de détection des sites | **B** | net |
| Couverture de sites vérifiée | **A** | modéré |
| Organisation de la bibliothèque | **B** | léger |
| Code couleur des chapitres lus | **A** | léger |
| Migration entre sites | égalité | — |
| Import / export / sauvegarde | **B** | net |
| Trackers externes | **A** | modéré |
| Statistiques | **B** | large |
| Notifications | égalité | — |
| Hors-ligne | égalité (par forfait) | — |
| Modèle économique | **B** | net |
| Propriété des données | **B** | net |
| Exactitude des données | **A** | **net** (voir §9.1 et §9.2) |
| Couverture de tests | **B** (507 côté serveur) | — |

---

## 12. Verdict

**Pour lire des mangas ce soir : App A.**

Pas parce qu'elle est mieux conçue — sur plusieurs points elle ne l'est pas. Parce qu'elle est **finie**. Elle s'installe sur téléphone et sur ordinateur, elle tourne chez dix mille personnes depuis trois ans, et le pire qu'on lui reproche est qu'elle ajoute les nouveaux sites trop lentement et que son téléchargement est cassé. Ce sont des manques, pas des mensonges sur tes données.

App B, aujourd'hui, écrit `1527` là où il faut lire `125`, et si tu exportes ta bibliothèque vers MyAnimeList, elle déclare que tu as lu des centaines de chapitres que tu n'as jamais ouverts, en écrasant ton vrai compte. Une application de suivi qui se trompe sur le suivi n'est pas encore une application de suivi.

**Pour la suite : App B, sans hésiter.**

C'est le meilleur socle des deux, et ce n'est pas serré. Sa détection par moteur est la réponse structurelle au reproche n°1 de A. Son lecteur a plus de réglages, et son zoom qui ne se recadre pas est le genre de détail qu'on ne trouve que quand quelqu'un lit vraiment des mangas avec. Sa page de statistiques est six fois plus riche. Elle donne gratuitement les deux fonctions que A facture. Et 507 tests verts sur le serveur, c'est un filet que peu de projets de cette taille ont.

**Et surtout : ce qui sépare B de A, c'est trois bugs, pas trois ans.**

1. §9.1 — préférer les `href` aux textes de page dans les deux détecteurs de chapitre. **Une condition à déplacer, dans deux fichiers.**
2. §9.2 — ne jamais exporter le dernier chapitre paru comme chapitre lu. **Une ligne.**
3. §9.3 — nettoyer les titres SEO. **Une fonction, qui existe déjà à moitié.**

Ces trois-là faits, mon classement s'inverse sur la partie logicielle et B devient le meilleur produit des deux — il resterait le vrai fossé, celui qui n'est pas un bug : **A est installable sur un téléphone, B non**, tant que les deux coquilles mobiles n'ont jamais été compilées.

Alors si la question est « laquelle je choisirais », la réponse honnête est en deux temps :

> **Aujourd'hui A. Après ces trois correctifs, B — pour tout sauf le téléphone. Et B partout le jour où les applications mobiles sortent.**

---

## 13. Levée de l'anonymat

- **App A = MangaPin** (EndyQ Studio / MOE APPS)
- **App B = PanelFlow**

Rappel de contexte : la surface fonctionnelle de MangaPin a servi de référence, mais aucune ligne de son code n'a été copiée — le code de PanelFlow est écrit de zéro, et le bundle de MangaPin n'a jamais été ouvert. Ce comparatif n'a rien changé à ça : App A n'a été observée que par sa fiche publique, sa documentation et ses avis.

---

## Annexe — conditions de test

- Instance PanelFlow isolée sur `http://localhost:8788`, base de données jetable via `PANELFLOW_DATA_DIR` pointé dans le dossier temporaire. `backend/data/panelflow.db` n'a jamais été ouvert en écriture.
- Compte jetable, 5 séries de test sur sushiscan.fr, mangas-origines.fr et un domaine volontairement mort.
- Suite de tests : `npm --prefix backend test` → **507 / 507**, 8,0 s.
- Détection de chapitres mesurée avec un script qui rejoue les deux algorithmes (serveur et extension) sur le même HTML, deux fois de suite.
- Kaspersky et Cloudflare bloquent une partie des sites de scan depuis cette machine ; les pages ont donc été récupérées par le `fetchPage` du backend lui-même, pas par le navigateur.
