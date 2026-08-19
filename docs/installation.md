# Installer PanelFlow dans Chrome

Six étapes, cinq minutes. Aucune connaissance technique n'est nécessaire : si
vous savez décompresser un fichier, vous savez faire ceci.

PanelFlow n'est pas encore sur le Chrome Web Store. On l'installe donc « en mode
développeur », ce qui est la façon normale d'installer une extension qu'on vous a
envoyée directement. Ça ne casse rien et ça se désinstalle en un clic.

Fonctionne avec **Chrome, Edge, Brave et Opera** (même moteur, mêmes écrans).
Pas avec Firefox ni Safari.

---

## 1. Décompressez le fichier

Vous avez reçu `panelflow-0.1.0.zip`. Faites un clic droit dessus →
**Extraire tout** (Windows) ou double-clic (Mac).

Vous obtenez un dossier `panelflow-0.1.0`. **Laissez-le où il est et ne le
supprimez pas** : Chrome ne copie pas l'extension, il la lit depuis ce dossier à
chaque démarrage. Un bon endroit, c'est `Documents`.

> Le dossier doit contenir un fichier `manifest.json` **directement à l'intérieur**.
> Si vous voyez un dossier qui contient un dossier, descendez d'un cran.

## 2. Ouvrez la page des extensions

Dans Chrome, tapez ceci dans la barre d'adresse et validez :

```
chrome://extensions
```

*(Sur Edge : `edge://extensions`. Sur Brave : `brave://extensions`.)*

<!-- CAPTURE 1 — docs/img/install-1-extensions.png
     La page chrome://extensions vide ou presque, avec l'interrupteur
     « Mode développeur » bien visible en haut à droite. -->

## 3. Activez le « Mode développeur »

L'interrupteur est **en haut à droite** de cette page. Activez-le.

Trois boutons apparaissent juste en dessous.

## 4. Cliquez sur « Charger l'extension non empaquetée »

C'est le premier des trois boutons. Il ouvre un sélecteur de dossier.

**Choisissez le dossier `panelflow-0.1.0`** — le dossier lui-même, pas un fichier
à l'intérieur, pas le `.zip`.

<!-- CAPTURE 2 — docs/img/install-2-charger.png
     Le mode développeur activé, les trois boutons visibles, et le sélecteur de
     dossier ouvert sur le dossier panelflow-0.1.0 (on doit voir manifest.json
     dedans). -->

PanelFlow apparaît dans la liste. C'est installé.

**Épinglez-le** pour avoir le bouton sous la main : l'icône pièce de puzzle à
droite de la barre d'adresse → la punaise à côté de PanelFlow.

## 5. Ce que l'extension a le droit de faire

Cliquez sur **Détails** sous PanelFlow, puis regardez **Autorisations**. C'est la
liste complète, et elle vaut d'être lue :

- **Lire et modifier vos données sur une cinquantaine de sites**, nommés un par
  un — sushiscan.fr, mangadex.org, bato.to… Ce sont les sites de scans que
  PanelFlow sait lire. **Pas votre banque, pas votre messagerie** : ils ne sont
  pas dans la liste, et une extension ne peut rien faire sur un site qui n'y est
  pas.
- **Bloquer du contenu sur les pages** — c'est le bloqueur de publicités et la
  garde anti-popup.
- **Notifications** — pour vous prévenir d'un nouveau chapitre.
- **Stockage** — votre bibliothèque et vos chapitres hors-ligne, sur votre
  disque.

Sur un site de scans qui n'est **pas** dans la liste, PanelFlow ne fait rien du
tout tant que vous ne le lui demandez pas : le bouton de la barre d'outils vous
proposera « Activer PanelFlow sur ce site », site par site, et vous seul décidez.

## 6. Vérifiez que ça marche

Allez sur un chapitre, par exemple n'importe quel chapitre de
[sushiscan.fr](https://sushiscan.fr).

**Une pastille apparaît sur l'icône PanelFlow** et le bouton du lecteur s'affiche
sur la page. Cliquez dessus (ou `Alt+R`) : le lecteur s'ouvre.

<!-- CAPTURE 3 — docs/img/install-3-detecte.png
     Un chapitre sushiscan ouvert, la pastille visible sur l'icône PanelFlow
     dans la barre d'outils, et le bouton du lecteur sur la page. -->

C'est tout. **Pas besoin de créer un compte** : la bibliothèque, la progression,
le hors-ligne et les statistiques fonctionnent en local. Le compte ne sert qu'à
retrouver la même bibliothèque sur un autre appareil ou sur le téléphone.

---

## Si ça ne marche pas

**« Impossible de charger l'extension » / une erreur rouge.**
Le dossier choisi n'est pas le bon. Il doit contenir `manifest.json`
directement. Redescendez d'un niveau, ou remontez d'un.

**L'extension est là mais rien ne se passe sur le site.**
Rechargez la page (`F5`). Chrome n'injecte rien dans les onglets déjà ouverts
au moment de l'installation.

**Rien ne se passe non plus après rechargement.**
Ce site n'est peut-être pas dans la liste des cinquante. Cliquez sur l'icône
PanelFlow : si le message dit que PanelFlow ne fonctionne pas encore ici,
il y a un bouton pour l'activer sur ce site.

**PanelFlow a disparu au redémarrage de Chrome.**
Le dossier a été déplacé ou supprimé. Chrome le lit à chaque démarrage.

**Un bandeau « Désactiver les extensions en mode développeur ».**
C'est l'avertissement normal de Chrome pour toute extension installée hors du
Store. Fermez-le. Il revient à chaque démarrage, c'est agaçant et sans
conséquence — il disparaîtra le jour où PanelFlow sera publié sur le Store.

## Désinstaller

`chrome://extensions` → **Supprimer** sous PanelFlow. Puis effacez le dossier.
Rien n'est laissé ailleurs sur la machine.

## Vérifier le fichier reçu (facultatif)

`npm run pack` imprime le SHA-256 du zip, et ce zip est fabriqué uniquement à
partir de fichiers versionnés, sur un dépôt propre et des tests verts. Si on vous
a donné cette empreinte avec le lien, vous pouvez la comparer :

```bash
certutil -hashfile panelflow-0.1.0.zip SHA256
```

```bash
shasum -a 256 panelflow-0.1.0.zip
```

Les deux chaînes doivent être identiques.
