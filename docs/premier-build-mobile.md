# Premier build mobile — à lire avant de commencer

Pour la personne qui a un Mac et va compiler PanelFlow pour la première fois.

## La chose importante, d'abord

**Ce code n'a jamais été compilé.** Ni sur Mac, ni sur PC, jamais. Il a été
écrit sur Windows, où il n'existe ni Xcode ni SDK Android — donc aucun
compilateur ne l'a jamais lu.

Tu es la première personne à essayer. **Si ça ne compile pas du premier coup,
c'est normal et ce n'est pas toi.** C'est même la raison pour laquelle on te
demande de le faire : trouver ces erreurs est le but de l'exercice, pas un
effet de bord.

Note ce que dit le compilateur et renvoie-le tel quel. Une erreur de
compilation est une information précise ; « ça marche pas » ne l'est pas.

Ce que tu peux raisonnablement attendre : des imports manquants, une signature
d'API qui a changé depuis, un fichier absent du projet généré. Ce que tu ne
devrais pas voir : de la logique fausse — 1 250 tests couvrent le cœur, qui est
du JavaScript partagé avec l'extension Chrome et tourne, lui, tous les jours.

## Ce qu'il te faut

- un Mac avec **Xcode** (gratuit sur le Mac App Store)
- **Homebrew**, pour installer XcodeGen
- un **iPhone** et un câble
- un identifiant Apple ordinaire — **le compte développeur à 99 $/an n'est pas
  nécessaire** pour installer sur ton propre téléphone

## Compiler

```bash
git clone https://github.com/Gabibel/panelflow
cd panelflow/ios
brew install xcodegen
xcodegen generate
open PanelFlow.xcodeproj
```

Le projet Xcode n'est pas dans le dépôt : il est **généré** depuis
`ios/project.yml`. C'est voulu — un `.xcodeproj` est un fichier que deux
personnes ne peuvent pas éditer sans conflit, et il n'aurait pas pu être écrit
depuis Windows de toute façon.

Un script (`Scripts/bundle-assets.sh`) tourne avant la compilation et copie la
couche web dans `ios/Generated/`. Tu peux le lancer à la main pour voir ce qui
part dans l'app.

## Installer sur ton iPhone

1. Dans Xcode : **Signing & Capabilities** → coche *Automatically manage
   signing* → choisis ton équipe personnelle (ton identifiant Apple).
2. Change le **Bundle Identifier** pour quelque chose d'unique — mets ton nom
   dedans, par exemple `dev.tonnom.panelflow`. Deux personnes ne peuvent pas
   signer le même identifiant.
3. Branche l'iPhone, choisis-le comme destination, **⌘R**.
4. Sur le téléphone : *Réglages → Général → VPN et gestion de l'appareil* →
   fais confiance à ton certificat de développeur.

**L'app expire au bout de 7 jours** avec un compte gratuit. Il suffit de la
relancer depuis Xcode pour repartir pour une semaine. C'est la seule chose que
les 99 $/an achètent ici.

## Ce qu'on aimerait savoir

Dans cet ordre — le premier point suffit à rendre la journée utile.

1. **Est-ce que ça compile ?** Sinon, l'erreur exacte.
2. **Est-ce que ça s'ouvre sur une bibliothèque ?** Si l'écran reste noir ou
   vide, c'est une panne connue possible et elle se nomme maintenant elle-même
   dans les logs (voir plus bas).
3. **Crée un compte, ajoute une série depuis un site de scan, ouvre un
   chapitre.** Le lecteur s'ouvre-t-il ? Les pages s'affichent-elles ?
4. **Ferme l'app, rouvre-la.** La série est-elle toujours là, à la bonne page ?
5. **Sur un site d'anime** (voiranime, anime-sama…) : une petite barre de
   vitesse apparaît-elle en haut à gauche de la vidéo ?

## Lire ce que l'app dit d'elle-même

Elle a été instrumentée exprès pour ce test. Ouvre **Console.app** sur le Mac,
choisis l'iPhone dans la colonne de gauche, et filtre sur `panelflow`.

Tu devrais y voir nommées, si elles arrivent :

- un fichier absent du bundle (`www/index.html is missing…`)
- un message perdu entre l'app et son moteur (`dropped an envelope…`)
- la liste de blocage introuvable (`blocker-rules.json is missing…`)
- la vérification de chapitres qui n'a pas pu être programmée

Si l'app fait quelque chose d'étrange **sans** rien écrire là, dis-le aussi :
ça veut dire qu'il reste un endroit muet, et c'est une information en soi.

## Si tu veux plutôt essayer Android

C'est moins cher à mettre en route et ça ne demande aucun Mac :

```bash
cd panelflow/android
./gradlew assembleDebug
```

L'APK sort dans `app/build/outputs/apk/debug/`. Même avertissement : jamais
compilé non plus. Les logs se lisent avec `adb logcat -s panelflow`.

## Pour comprendre le projet

- [`ONBOARDING.md`](ONBOARDING.md) — la carte du dépôt, à lire en premier
- [`DEBUG.md`](DEBUG.md) — d'un symptôme à un nom de fichier
- [`../ios/README.md`](../ios/README.md) — comment la coque iOS est faite

Et merci : deux des quatre façades du produit n'existent que sur le papier
tant que quelqu'un ne les a pas fait tourner une fois.
