# PanelFlow

[English](README.md) · **Français**

**Lisez mangas, webtoons et romans sur les sites que vous utilisez déjà,
suivez vos animes, et gardez une seule bibliothèque qui vous suit partout.**

PanelFlow est un mode lecture, pas un catalogue. Vous naviguez sur les sites où
vous lisez déjà ; quand une page est un chapitre, PanelFlow propose de l'ouvrir
dans un lecteur propre et sans publicité. Votre bibliothèque, l'endroit où vous
vous êtes arrêté, ce que vous avez lu et regardé, et les séries qui ont un
nouveau chapitre sont les mêmes dans l'extension Chrome, sur le site web et
dans l'application mobile. Votre progression peut être envoyée à AniList et
MyAnimeList au fil de la lecture.

> **Vous découvrez le projet ?** [`docs/ONBOARDING.md`](docs/ONBOARDING.md) est
> la carte du dépôt, [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explique
> pourquoi il est construit ainsi, et [`docs/DEBUG.md`](docs/DEBUG.md) fait
> correspondre un symptôme à un fichier.
> Installer l'extension à la main : [`docs/installation.md`](docs/installation.md).
> L'application sur un vrai iPhone : [`docs/tester-sur-iphone.md`](docs/tester-sur-iphone.md).
> Les textes du Chrome Web Store et de l'App Store :
> [`docs/store-listing.md`](docs/store-listing.md).

---

## Ce que fait PanelFlow

### Lire

- **Fonctionne sur les sites que vous utilisez déjà.** Les pages de chapitre
  sont reconnues à ce qu'elles contiennent (une suite d'images de pages, des
  liens de chapitres, l'adresse), avec des règles par site mises à jour depuis
  le serveur, sans nouvelle version. Rien ne bascule tout seul, sauf si vous le
  demandez : une petite pastille propose le lecteur.
- **Un lecteur épuré** pour les mangas, les webtoons et les romans :
  - défilement vertical, page simple ou double page, de gauche à droite ou de
    droite à gauche ;
  - un mode texte pour les web novels et les light novels, avec sa propre
    largeur de colonne.
- **Confortable à lire :**
  - zoom et déplacement qui restent là où vous les laissez, double-tap pour
    zoomer ;
  - zones de tap, luminosité et largeur de lecture ;
  - plein écran ;
  - défilement automatique pour les longues pages, à la vitesse choisie ;
  - raccourcis clavier, listés avec `?` ;
  - contrôles qui se cachent pendant la lecture.
- **De chapitre en chapitre sans quitter le lecteur :**
  - précédent et suivant sur place, et une roue des chapitres (`C`) qui montre
    ce que vous avez lu ;
  - un panneau à la fin de chaque chapitre ;
  - en option, le passage automatique au chapitre suivant.
- **Des réglages par série :** un webtoon reste en défilement vertical pendant
  qu'un manga se lit de droite à gauche, sans changer de mode à chaque fois.
- **Les pages se chargent à l'avance**, y compris sur les sites qui affichent
  une page par adresse.
- **Lecture hors ligne :** gardez un chapitre dans PanelFlow pour le lire sans
  le site ni le réseau, pendant 90 jours, dans l'extension et dans l'app.
- **Moins d'interruptions :**
  - publicités bloquées sur les sites de lecture (declarativeNetRequest), avec
    une liste blanche par site ;
  - une protection contre les onglets surgissants et les redirections forcées.

### Regarder

- **Un contrôle de vitesse sur les lecteurs vidéo** (de 0,5× à 4×) pour les
  sites de streaming que vous activez, ou sur tous les sites avec la
  permission « tous les sites ». Il se place sur le coin du lecteur et se
  replie en une pastille. Si vous l'avez masqué sur un site, le popup le fait
  revenir.
- **Ajoutez un anime à votre bibliothèque depuis la page de l'épisode** avec le
  🔖 de la barre. La série, la saison et l'épisode sont lus dans la page :
  - dans ses données structurées quand elle en publie (Crunchyroll et les
    autres plateformes officielles) ;
  - sinon dans son titre, son adresse et son sélecteur d'épisodes.
- **Chaque saison est une entrée à part**, comme sur AniList et MyAnimeList.
- **Les épisodes vraiment regardés comptent :** deux minutes de lecture, et
  non un onglet ouvert, entrent dans votre historique et vos statistiques.
- **Votre bibliothèque suit ce que vous regardez.** Pour une série de votre
  bibliothèque, un épisode regardé pendant deux minutes devient votre
  progression, et part vers AniList ou MyAnimeList. Cela marche que l'épisode
  suivant soit une nouvelle page ou le bouton « Épisode suivant » du site sur
  la même page. La progression ne fait qu'avancer : revoir un épisode plus
  ancien la laisse où elle est.

### Votre bibliothèque

- **Tous les types d'œuvres**, avec des filtres : mangas, webtoons, web novels,
  light novels et animes. Les animes se comptent en épisodes, pas en
  chapitres, partout.
- **Des dossiers** (En cours, En pause, À lire, Terminés, Abandonnés), plus :
  - notes, commentaires et tags ;
  - dates de début et de fin, et relectures.
- **Reprenez où vous vous êtes arrêté**, depuis le popup, le site web ou le
  téléphone.
- **Une entrée par série :**
  - la même série trouvée sur un autre site est reconnue, et on vous demande
    avant de fusionner quoi que ce soit ;
  - une série peut passer sur un autre site en gardant votre progression.
- **Nouveaux chapitres :**
  - vérifiés en arrière-plan, avec une notification ;
  - vérifiés aussi sur le serveur quand tous vos appareils sont éteints, avec
    Web Push pour atteindre un navigateur fermé ;
  - un fil des nouveautés.
- **Historique et statistiques** par type et au total :
  - chapitres ou épisodes, temps passé et moyenne par jour ;
  - séries de jours de lecture, et les séries où vous avez passé le plus de
    temps.
- **Vos sites :** les sites d'où vient votre bibliothèque, à un clic.

### Trackers

- **AniList et MyAnimeList** se connectent par OAuth. Les jetons et les secrets
  des applications restent sur le serveur.
- **La progression est envoyée pendant que vous lisez ou regardez**, et elle ne
  fait qu'avancer. La correspondance est choisie avec soin :
  - le bon catalogue (anime ou manga) ;
  - le bon format (un light novel n'est pas son adaptation en manga) ;
  - la bonne saison.
  Un titre dont la correspondance n'est pas sûre n'est jamais deviné : c'est
  vous qui choisissez, parmi les propositions ou par une recherche.
- **Depuis la fiche d'une série :**
  - ajouter la série à un tracker ;
  - corriger une mauvaise correspondance, ou mettre une série en sourdine ;
  - rattraper toute la bibliothèque d'un coup ;
  - importer la liste de votre tracker.
  Retirer une série de la bibliothèque propose aussi de la retirer du tracker.

### Compte, synchronisation et vie privée

- **Local d'abord.** Tout fonctionne sans compte, sur un appareil. Un compte
  (e-mail et mot de passe) synchronise la bibliothèque, la progression, les
  réglages et le thème entre l'extension, le site web et l'application mobile.
- **Votre compte en autonomie :** mot de passe oublié, changement d'adresse
  e-mail et suppression du compte, depuis chaque client.
- **Vos données :**
  - un export complet (RGPD), depuis les réglages ;
  - aucun SDK d'analyse ni de publicité ;
  - des journaux pseudonymisés ;
  - [politique de confidentialité](web/confidentialite.html) et mentions
    légales intégrées à chaque client.
- **Français et anglais**, thème clair, sombre ou celui du système.
- « Signaler un problème » depuis chaque client.

---

## Les clients

| Client | Ce que c'est |
|---|---|
| **Extension Chrome** (`/extension`) | Manifest V3. Lecteur, détection, barre vidéo, popup (bibliothèque, nouveautés, statistiques, vos sites), options, visite de bienvenue. |
| **Site web** (`/web`) | Servi par le backend. Bibliothèque, nouveautés, sites, statistiques, historique, trackers, réglages. Il permet aussi de changer les réglages de l'extension. |
| **Application mobile** (`/native`) | Expo / React Native pour iPhone et Android. Un navigateur intégré avec le même lecteur, et la bibliothèque, l'historique, les statistiques, les trackers et la vérification des nouveaux chapitres. Elle garde des chapitres hors ligne dans l'app ; la version des stores n'a pas la barre vidéo (voir `docs/ARCHITECTURE.md`, « Store compliance »). |
| **Backend** (`/backend`) | Node.js / Express sur libsql (SQLite en local, Turso en production), déployé sur Vercel. Authentification, synchronisation, règles, proxy OAuth des trackers, surveillance des nouveaux chapitres (cron), Web Push, e-mails. |

**Le pari de l'architecture :** la détection, le lecteur et toutes les règles
de la bibliothèque sont du JavaScript ordinaire, écrit une seule fois
(`shared/`, `extension/content/`). Chrome les exécute comme content scripts ;
le téléphone injecte les mêmes fichiers dans sa WebView grâce à une petite
couche `chrome.* → natif`. Un seul moteur pour toutes les plateformes, et des
règles d'extraction mises à jour côté serveur sans passer par les stores.

## Organisation du dépôt

| Chemin | Contenu |
|---|---|
| `/backend` | API, base de données, cron et push. Tests dans `backend/test` (unitaires et d'intégration, plus des tests de bout en bout dans un vrai Chromium sous `test/e2e`). |
| `/extension` | Extension Chrome MV3. `content/detect.js` (détection), `content/reader.js` (lecteur), `content/video-speed.js` (barre vidéo), `background.js` (worker). |
| `/web` | Site web, en JavaScript sans framework, servi par le backend. |
| `/native` | Application mobile Expo / React Native. |
| `/mobile` | La coquille web du téléphone et les scripts injectés dans son navigateur. |
| `/shared` | Le cœur partagé par tous les clients : `panelflow-core.js`, `series-match.js`, `site-rules.js`, `detection-rules.json`, les traductions. Copié dans chaque client par `npm run sync:shared`. Ne modifiez jamais les copies. |
| `/ios`, `/android` | Coquilles Swift et Kotlin (ébauches, voir leurs README). |
| `/docs` | Architecture, prise en main, débogage, déploiement, notes pour les stores. |

## Démarrage rapide

```bash
npm install
npm test                # tous les tests unitaires et d'intégration (workspace backend)
npm run sync:shared     # après toute modification dans shared/
npm run pack            # dist/panelflow-<version>.zip, l'extension telle que livrée
```

### Backend et site web

```bash
cd backend
npm start               # http://localhost:8787, site web compris
```

Déployer : [`docs/deploy-vercel.md`](docs/deploy-vercel.md).

### Extension Chrome

1. `chrome://extensions` → Mode développeur → **Charger l'extension non
   empaquetée** → choisissez `/extension` (ou décompressez
   `dist/panelflow-<version>.zip` et chargez ce dossier).
2. Ouvrez une page de chapitre sur un site où vous lisez : une pastille « 📖 »
   propose le lecteur.
3. Pour que PanelFlow marche sur le plus de sites possible, activez « tous les
   sites » dans les réglages ; les sites de streaming peuvent aussi être
   activés un par un depuis le popup.

L'extension parle au backend déployé dès l'installation. Pour utiliser votre
propre serveur, mettez `http://localhost:8787` dans *Adresse de l’API* dans
les options, puis reconnectez-vous.

### Tests de bout en bout

```bash
cd backend
PANELFLOW_E2E_CHROMIUM=/chemin/vers/chrome node --test test/e2e/*.e2e.test.js
```

## Feuille de route

Le backlog ordonné et les règles que chaque changement respecte sont dans
[`docs/roadmap.md`](docs/roadmap.md). Prochaines étapes : publication sur les
stores (Chrome Web Store, App Store), notifications push pour l'application
mobile (APNs / FCM) et connexion avec Apple / Google.
