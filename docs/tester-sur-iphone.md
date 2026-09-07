# Tester PanelFlow sur ton téléphone, depuis Windows

Ce document couvre le client React Native (`native/`). Pour compiler les coques
Swift et Kotlin, c'est [`premier-build-mobile.md`](premier-build-mobile.md) —
et il faut un Mac pour la première.

Ici, non. Trois façons d'avoir l'app sur un téléphone, de la plus rapide à la
plus lourde.

> Les blocs ci-dessous sont une commande par ligne, à lancer une par une.
> PowerShell 5.1 — le terminal par défaut de Windows — n'a pas l'opérateur
> `&&` : les enchaîner sur une seule ligne est une erreur de syntaxe, pas une
> erreur d'installation. Et de toute façon chacune de ces commandes pose des
> questions auxquelles il faut répondre.

## 1. Expo Go — cinq minutes, rien à installer sur le téléphone

Le moyen de voir l'app tourner aujourd'hui.

```bash
cd native
npm install
npx expo start
```

Un QR code s'affiche dans le terminal. Sur le téléphone : installe **Expo Go**
(App Store / Play Store), ouvre-le, scanne le code. Le PC et le téléphone
doivent être sur le même réseau Wi-Fi ; sinon `npx expo start --tunnel` passe
par un tunnel et marche depuis n'importe où (c'est plus lent).

Ce que tu peux tester comme ça : la bibliothèque, la connexion au compte, les
dossiers, la recherche, la liste des sites, le navigateur intégré, la détection
de chapitre et le lecteur. C'est-à-dire le chemin complet « ouvrir un site →
lire un chapitre → le retrouver à la bonne page ».

Ce qui ne marchera pas dans Expo Go : les notifications en arrière-plan
(l'app doit être ouverte), et rien d'autre — tous les modules natifs utilisés
sont déjà dans Expo Go.

**L'app n'est pas installée** : elle vit dans Expo Go et disparaît quand tu
arrêtes `expo start`. C'est un banc d'essai, pas une installation.

## 2. Un vrai fichier installable — sans Mac, gratuit côté Apple pour Android

```bash
npm install -g eas-cli
eas login                       # compte Expo, gratuit
cd native
eas init                        # une seule fois : crée le projet côté Expo
eas build --platform android --profile preview
```

La compilation tourne sur les machines d'Expo, pas ici. À la fin, un lien vers
un `.apk` : tu le télécharges directement sur le téléphone Android et tu
l'installes. Aucun compte Google Play nécessaire.

C'est aussi la meilleure façon de tester les notifications, que Expo Go bride.

## 3. TestFlight sur iPhone — sans Mac

La compilation et l'envoi se font sur les serveurs d'Expo. **Aucun Mac n'est
nécessaire à aucun moment** — c'est la seule chose que ce chemin remplace. Il
faut en revanche un **Apple Developer Program** (99 $/an) : TestFlight passe par
App Store Connect, qui n'existe pas sans lui. La note de
`premier-build-mobile.md` — « le compte à 99 $ n'est pas nécessaire » — vaut
pour installer l'app sur ton propre iPhone depuis Xcode, pas pour TestFlight.

Dans l'ordre, une seule fois :

```bash
npm install -g eas-cli
eas login                       # compte Expo, gratuit — pas le compte Apple
cd native
eas init                        # crée le projet côté Expo, écrit son id dans app.json
npm run build:ios               # demande les identifiants Apple, puis compile
npm run submit:ios              # envoie le dernier build à App Store Connect
```

Les fois suivantes, les deux dernières lignes suffisent.

### Ce que la première compilation va demander

- **Tes identifiants Apple.** `eas build` s'en sert pour enregistrer
  l'identifiant `dev.panelflow` sur ton compte et créer le certificat et le
  profil de provisioning, qu'il garde ensuite pour toi. Rien à faire dans le
  portail développeur à la main.
- **« Would you like to set up Push Notifications? »** → **non**. L'app ne
  reçoit rien du serveur : ses notifications sont locales, levées par la
  vérification de chapitres qui tourne dans l'app. Une clé APNs ne servirait à
  rien tant que le point « APNs/FCM » du backlog n'est pas fait.
- **Le nom dans App Store Connect.** « PanelFlow » doit être libre sur tout
  l'App Store, pas seulement sur ton compte. S'il est pris, la soumission
  échoue en le disant ; le nom de l'enregistrement App Store Connect est le
  seul à changer, pas celui de l'app sur l'écran d'accueil.

### Qui peut installer, et quand

- **Testeurs internes** (jusqu'à 100 personnes de ton propre compte, toi
  compris) : le build est disponible dans TestFlight **dès qu'Apple l'a traité**,
  en général dix à trente minutes. **Aucune revue.** C'est le chemin pour te le
  mettre sur ton propre téléphone.
- **Testeurs externes** (n'importe quelle adresse e-mail, jusqu'à 10 000) : la
  première version passe une revue « beta », en général quelques heures. Les
  builds suivants du même groupe passent sans revue.

Le numéro de build est géré par Expo (`appVersionSource: "remote"` dans
`eas.json`), donc pas de « build number already used » à démêler à la main.

### Avant de lancer une compilation

Passe cinq minutes sur l'option 1. Une compilation iOS prend dix à vingt
minutes de file d'attente, et un plantage au démarrage se voit en dix secondes
dans Expo Go — pour le même diagnostic.

## Ce qu'on aimerait savoir

Dans cet ordre. Le premier point suffit à rendre la session utile.

1. **Est-ce que l'app s'ouvre sur une bibliothèque ?** Un écran vide avec le
   message « rien ici » est un succès ; un écran noir n'en est pas un.
2. **Crée un compte depuis l'onglet Compte, puis va dans Sites et ouvre un site
   de scan.** La page se charge-t-elle dans le navigateur intégré ?
3. **Ouvre un chapitre.** La pastille « Reader Mode » apparaît-elle ? Le bouton
   *Lire* en bas de l'écran s'allume-t-il ?
4. **Ajoute la série** (bouton *Ajouter à la bibliothèque*), reviens en arrière :
   est-elle sur l'étagère, avec sa couverture ?
5. **Ferme l'app, rouvre-la.** La série est-elle toujours là, à la bonne page ?

Si un script injecté meurt, l'app le dit elle-même : un encadré rouge apparaît
en bas de la page, avec le nom du fichier. C'est `mobile/inject/report-failure.js`
et c'est la réponse la plus utile qu'on puisse recevoir — recopie-la telle
quelle. Sinon, les `console.warn` du client sortent dans le terminal où tourne
`expo start`, préfixés `[panelflow]`.

## Ce qui n'est pas encore porté

Les statistiques, l'historique, les trackers (AniList / MyAnimeList), les
chapitres enregistrés hors-ligne et le blocage de pub par requête. La liste et
ses raisons sont dans [`../native/README.md`](../native/README.md).
