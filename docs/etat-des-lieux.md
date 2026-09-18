# État des lieux et test par des amis

Dernière mise à jour : **18 septembre 2026**. 1 392 tests, tous verts. Build iOS 14 sur TestFlight.

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

---

## 2. Ce qu'il reste à faire

Par ordre d'importance pour une sortie publique. Les identifiants renvoient à `roadmap.md` quand la tâche y existe.

### 2.1 Bloquant avant une sortie App Store

1. **Android n'a jamais tourné sur un appareil.** Le client React Native compile pour Android (`eas.json` a un profil `apk`) mais personne ne l'a lancé. Deux points connus à vérifier en premier : `navigation-policy.js` ne distingue pas un tap d'un script sur Android (tout est `other`), donc un lien vers un autre site ne fera rien ; et `onShouldStartLoadWithRequest` n'y voit pas les sous-frames de la même façon. Une soirée avec un téléphone Android suffit à savoir. (C1, C2)
2. **Les notifications de nouveaux chapitres sur téléphone dépendent du réveil en arrière-plan** (`expo-background-task`). iOS décide seul quand réveiller l'app ; il faut mesurer sur plusieurs jours si les vérifications arrivent réellement. Le serveur, lui, vérifie chaque nuit (cron Vercel) et note ce qu'il trouve : au pire l'app le voit à l'ouverture. Le vrai push (APNs) est C4 et n'est pas commencé.
3. **La recherche** (`/api/search`) est refusée par DuckDuckGo depuis les adresses de Vercel. Sur le téléphone, la recherche mène donc à DuckDuckGo dans le navigateur intégré, ce qui marche, mais l'onglet Recherche n'a pas de résultats à lui. Soit un autre moteur, soit la recherche est faite côté client.
4. **Un domaine** (A5 : préparé, l'achat reste à faire). `panelflow-backend.vercel.app` figure dans les pages légales et dans l'app.

### 2.2 Important pour la qualité perçue

5. **Les chapitres enregistrés hors ligne** n'existent pas sur le téléphone. `shared/offline-store.js` veut un IndexedDB ; il faudrait une implémentation sur `expo-file-system`, avec un plafond de taille et un écran « ce qui est enregistré ». C'est la fonctionnalité la plus demandée d'un lecteur de manga sur téléphone.
6. **Changer d'adresse e-mail** n'est pas possible depuis l'app (la page de confidentialité dit d'écrire). Une route `PUT /api/auth/email` avec confirmation par lien, comme le mot de passe.
7. **Un écran « signaler un problème »** dans l'app, qui prépare un e-mail avec la version du build, le site en cours et les dernières lignes du journal. Aujourd'hui les testeurs envoient des captures d'écran ; c'est ce qui coûte le plus de temps de diagnostic.
8. **Couverture des sites** (D3). La détection est heuristique et la liste des sites a été écrite « de mémoire » (le fichier le dit). Chaque site qu'un testeur utilise et qui ne marche pas mérite une règle dans `shared/detection-rules.json`, et une entrée dans le test de sites.
9. **MangaUpdates** comme troisième tracker (D2).

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

Le cycle est celui de ce dépôt : corriger, `npm test`, `npm run build:ios`, `npm run submit:ios`. Le nouveau build apparaît dans le groupe « Amis » sans nouvelle revue. Vérifier de quel commit vient un build avec `npx eas-cli build:view <id> --json` (champ `gitCommitHash`) : un build en retard sur le correctif a déjà produit un faux « ça ne marche toujours pas ».

**À envisager avant de commencer : `expo-updates`.** Aujourd'hui chaque correctif est un build complet (quinze à vingt minutes de file, puis TestFlight). Avec `expo-updates` (EAS Update), un correctif qui ne touche que du JavaScript, ce qui est le cas de presque tous ceux de ce dépôt, est poussé en une minute et l'app le prend au prochain lancement, sans passer par TestFlight. C'est un après-midi d'installation (`npx expo install expo-updates`, un canal par profil dans `eas.json`, `npx eas update --channel production`). Ça change la vie pendant une semaine de test avec des amis.

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
