# Textes des stores

Les textes à coller dans les fiches du Chrome Web Store et de l'App Store, en
français puis en anglais. Le descriptif court de l'extension est celui du
manifeste (`extDescription` dans `shared/_locales`) : il se modifie là, pas
seulement ici.

**À respecter dans tout texte de fiche** (voir `docs/ARCHITECTURE.md`,
« Store compliance ») :
- PanelFlow est un **mode lecture pour les sites que l'on visite**, comme le
  mode lecture de Safari. Ce n'est pas un catalogue.
- **Aucun nom de site de lecture ou de streaming**, aucun lien vers l'un
  d'eux, et pas de « scan gratuit ».
- **La version App Store n'a pas** la barre de vitesse vidéo, ni de liste de
  sites fournie. Sa description ne les promet pas.
- **Les chapitres hors ligne** restent dans l'app (aucun export vers Fichiers)
  et s'effacent au bout de 90 jours. Ils se décrivent comme une lecture sans
  réseau, jamais comme un « téléchargement de mangas ».
- AniList et MyAnimeList sont cités seulement pour dire que PanelFlow se
  connecte à eux. Ce n'est pas un partenariat.
- **Sources et import, la même règle sur les trois stores** (Chrome Web
  Store, App Store, Google Play ; décidé le 19/10/2026) : PanelFlow ne
  fournit et ne suggère aucune source. Les sites viennent de l'utilisateur :
  l'adresse qu'il tape, sa recherche, la bibliothèque qu'il importe. Seule
  exception : l'extension fonctionne d'emblée sur les **plateformes de
  publication officielles** (éditeurs et plateformes d'auteurs,
  `shared/prewired-sites.json`), qu'un texte de fiche désigne ainsi, sans
  les nommer. L'import se présente comme le transfert de *ses* données
  (sauvegarde, liste AniList ou MyAnimeList), jamais comme un moyen de
  trouver des lectures.

---

## Chrome Web Store

### Nom
PanelFlow

### Descriptif court (132 caractères maximum, repris du manifeste)
- **FR** : Lisez mangas, webtoons et romans dans un lecteur épuré, suivez vos animes et gardez une bibliothèque synchronisée partout.
- **EN** : Read manga, webtoons and novels in a clean reader, keep track of your anime, and keep one library in sync everywhere.

### Description détaillée (FR)

PanelFlow transforme les sites où vous lisez en un lecteur propre, et garde votre bibliothèque à jour sur tous vos appareils.

📖 UN LECTEUR ÉPURÉ, LÀ OÙ VOUS LISEZ
• PanelFlow reconnaît une page de chapitre et vous propose de l'ouvrir dans son lecteur. Rien ne s'ouvre sans votre accord, sauf si vous le demandez.
• Défilement vertical (webtoon), page simple ou double page, de gauche à droite ou de droite à gauche.
• Un mode texte pour les web novels et les light novels.
• Zoom et déplacement qui restent en place, double-tap pour zoomer, zones de tap, luminosité, largeur de lecture, plein écran.
• Défilement automatique réglable, raccourcis clavier, contrôles qui se cachent pendant la lecture.
• Chapitre précédent et suivant sans quitter le lecteur, liste des chapitres lus, passage automatique au suivant si vous le souhaitez.
• Réglages mémorisés par série : un webtoon reste en défilement vertical, un manga se lit de droite à gauche.
• Pages chargées à l'avance, et lecture hors ligne des chapitres que vous gardez.

🌐 SUR LES SITES QUE VOUS CHOISISSEZ
• PanelFlow fonctionne d'emblée sur les plateformes de publication officielles, celles des éditeurs et des auteurs.
• Sur tout autre site où vous lisez, cliquez sur son icône puis sur « Activez-le ici » : Chrome vous demande l'accès à ce site seulement, et le lecteur démarre sans recharger la page.
• Vous préférez ne pas le faire site par site ? Autorisez-le sur tous les sites depuis les réglages.
• Moins de publicités et plus d'onglets surgissants sur les sites où PanelFlow est activé.

🎬 VOS ANIMES AUSSI
• Une barre de vitesse (de 0,5× à 4×) sur les lecteurs vidéo des sites que vous activez.
• Ajoutez un anime à votre bibliothèque depuis la page de l'épisode : la série, la saison et l'épisode sont reconnus.
• Les épisodes réellement regardés sont comptés dans votre historique et vos statistiques, et votre bibliothèque avance toute seule, même quand l'épisode suivant se lance sur la même page.
• Votre progression part aussi vers AniList ou MyAnimeList.

📚 UNE SEULE BIBLIOTHÈQUE
• Mangas, webtoons, web novels, light novels et animes, avec des filtres par type.
• Dossiers En cours, À lire, En pause, Terminés et Abandonnés, avec notes, commentaires, tags, dates et relectures.
• « Reprendre » vous ramène là où vous vous êtes arrêté.
• Alertes de nouveaux chapitres, vérifiés aussi par le serveur quand votre ordinateur est éteint.
• Historique et statistiques par type et au total : chapitres ou épisodes, temps passé, séries de jours de lecture.

🔗 ANILIST ET MYANIMELIST
• Connectez votre compte : votre progression y est envoyée pendant que vous lisez ou regardez.
• Le bon catalogue (anime ou manga), le bon format et la bonne saison. En cas de doute, c'est vous qui choisissez.
• Import de votre liste, correction d'une correspondance, et proposition de retrait du tracker quand vous retirez une série.

☁️ SYNCHRONISÉ, ET RESPECTUEUX
• Sans compte, tout fonctionne sur cet appareil. Avec un compte, votre bibliothèque est la même sur Chrome, sur le site web et sur l'application mobile.
• Aucun traceur publicitaire ni outil d'analyse. Export complet de vos données et suppression du compte depuis les réglages.
• En français et en anglais, thème clair ou sombre.

PanelFlow n'héberge et ne propose aucun contenu : il affiche autrement les pages que vous visitez vous-même.

### Description détaillée (EN)

PanelFlow turns the sites you read on into a clean reader, and keeps your library up to date on every device.

📖 A CLEAN READER, WHERE YOU READ
• PanelFlow recognises a chapter page and offers to open it in its reader. Nothing opens unless you say so, or ask it to.
• Long strip (webtoons), single page or double page, left to right or right to left.
• A text mode for web novels and light novels.
• Zoom and pan that stay where you leave them, double tap to zoom, tap zones, brightness, reading width, full screen.
• Adjustable auto-scroll, keyboard shortcuts, and controls that hide while you read.
• Previous and next chapter without leaving the reader, a list of what you read, and an optional "go on to the next chapter".
• Settings kept per series: a webtoon stays in long strip, a manga reads right to left.
• Pages loaded ahead, and offline reading for the chapters you keep.

🌐 ON THE SITES YOU CHOOSE
• PanelFlow works out of the box on official publishing platforms, the ones run by publishers and by authors.
• On any other site you read on, click its icon, then "Turn it on here": Chrome asks for access to that site only, and the reader starts without reloading the page.
• Rather not do it site by site? Allow it on all sites from the settings.
• Fewer ads and no more pop-up tabs on the sites where PanelFlow is on.

🎬 YOUR ANIME TOO
• A speed control (0.5× to 4×) on video players, on the sites you turn on.
• Add an anime to your library from its episode page: the series, the season and the episode are recognised.
• Episodes you actually watched count in your history and statistics, and your library moves on by itself, even when the next episode starts on the same page.
• Your progress is sent on to AniList or MyAnimeList too.

📚 ONE LIBRARY
• Manga, webtoons, web novels, light novels and anime, with filters by type.
• Reading, Plan to read, Paused, Completed and Dropped, with scores, notes, tags, dates and rereads.
• "Continue" takes you back to where you stopped.
• New-chapter alerts, also checked by the server while your computer is off.
• History and statistics by type and overall: chapters or episodes, time spent, reading streaks.

🔗 ANILIST AND MYANIMELIST
• Connect your account and your progress is sent as you read or watch.
• The right catalogue (anime or manga), the right format and the right season. When in doubt, you choose.
• Import your list, fix a match, and the offer to remove a series from the tracker when you remove it here.

☁️ IN SYNC, AND RESPECTFUL
• Without an account, everything works on this device. With one, your library is the same in Chrome, on the website and in the phone app.
• No advertising trackers or analytics. Full export of your data, and account deletion from the settings.
• English and French, light or dark theme.

PanelFlow hosts and suggests no content: it shows the pages you visit yourself, differently.

### Justification des permissions (formulaire du Chrome Web Store)

Le formulaire est en anglais : la colonne EN se colle telle quelle, la
colonne FR sert à la relecture.

| Permission | EN (à coller) | FR |
|---|---|---|
| `storage` | Keeps the library, reading progress and settings on the device; the extension works without an account. | Garde la bibliothèque, la progression et les réglages sur l'appareil ; l'extension marche sans compte. |
| `unlimitedStorage` | Chapters the user keeps for offline reading are stored on the device and exceed the default quota. They expire after 90 days. | Les chapitres gardés pour la lecture hors ligne dépassent le quota par défaut ; ils expirent au bout de 90 jours. |
| `alarms` | Checks the series in the user's library for new chapters at an interval the user sets. | Vérifie les nouveaux chapitres des séries de la bibliothèque, à l'intervalle choisi. |
| `notifications` | Tells the user a new chapter of a series they follow is out; clicking it opens that chapter. | Prévient qu'un nouveau chapitre d'une série suivie est sorti ; un clic l'ouvre. |
| `declarativeNetRequest` | Blocks ads and pop-up redirections, only on the sites where PanelFlow is on (the official publishing platforms it ships with and the sites the user turned on), with a per-site whitelist. It injects no ads. | Bloque publicités et redirections, uniquement sur les sites où PanelFlow est activé (les plateformes de publication officielles du paquet et les sites que l'utilisateur a activés), avec une liste blanche par site. N'ajoute aucune publicité. |
| `scripting` | Starts the reader on a site the user has just turned on from the popup, in the open tab, without a reload; and lists the video players a page frames when the user turns on a streaming site. | Démarre le lecteur sur un site que l'utilisateur vient d'activer, dans l'onglet ouvert, sans rechargement ; repère les lecteurs vidéo d'une page quand il active un site de streaming. |
| `activeTab` | Opens the reader in the current tab when the user clicks the icon or presses the shortcut. | Ouvre le lecteur dans l'onglet courant au clic sur l'icône ou au raccourci. |
| `favicon` | Shows each site's icon in the user's own list of sites. | Affiche l'icône de chaque site dans « Vos sites ». |
| Host permissions | Official publishing platforms (publishers and author platforms), where the extension recognises chapter pages and offers its reader from the start. No other site is requested at install. | Les plateformes de publication officielles (éditeurs et plateformes d'auteurs), où l'extension reconnaît les pages de chapitre dès l'installation. Aucun autre site n'est demandé à l'installation. |
| `<all_urls>` (optional) | Requested at runtime only: for the one site the user turns on from the popup, or for every site if the user chooses "all sites" in the settings. | Demandé seulement à l'usage : pour le site que l'utilisateur active depuis la popup, ou pour tous si l'utilisateur choisit « tous les sites » dans les réglages. |
| Remote code | No. All logic ships in the package. The reading rules and the ad-block list fetched from PanelFlow's server are JSON data read by packaged code. | Non. Toute la logique est dans le paquet ; règles et liste anti-pub reçues du serveur sont des données JSON. |

**Usage unique (single purpose)** :
- FR : afficher dans un lecteur épuré les chapitres et épisodes que
  l'utilisateur consulte sur les sites qu'il a choisis, et tenir sa
  bibliothèque de lecture à jour.
- EN : Show the chapters and episodes the user opens, on the sites they
  chose, in a clean reader, and keep their reading library up to date.

### Pratiques de confidentialité (onglet du tableau de bord)

Toutes ces données ne sont traitées **que si l'utilisateur crée un compte** ;
aucune n'est vendue, ni utilisée pour la publicité.

| Catégorie du formulaire | Ce que c'est dans PanelFlow |
|---|---|
| Personally identifiable information | l'adresse e-mail du compte |
| Authentication information | le mot de passe, envoyé au serveur de PanelFlow à la connexion, et le jeton de session gardé sur l'appareil |
| Web history | les adresses des chapitres lus, pour la bibliothèque, l'historique et la reprise |
| User activity | la progression de lecture (position dans le chapitre), pour reprendre au bon endroit |
| Website content | le titre et l'image de couverture d'une série ajoutée à la bibliothèque |

Pas collecté : santé, finances, communications personnelles, localisation.
Les chapitres gardés hors ligne restent sur l'appareil.

Les trois certifications à cocher : pas de vente ni de transfert de données
hors des usages autorisés ; pas d'usage sans rapport avec l'usage unique ;
pas d'usage pour décider d'un crédit.

URL de la politique de confidentialité :
`https://panelflow-backend.vercel.app/privacy.html`

**Limited Use** : la déclaration est dans la politique de confidentialité,
`confidentialite.html#usage-limite` et `privacy.html#limited-use`. Elle ne
nomme aucun site.

---

## App Store

La version App Store est un navigateur avec un mode lecture. Il n'y a pas de
barre vidéo et pas de liste de sites fournie : l'onglet « Sites » montre les
sites de *votre* bibliothèque. Les chapitres gardés pour lire sans réseau
restent dans l'app, comme dans les autres lecteurs de l'App Store qui le font,
et s'effacent d'eux-mêmes au bout de 90 jours.

### Nom (30 caractères maximum)
PanelFlow

### Sous-titre (30 caractères maximum)
- **FR** : Mode lecture manga et webtoon
- **EN** : Manga & webtoon reading mode

### Texte promotionnel (170 caractères maximum)
- **FR** : Lisez sur les sites que vous visitez dans un lecteur épuré, et retrouvez la même bibliothèque, la même progression et vos trackers sur tous vos appareils.
- **EN** : Read the sites you visit in a clean reader, with the same library, the same progress and your trackers on every device.

### Description (FR)

PanelFlow ouvre les chapitres des sites où vous lisez déjà dans un mode lecture épuré, sans publicité. Quand une page est un chapitre, il l'affiche dans son lecteur et retient où vous en êtes.

LE LECTEUR
• Défilement vertical pour les webtoons, page simple ou double page, sens de lecture au choix.
• Un mode texte pour les romans.
• Zoom au double-tap, zones de tap, luminosité, largeur de lecture.
• Défilement automatique, et contrôles qui se cachent pendant la lecture.
• Chapitre suivant sans quitter le lecteur, et réglages mémorisés pour chaque série.
• Gardez un chapitre dans l'app pour le lire sans réseau, pendant 90 jours.

VOTRE BIBLIOTHÈQUE
• Mangas, webtoons, romans et animes, classés en En cours, À lire, En pause, Terminés et Abandonnés.
• Notes, commentaires, tags et dates de lecture.
• « Reprendre » vous ramène au chapitre où vous vous êtes arrêté.
• Les nouveaux chapitres de vos séries sont vérifiés pour vous.
• Historique et statistiques : chapitres lus, temps passé, séries de jours de lecture.

ANILIST ET MYANIMELIST
• Connectez votre compte : votre progression y est envoyée pendant votre lecture.
• Importez votre liste et corrigez une correspondance en deux gestes.

SUR TOUS VOS APPAREILS
• Sans compte, tout reste sur votre iPhone.
• Avec un compte, la même bibliothèque sur l'iPhone, sur le site web et dans l'extension Chrome.
• Aucun traceur publicitaire. Export de vos données et suppression du compte depuis les réglages.
• Français et anglais, thème clair ou sombre.

PanelFlow n'héberge et ne propose aucun contenu : il affiche autrement les pages que vous ouvrez vous-même.

### Description (EN)

PanelFlow opens the chapters of the sites you already read in a clean, ad-free reading mode. When a page is a chapter, it shows it in its reader and remembers where you are.

THE READER
• Long strip for webtoons, single or double page, in either reading direction.
• A text mode for novels.
• Double tap to zoom, tap zones, brightness and reading width.
• Auto-scroll, and controls that hide while you read.
• The next chapter without leaving the reader, and settings remembered for each series.
• Keep a chapter in the app to read it with no network, for 90 days.

YOUR LIBRARY
• Manga, webtoons, novels and anime, filed as Reading, Plan to read, Paused, Completed and Dropped.
• Scores, notes, tags and reading dates.
• "Continue" takes you back to the chapter where you stopped.
• New chapters of your series are checked for you.
• History and statistics: chapters read, time spent, reading streaks.

ANILIST AND MYANIMELIST
• Connect your account and your progress is sent as you read.
• Import your list and fix a match in two taps.

ON ALL YOUR DEVICES
• Without an account, everything stays on your iPhone.
• With one, the same library on the iPhone, on the website and in the Chrome extension.
• No advertising trackers. Export your data and delete your account from the settings.
• English and French, light or dark theme.

PanelFlow hosts and suggests no content: it shows the pages you open yourself, differently.

### Mots-clés (100 caractères maximum, séparés par des virgules)
- **FR** : `manga,webtoon,manhwa,manhua,lecteur,bibliothèque,anilist,myanimelist,roman,light novel,suivi`
- **EN** : `manga,webtoon,manhwa,manhua,reader,library,anilist,myanimelist,novel,light novel,tracker`

### Notes pour la revue Apple (App Review Information)

> PanelFlow is a general-purpose browser (WKWebView) with a reading mode, in
> the same way as Safari Reader. It hosts, indexes, lists and suggests no
> content: the user types an address or a search, and PanelFlow only changes
> how the page they opened is displayed. The "Sites" tab lists the sites the
> user's own library comes from: PanelFlow provides no source, the sites are
> the ones the user opens or imports from their own AniList or MyAnimeList
> list. The demo account's library holds only series from official
> publishing platforms. The only content kept on the device is a
> chapter the user explicitly keeps for reading with no network ("Offline"
> tab): it stays in the app's own storage, is never exported to Files, and is
> deleted automatically after 90 days. Ad blocking uses a published filter
> list. Accounts are optional; a demo account is provided in the sign-in
> information of this submission.

**Le compte de démo** ne s'écrit pas ici : c'est un vrai compte sur le serveur
de production, et ce fichier est public. Le créer depuis l'app ou le site
(une adresse dédiée, par exemple un alias de la boîte de contact), y mettre
deux ou trois séries prises **uniquement** sur des plateformes de publication
officielles (celles de `shared/prewired-sites.json`) : c'est la bibliothèque
que verra l'examinateur, et l'onglet Sites montrera ces plateformes-là. Puis
saisir l'adresse et le mot de passe dans App Store Connect, rubrique
« Informations de connexion » de la version. Le garder après la publication :
la revue s'en sert à chaque mise à jour. Le même compte sert à Google Play
(Console › Contenu de l'application › Accès aux applications).

### Adresses à donner à App Store Connect

| Champ | Adresse |
| --- | --- |
| URL d'assistance (obligatoire) | `https://panelflow-backend.vercel.app/aide.html` (anglais : `support.html`) |
| Politique de confidentialité (obligatoire) | `https://panelflow-backend.vercel.app/confidentialite.html` (anglais : `privacy.html`) |
| URL marketing (facultative) | `https://panelflow-backend.vercel.app/` |

La page d'aide donne l'adresse de contact, la marche à suivre pour exporter
ou supprimer ses données, et ce qui protège le compte : c'est ce que la revue
regarde derrière « URL d'assistance ». Si le site passe un jour sur un nom de
domaine à lui, ces trois adresses, `og:url` et `og:image` dans
`web/index.html` et `site` dans `web/legal.js` changent ensemble
(`launch-site.test.js` vérifie que les deux derniers restent d'accord).

### Classification par âge (questionnaire d'App Store Connect)

**Résultat attendu : 16+.** C'est la réponse « accès web non restreint »
qui la fixe, et elle est exacte : l'app est un navigateur qui ouvre la page
que l'utilisateur tape ou cherche (barème d'Apple :
https://developer.apple.com/help/app-store-connect/reference/age-ratings).
Le compte demande déjà d'avoir 15 ans ou plus, ce qui ne contredit pas ce
classement.

| Question | Réponse |
| --- | --- |
| Accès web non restreint (navigateur intégré) | **Oui** |
| Contenu généré par les utilisateurs et partagé | Non (rien n'est publié ni partagé entre comptes) |
| Messagerie, chat | Non |
| Réseau social (fil, mentions « J'aime », commentaires) | Non |
| Publicité | Non |
| Achats intégrés | Non |
| Contrôles parentaux, vérification d'âge | Non |
| Violence, thèmes adultes, nudité, jeux d'argent… *dans l'app elle-même* | Aucun (l'app n'affiche aucun contenu à elle ; ce qu'ouvre le navigateur relève de la première ligne) |

### Confidentialité de l'app (« App Privacy »)

Les réponses suivent le manifeste de confidentialité de l'app
(`native/app.json`, `NSPrivacyCollectedDataTypes`) : les deux disent la même
chose, et la revue compare. **Pistage : non**, pour tout. Toutes les données
ci-dessous servent **au fonctionnement de l'app** uniquement. Sauf la
dernière, elles ne sont collectées **que si l'utilisateur crée un compte**,
et sont alors **liées à son identité** (le compte).

| Catégorie Apple | Ce que c'est dans PanelFlow |
| --- | --- |
| Coordonnées → Adresse e-mail | L'adresse du compte |
| Identifiants → Identifiant utilisateur | L'identifiant du compte |
| Contenu de l'utilisateur → Autre contenu | Bibliothèque, notes, tags, dossiers |
| Historique de navigation | Les adresses des chapitres lus et la progression |
| Utilisation → Interactions avec le produit | L'historique de lecture et les statistiques |
| Identifiants → Identifiant de l'appareil | **Non lié** : l'identifiant d'installation aléatoire qu'envoie la vérification des mises à jour (Expo), rattaché à aucun compte |

Rien n'est collecté à des fins publicitaires, d'analyse, ni partagé avec des
tiers ; il n'y a pas de rapport de plantage envoyé.

### Le reste du formulaire

- **Chiffrement (export compliance)** : l'app n'utilise que le HTTPS du
  système. `ITSAppUsesNonExemptEncryption` vaut `false` dans `native/app.json`,
  donc aucune question n'est posée à l'envoi.
- **Se connecter avec Apple** : pas exigé. Le compte PanelFlow se crée avec
  une adresse et un mot de passe, sans connexion Google, Facebook ou autre ;
  AniList et MyAnimeList ne servent pas à se connecter à PanelFlow.
- **Suppression du compte** : dans l'app (Réglages, Compte et
  synchronisation, Supprimer mon compte), comme l'exige la règle 5.1.1(v).
- **Prix** : gratuit, sans achat intégré. Les conditions d'utilisation le
  disent (`web/conditions.html`, section 2) ; une offre payante les
  changerait d'abord (voir `docs/lancement.md`).

---

## Captures d'écran des fiches

Elles ne sont pas encore faites. Avant de les produire, la direction est fixée
ici, pour que PanelFlow ne ressemble à aucune autre application de lecture sur
une page de store (revue de ressemblance du 12/10/2026) :

- **Le thème clair papier** (`#F7F4EC`) pour la plupart des écrans, le thème
  sombre pour le lecteur seulement, qui est sombre par défaut.
- **Le fond** : papier ou encre unie, avec la grille de cases du logo comme
  motif de mise en page. Pas d'aplat de couleur vive plein cadre.
- **Les légendes** : en minuscules de phrase, en IBM Plex Sans ou Condensed,
  encre sur papier. Pas de capitales blanches grasses, pas de titre bicolore.
- **Ce qu'on montre** : ce qui est propre à PanelFlow — la molette des
  chapitres, le panneau de fin de chapitre, la synchronisation avec AniList et
  MyAnimeList, l'onglet « Mes sites », la bibliothèque en français, les
  statistiques, les animes.
- **Aucun nom de site** de lecture ou de streaming, ni dans l'image ni dans
  une barre d'adresse visible : les captures se font sur le banc de test
  local (`lecture.example.test`).
