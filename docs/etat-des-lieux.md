# État des lieux et test par des amis

Dernière mise à jour : **18 septembre 2026, soir**. 1 420 tests et 4 E2E, tous verts, exécutés par la CI à chaque push. Build iOS 15 sur TestFlight.

Ce document répond à trois questions : où en est le projet, ce qu'il reste à faire, et comment faire tester l'app mobile à des amis avant de la sortir. Il complète [`roadmap.md`](roadmap.md) (le plan par tâches, écrit pour être exécuté) sans le remplacer.

---

## 1. Ce qui est fait depuis la roadmap du 5 septembre

| Domaine | État |
|---|---|
| Client iPhone (React Native) | Compilé et soumis à TestFlight à chaque correctif, 14 builds. Toutes les pages du site existent sur le téléphone (bibliothèque, historique avec ligne « nouveaux chapitres », sites, recherche, réglages en 8 pages). |
| Lecteur sur mobile | Forcé activé ; barre d'outils au tap qui se cache ; changement de chapitre sans quitter le lecteur ; le carrousel s'ouvre sur le chapitre en cours. |
| Publicités et redirections | `navigation-policy.js` : un script ne peut plus faire quitter le site à la fenêtre ; `popup-guard.js` attrape le lien dont l'adresse change sous le doigt et désamorce AdCash. Testé sur voiranime. |
| Couvertures | Recherche sur la page de la série, puis dans le catalogue AniList sans compte, avec le seuil de correspondance `STRONG`. Une image qui ne charge pas est remplacée. |
| Trackers, statistiques, historique | Présents sur les trois surfaces. |
| Pages légales | Mentions, confidentialité, conditions, écrites depuis le schéma de la base et tenues au code par test. Adresse de contact renseignée. |
| Suppression de compte | Route, écran web, écran téléphone, page options de l'extension. Exigée par le RGPD et par l'App Store. |
| Accessibilité et contraste | Palette mesurée et corrigée (4.5:1 partout), anneau de focus, noms accessibles, `lang`, dialogues nommés ; tout est tenu par test. |
| Icônes | Dessinées depuis la marque du projet par `scripts/build-icons.mjs` ; plus aucune image d'origine inconnue. |
| Parité des réglages | Chaque préférence de compte est proposée sur les trois surfaces (test `settings-parity`), et la règle « où vit un réglage » est écrite une seule fois (`project`/`split` dans `shared/prefs.js`). |
| Chapitres hors ligne sur téléphone | `native/src/offline.js` range les pages dans `expo-file-system` (plafond 512 Mo, même expiration à 90 jours que le PC) ; Réglages › Chapitres enregistrés les liste par série et les lit sans réseau. |
| Changement d'adresse e-mail | `POST /api/auth/email` (mot de passe exigé) puis lien de confirmation envoyé à la nouvelle adresse ; formulaire sur les trois surfaces ; la page de confidentialité le décrit. |
| Signaler un problème | Sur les trois surfaces, depuis un seul fichier (`shared/report.js`) : Réglages › Signaler un problème sur le téléphone, la page d'options de l'extension (version, navigateur, dernière page détectée, notes et appels échoués du worker), l'onglet Réglages du site (page, navigateur, heure). Le mail s'ouvre chez le lecteur ; rien n'est envoyé tout seul. |
| Recherche | Un analyseur partagé (`shared/search.js`) ; le téléphone interroge DuckDuckGo lui-même (une adresse résidentielle n'est pas refusée), le serveur passe par Brave quand `PANELFLOW_BRAVE_KEY` est présent, DuckDuckGo sinon. L'onglet Recherche a ses résultats. |
| Registre des sites | `scripts/check-sites.mjs` écrit `docs/sites-registry.{json,md}` : quel domaine répond, et sur lesquels le lecteur ouvrirait le premier chapitre trouvé. Première passe faite. Le 21 septembre, deux cents candidats pris dans les index communautaires (`docs/sites-candidates.{json,md}`, cinquante par famille) : 14 sites d'anime avec un lecteur, 12 de manga et 5 de webtoons prêts, 8 de light novels lus ; 25 domaines et 18 hébergeurs entrés dans les règles ; les limites (murs Cloudflare, applications JavaScript, 403 depuis ce PC) sont dans `docs/campagne-tests.md` §4.3. Le mode page à page (scan-vf, mangago) et la campagne longue en navigateur réel (`docs/campagne-tests.md` §4.4 et §4.5) datent du 21 septembre. |
| Intégration continue | `.github/workflows/ci.yml` : tests sur Node 20 et 22, dérive des fichiers générés, zip et bundle, et l'extension chargée dans un vrai Chromium sur un site de scan synthétique (`backend/test/e2e/`). |
| Android, sur le papier | Liste blanche par domaine corrigée (`pageHost == it || endsWith(".$it")`) et le vérificateur de chapitres rend `failure()` quand le délai le coupe, pour que WorkManager réessaie. Rien n'a encore tourné sur un appareil. |

---

## 2. Ce qu'il reste à faire

Par ordre d'importance pour une sortie publique. Les identifiants renvoient à `roadmap.md` quand la tâche y existe.

### 2.1 Bloquant avant une sortie App Store : ce qui demande du vrai

Ces quatre points ne se règlent pas depuis un PC. Le protocole de chacun est écrit dans [`campagne-tests.md`](campagne-tests.md), avec le registre où noter les résultats.

1. **Android n'a jamais tourné sur un appareil.** Le client compile (`npm run build:android`), deux correctifs Kotlin sont faits sur lecture, mais personne n'a lancé l'app. Deux points connus : `navigation-policy.js` ne distingue pas un tap d'un script sur Android, donc un lien vers un autre site ne fera rien ; et `onShouldStartLoadWithRequest` n'y rapporte pas `isTopFrame`. Douze parcours à faire sur deux téléphones (campagne §2). (C1, C2)
2. **Le réveil en arrière-plan n'est pas mesuré.** iOS décide seul ; sept jours sur trois iPhones disent si les vérifications arrivent (campagne §3). Le serveur vérifie chaque nuit de toute façon ; le vrai push (APNs) est C4 et n'est pas commencé.
3. **Les trackers n'ont jamais été exécutés avec de vrais identifiants OAuth.** Deux comptes de test à créer, jamais le vrai (campagne §7).
4. **Un domaine** (A5 : préparé, l'achat reste à faire). `panelflow-backend.vercel.app` figure dans les pages légales et dans l'app.

### 2.2 Important pour la qualité perçue

5. **La preuve de lecture sur de vrais sites.** Les 52 sites que le registre ne savait pas échantillonner ont été ouverts un par un dans un navigateur le 18 septembre (`docs/sites-samples.json`) : 31 étaient morts (domaines parqués ou expirés, services fermés) ou réservés à une application avec compte, et sont sortis des règles ; 6 avaient changé de domaine et ont été renommés ; 13 ont un chapitre noté à la main, dont 4 sites de texte. Ce qui reste : ouvrir un chapitre sur PC *et* sur téléphone pour les sites `ready`/`likely` et les quatre moteurs, une ligne par site dans le registre des exécutions (campagne §4.2), et refaire la passe depuis un autre réseau pour les 5 `blocked` d'ici. Chaque site qu'un testeur utilise et qui ne marche pas mérite une règle dans `shared/detection-rules.json`.
6. **La campagne publicitaire** sur les dix sites les plus utilisés, DevTools ouvert, quatre configurations (campagne §5). L'E2E prouve la garde sur une page synthétique ; le terrain reste à faire.
7. **MangaUpdates** comme troisième tracker (D2).
8. **Les mises à jour JavaScript sans passer par l'App Store** (`expo-updates`), pour corriger un bug de testeur en dix minutes au lieu d'un build.

### 2.3 Dette technique, avec un plan pour chacune

Le code est écrit pour être lu, et chaque règle est tenue par un test. Ce qui reste gros est gros parce qu'il fait beaucoup, pas parce qu'il est mal rangé. Voici les quatre fonctions de plus de 190 lignes, et comment chacune se découpe sans risque.

| Fonction | Taille | Pourquoi c'est gros | Découpage proposé |
|---|---|---|---|
| `createCore` (`shared/panelflow-core.js`) | 1 467 lignes | C'est le cœur des quatre surfaces : bibliothèque, progression, historique, doublons, vérification des chapitres, préférences, compte. Déjà sectionné par des commentaires `// ---`. | Un fichier par section (`shared/core/library.js`, `progress.js`, `history.js`, `news.js`, `account.js`), chacun une fonction `(ctx) => ({ …méthodes })` recevant `store`, `apiFetch`, `now`, et `createCore` qui les assemble. Chaque section devient testable seule avec un `ctx` factice. À faire en cinq commits, une section par commit, la suite de tests ne changeant pas. |
| `render` (`extension/content/library-modal.js`) | 455 lignes | Dessine toute la fiche d'une série : titre, dossier, score, tags, note, trackers, doublons. | Une fonction par bloc de la fiche (`renderHeader`, `renderShelf`, `renderScore`, `renderTags`, `renderNote`), `render` ne faisant que les appeler dans l'ordre. `trackerBlock` (261 lignes) est déjà séparé et montre le modèle. |
| `renderLibrary` (`web/app.js`) | 208 lignes | Construit chaque carte de l'étagère web. | Sortir `card(entry)` en fonction pure qui rend un élément, comme `tile()` le fait déjà sur le téléphone. |
| `build` (`extension/content/reader.js`) | 199 lignes | Construit le DOM du lecteur d'un bloc. | Un fragment par zone (`buildToolbar`, `buildPages`, `buildEndPanel`). |

Une règle à garder pendant ce découpage : **les tests existants lèvent des fonctions par des marqueurs textuels** (`chapter-wheel-ui.test.js`, `popup-guard.test.js`…). Déplacer une fonction casse le marqueur, ce qui est voulu : le test dit alors où il attend la fonction, et on le met à jour. Ne jamais contourner en dupliquant.

Autres dettes plus petites :

- `web/app.js` (2 962 lignes) est un seul fichier sans modules. Un découpage par onglet (`web/views/library.js`, `stats.js`…) chargés par `<script>` dans l'ordre suffit ; pas besoin de bundler.
- Les fins de ligne : `core.autocrlf=true` sur Windows convertit les fichiers touchés par certains outils en CRLF, et plusieurs tests comparent des `\n`. Un `.gitattributes` avec `* text=auto eol=lf` réglerait la question une fois pour toutes.
- Le sondage du navigateur intégré (`POLL` toutes les 2 s dans `BrowserScreen.js`) est simple et suffisant, mais un `postMessage` depuis la page quand l'état change coûterait moins de batterie.

---

## 3. Faire tester l'app à des amis (TestFlight)

TestFlight distingue deux groupes. Les **testeurs internes** sont limités aux membres de ton compte développeur (toi). Les **testeurs externes** sont n'importe quelle adresse e-mail, jusqu'à 10 000 ; c'est ce qu'il te faut. Le premier build proposé à des externes passe une revue Apple (quelques heures à deux jours) ; les suivants du même groupe passent sans revue.

### 3.1 Préparer App Store Connect (une fois, quinze minutes)

Sur [appstoreconnect.apple.com](https://appstoreconnect.apple.com), app **PanelFlow** → onglet **TestFlight**.

1. **Informations sur le test** (colonne de gauche) : renseigner
   - *Description du test bêta* : deux phrases sur ce que fait l'app et ce qu'on attend des testeurs (le §3.3 ci-dessous convient).
   - *E-mail de commentaires* : `1animoment@gmail.com`.
   - *URL de la politique de confidentialité* : `https://panelflow-backend.vercel.app/confidentialite.html`.
   - *Informations de contact de la revue* : ton nom, ton adresse, un numéro. Apple ne les publie pas.
2. **Créer un groupe externe** : *Testeurs externes* → **+** → nom « Amis ». Cocher *Activer le lien public* si tu préfères envoyer un lien plutôt que saisir des adresses (un lien peut être partagé ; on peut le révoquer).
3. **Ajouter un build au groupe** : dans le groupe, *Builds* → **+** → choisir le build 14 (ou le dernier). Répondre à la question sur le chiffrement (déjà répondue par `ITSAppUsesNonExemptEncryption: false` dans `app.json`, Apple ne la reposera pas). Le build part en revue bêta.
4. **Ajouter les testeurs** : par adresse e-mail (ils reçoivent une invitation) ou par le lien public.

Côté testeur : installer **TestFlight** depuis l'App Store, ouvrir l'invitation ou le lien, appuyer sur *Installer*. Les mises à jour arrivent ensuite dans TestFlight ; l'app prévient quand un nouveau build est là. Un build TestFlight expire au bout de 90 jours.

### 3.2 Envoyer les corrections pendant le test

Deux chemins depuis le 21 septembre, selon ce que le correctif touche.

**Du JavaScript seulement (presque tous les correctifs de ce dépôt) : `npm run update:ios`** (à la racine comme dans `native/`). `expo-updates` est installé ; `app.json` déclare le canal (`updates.url`) et la version d'exécution (`runtimeVersion.policy: appVersion`, donc la version d'`app.json`, 0.1.0 aujourd'hui) ; `eas.json` donne un canal par profil (`production`, `preview`, `development`). La commande exporte le bundle et le publie sur le canal `production` en une minute ; toute app installée depuis un build de la même version le télécharge en arrière-plan au lancement (ou au retour au premier plan) et l'exécute au lancement suivant. Sur le téléphone, Réglages > Signaler un problème > « Chercher une mise à jour » demande tout de suite et redémarre s'il y en a une ; la ligne de version du rapport dit le build *et* le code (`build 18, js 01a0c3c3`), ce qui règle les faux « ça ne marche toujours pas ». Première publication faite le 21 septembre (groupe `41ed0128`), que le build 18 prendra dès qu'il existera : les builds 15 à 17 ne contiennent pas `expo-updates` et ne voient rien.

**Du natif (un module Expo ajouté, une permission, `app.json` hors `updates`) : un vrai build.** Monter la `version` d'`app.json` (0.1.1), puis `npm run build:ios` et `npm run submit:ios` : la nouvelle version d'exécution ne prend que les mises à jour publiées pour elle, ce qui est le garde-fou voulu (un JS qui appelle un module absent du build planterait). Vérifier de quel commit vient un build avec `npx eas-cli build:view <id> --json` (champ `gitCommitHash`). Quota EAS gratuit : quinze builds iOS par mois, remis à zéro le premier du mois.

### 3.3 Ce qu'il faut demander aux testeurs

Un message court, dans cet ordre. Le premier point suffit à rendre le retour utile.

1. **Ouvre l'app, crée un compte, ajoute deux ou trois séries** depuis l'onglet Sites, sur les sites que tu lis vraiment. Est-ce que le lecteur s'ouvre tout seul sur un chapitre ?
2. **Lis un chapitre, change de chapitre depuis le lecteur, ferme l'app, rouvre-la.** Es-tu revenu au bon endroit ?
3. **Dis-moi chaque site où le lecteur ne s'ouvre pas ou où une pub t'a fait sortir.** Le nom du site suffit ; l'adresse de la page, c'est mieux.
4. **Si un encadré rouge apparaît en bas d'une page, envoie-moi une capture.** C'est l'app qui signale un script en échec (`report-failure.js`) ; c'est le retour le plus précieux qu'on puisse recevoir.
5. Tout ce qui est bizarre, lent, ou que tu n'as pas compris, même sans savoir si c'est un bug.

Ce qu'il ne faut pas leur demander : de tester Android (pas encore possible), les chapitres hors ligne (pas encore faits), ni la recherche depuis l'onglet Recherche (elle mène à DuckDuckGo, c'est voulu pour l'instant).

### 3.4 Recevoir les bugs et les trier

- Les commentaires TestFlight (bouton *Envoyer un commentaire bêta* dans TestFlight, ou capture d'écran → *Partager* → TestFlight) arrivent dans App Store Connect → TestFlight → *Commentaires*, avec la capture, le modèle de téléphone et la version d'iOS.
- Les plantages (rares en React Native, mais possibles côté natif) arrivent au même endroit, onglet *Plantages*, avec la pile.
- Pour un site qui ne marche pas : reproduire d'abord depuis le PC avec `node backend/test/anime-sites.test.js` ou en récupérant la page (`curl -A "Mozilla/5.0 (iPhone…)"`) et en la passant à `shared/compat.js`, comme ça a été fait pour voiranime. Une règle dans `detection-rules.json` plus un test vaut mieux qu'un correctif dans `detect.js`.

Ce que l'app n'a pas, par choix : aucun rapport de plantage envoyé automatiquement (Sentry ou équivalent), parce que la page de confidentialité promet qu'aucune donnée ne part vers un tiers. Si le test montre que c'est un manque, l'ajouter en **opt-in** (un interrupteur dans Réglages, éteint par défaut), et mettre la page à jour le même jour ; le test `legal-pages` échouera sinon, c'est fait pour.

---

## 4. Ce que tu peux demander à Claude, tel quel

- « Découpe `createCore` section par section comme dans §2.3 » (cinq commits).
- « Ajoute `expo-updates` avec un canal production » (§3.2).
- « Fais le store hors ligne sur `expo-file-system` » (§2.2, point 5).
- « Ajoute un écran Signaler un problème » (§2.2, point 7).
- « Vérifie Android sur un appareil » : il faudra un téléphone ou un émulateur ; Claude peut préparer l'APK (`eas build --platform android --profile preview`) et la liste de ce qu'il faut regarder.
