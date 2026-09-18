# Campagne de tests terrain

Écrit le 18 septembre 2026 à partir de l'audit du même jour (`PanelFlow_Audit_Complet_2026-09-18.pdf`). L'audit sépare trois choses, et ce document garde la séparation : **ce que le code prouve** (les 1 400 tests, désormais exécutés par la CI à chaque push, plus l'E2E Chrome), **ce qui est documenté comme manquant** (voir `etat-des-lieux.md`), et **ce qui doit être exécuté sur du vrai** : appareils, réseaux, comptes, sites. Cette page est le plan de la troisième.

Le principe qui gouverne tout : **un cas ne compte que s'il laisse une trace**. Chaque exécution, réussie ou non, est une ligne dans le registre (§6) avec le commit, la plateforme, l'URL, les étapes, l'attendu, l'observé, et pour un échec la console, le réseau et une capture. « Ça marche chez moi » n'est pas une ligne.

---

## 1. Ce que la CI prouve déjà, à chaque commit

| Preuve | Où |
|---|---|
| Les tests unitaires et d'intégration (backend, cœur partagé, extension, téléphone), Node 20 et 22 | `.github/workflows/ci.yml`, job `test` |
| Les fichiers générés sont à jour (`sync:shared`, `build:icons`) | job `drift` |
| Le zip de l'extension et le bundle JavaScript du téléphone se construisent | job `bundle` |
| L'extension chargée dans un vrai Chromium sur un site de scan synthétique : détection d'un chapitre, lecteur ouvert avec toutes les pages, aucune fausse détection sur une page de série, garde anti-popup (ouverture bloquée, lien réécrit refusé), changement de chapitre sans quitter le lecteur | job `e2e`, `backend/test/e2e/` |
| Le registre des sites (§4) se régénère à la demande | `scripts/check-sites.mjs` |

Ce que la CI ne prouve pas, et ne prouvera jamais : un appareil, un réseau, un compte, un vrai site. C'est l'objet des sections suivantes.

---

## 2. Android sur appareil réel (HAUTE)

Personne n'a jamais lancé le client React Native sur Android. Deux points sont connus d'avance : `navigation-policy.js` ne distingue pas un tap d'un script sur Android (tout est `other`), donc un lien vers un autre site ne fera rien ; et `onShouldStartLoadWithRequest` n'y rapporte pas `isTopFrame`.

**Préparer.** `npm run build:android` produit un APK (`eas.json`, profil `preview`). L'installer sur deux appareils au moins (un récent, un ancien : Android 10 et 14 par exemple).

**Parcours, chacun une ligne du registre :**

| # | Parcours | Attendu |
|---|---|---|
| A1 | Ouvrir l'app, créer un compte, ajouter une série depuis Sites | Étagère avec couverture |
| A2 | Ouvrir un chapitre | Lecteur ouvert seul, toutes les pages |
| A3 | Chapitre suivant / précédent depuis le lecteur | Sans quitter le lecteur |
| A4 | Tap sur un lien externe légitime (Telegram du site) | Attendu : refusé (limite documentée) ; noter si ça gêne |
| A5 | Page avec pub OnClick (voiranime) : tap sur Lire | Aucune redirection |
| A6 | Vidéo dans une iframe (vidmoly via voiranime) | Le lecteur vidéo se charge, le contrôle de vitesse apparaît |
| A7 | Site mis en liste blanche dans Réglages › Blocage des publicités | Ses scripts passent, ceux des autres non |
| A8 | Bouton retour matériel : dans le lecteur, dans la page, à la racine | Ferme le lecteur, puis remonte l'historique, puis quitte le navigateur |
| A9 | Rotation pendant la lecture | Position conservée |
| A10 | Veille de l'écran 5 min puis reprise, mi-chapitre | Position conservée, pas de rechargement |
| A11 | Réglages › Chapitres enregistrés : enregistrer, couper le réseau, ouvrir | Les pages s'affichent hors ligne |
| A12 | Réglages › Signaler un problème | Le mail s'ouvre avec build, appareil, page, événements |

---

## 3. Réveil en arrière-plan (HAUTE) : campagne de sept jours

L'app demande à iOS de la réveiller pour vérifier les nouveaux chapitres (`expo-background-task`). iOS décide seul quand ; personne n'a mesuré s'il le fait.

**Protocole.** Sur trois iPhones au moins (modèles et versions d'iOS différents), une bibliothèque de dix séries dont deux publient tous les jours. Pendant sept jours, ne pas ouvrir l'app sauf le matin pour relever. Chaque relevé est une ligne : appareil, date, heure du dernier réveil (Réglages › Signaler un problème montre les derniers événements ; y ajouter une note `check` est la première chose à faire si elle manque), nombre de vérifications effectuées, notifications reçues, notifications attendues (les chapitres réellement sortis, vérifiés à la main sur le site).

**Lire le résultat.** Si le nombre de réveils est nul ou tombe après le deuxième jour, iOS a rétrogradé l'app : c'est le cas normal pour une app peu ouverte, et la réponse est APNs (C4 dans `roadmap.md`), pas un réglage. Le serveur vérifie de toute façon chaque nuit (cron Vercel) et note ce qu'il trouve : l'app le voit à l'ouverture, ce qui est le filet.

---

## 4. Sites réels (HAUTE) : le registre

`node scripts/check-sites.mjs` visite chaque domaine de `shared/detection-rules.json` et écrit `docs/sites-registry.{json,md}` : la page d'accueil répond-elle, et sur les sites de lecture qui répondent, le lecteur ouvrirait-il le premier chapitre trouvé (`shared/compat.js`, la même analyse que le lecteur exécute). Première exécution le 18 septembre, depuis ce PC.

**Lire le registre.** `challenge` (un mur Cloudflare) et `timeout` depuis ce PC ne condamnent pas un site : l'antivirus de cette machine bloque un tiers des domaines, et un téléphone sur un autre réseau les voit. `moved` et `error:ENOTFOUND` sont des entrées à retirer ou à corriger. `no-sample` veut dire que la page d'accueil ne lie aucun chapitre : le site est vivant mais la preuve de lecture manque, et c'est à faire à la main (§4.2).

**4.1 À chaque campagne.** Relancer le script, commettre le registre, comparer avec le précédent : un site passé de `ok` à `error:ENOTFOUND` est mort, un site passé à `moved` a changé de domaine et l'entrée doit suivre.

**4.2 La preuve de lecture à la main, par famille de sites.** Pour chaque moteur connu (`engines` dans les règles : manganato, themesia, madara, foolslide) et pour chaque site fréquemment utilisé, un chapitre réel ouvert sur PC (extension) et sur téléphone, et une ligne : détection, titre, chapitre, contenu chargé (toutes les images), navigation suivant/précédent, progression enregistrée, reprise au bon endroit. Le contrat E2E par page de l'audit, dans cet ordre.

---

## 5. Publicités (HAUTE)

`backend/test/adblock.test.js` prouve les invariants des listes ; l'E2E prouve la garde sur une page synthétique. Ce que ni l'un ni l'autre ne prouvent : qu'aucune pub ne passe sur un site réel.

**Protocole, par site** (les dix sites les plus utilisés, dont voiranime et vidmoly) : dans Chrome avec l'extension, DevTools ouvert sur Réseau et Console, en enregistrant :

| # | Action | Ce qu'on regarde |
|---|---|---|
| P1 | Chargement de la page de chapitre | Requêtes vers des hôtes de `adblock-list.json` : aucune ne doit aboutir |
| P2 | Clic sur le lecteur / sur Lire | Aucun onglet ouvert, aucune navigation hors site |
| P3 | Dix navigations dans le site | Idem, à chaque fois |
| P4 | Suivant / précédent | Idem |
| P5 | Retour arrière, rechargement | Idem |
| P6 | Ouverture dans un nouvel onglet | Idem |
| P7 | Popup / redirection attendue (site connu pour) | Bloquée, avec la ligne `[PanelFlow] blocked …` en console |
| P8 | Lien dont l'adresse change sous le doigt | Refusé (`blocked a link whose address changed`) |
| P9 | Chargement d'une iframe (lecteur vidéo) | La vidéo passe, ses pubs non |

Quatre configurations pour chaque : bloqueur activé, bloqueur désactivé (le témoin), site en liste blanche, backend injoignable (mode avion après chargement de l'extension : la liste embarquée doit suffire). Une anomalie conserve l'URL, l'export HAR du réseau, la console et une capture.

**Classer à part** ce qui n'est pas un bug PanelFlow : un site derrière Cloudflare qui refuse la machine, un domaine bloqué par Kaspersky. Ce sont des lignes du registre, pas des tickets.

---

## 6. Le registre des exécutions

Un fichier CSV, `docs/campagne-resultats.csv`, une ligne par cas exécuté, quel que soit le résultat. Colonnes :

```
date,commit,plateforme,dimension,cas,url,etapes,attendu,observe,resultat,console,reseau,capture,note
```

`résultat` vaut `ok`, `echec`, `hors-perimetre` (Cloudflare, antivirus) ou `non-execute`. Un échec sans `console`, `reseau` ou `capture` renseigné est une ligne incomplète, pas un bug rapportable.

L'objectif chiffré de l'audit (≈ 8 560 cas : 200 sites × 8 parcours, 200 × 4 types de pages, etc.) est **une cible de couverture, pas une promesse** : on la remplit site par site, et le registre dit à tout moment où on en est. Les dimensions et leurs budgets :

| Dimension | Budget | Où sont les cas |
|---|---|---|
| Sites / domaines | 200 × 8 | §4.2, par site |
| Types de pages (chapitre, série, accueil, recherche) | 200 × 4 | §4.2 |
| Médias (manga, webtoon, novel, anime) | 200 × 4 | §4.2, colonne `dimension` |
| Navigation | 200 × 6 | A3, A8, P3–P6 |
| Adblock | 200 × 4 | §5, quatre configurations |
| Bibliothèque | 100 × 8 | ajout, retrait, dossier, tags, note, export, import, migration de site |
| Progression | 100 × 6 | page, défilement, reprise, deux appareils, effacement, historique |
| Hors ligne | 50 × 8 | A11, expiration à 90 jours, plafond, retrait de série, interruption mi-sauvegarde |
| Auth / sync | 50 × 8 | inscription, connexion, mot de passe oublié, changement d'adresse, suppression, deux appareils, session expirée, serveur injoignable |
| Accessibilité / responsive | 25 × 8 | clavier seul, lecteur d'écran, 375 px, thème clair/sombre |
| Android / iOS | 50 × 8 | §2, et les mêmes sur iPhone |
| Trackers | 20 × 8 | §7 |
| Résilience réseau | 50 × 8 | mode avion à chaque étape de A1–A11 |

---

## 7. Trackers : des comptes de test, jamais le vrai

Aucun identifiant OAuth réel n'a jamais été exécuté depuis le dépôt. Les tests d'écriture (pousser une progression) **ne doivent jamais toucher un compte de production** : un mauvais rapprochement écrit un compteur de chapitres sur l'entrée de quelqu'un d'autre, et l'audit le dit avant nous.

**Préparer.** Un compte AniList et un compte MyAnimeList créés pour ça, vides. Sur chaque, une application OAuth déclarée avec pour `redirect_uri` `https://panelflow-backend.vercel.app/api/trackers/<service>/callback`. Sur Vercel, les variables `PANELFLOW_ANILIST_CLIENT_ID`, `PANELFLOW_ANILIST_CLIENT_SECRET`, `PANELFLOW_ANILIST_REDIRECT_URI` (et `MAL` de même).

**Le cycle, une ligne par étape, sur PC puis sur téléphone :** connecter (la page d'autorisation s'ouvre, le retour revient au serveur ; sur téléphone c'est l'exception « own server » de `navigation-policy.js` qui est testée là), lister (Réglages › Trackers montre le compte), lier une série ajoutée depuis un site (la correspondance est proposée, ou refusée quand le titre est ambigu : les deux sont attendus), lire un chapitre (la progression apparaît sur le tracker dans la minute), importer la liste du tracker, déconnecter (le jeton disparaît côté serveur, la page de confidentialité le promet), laisser expirer le jeton (AniList : un an ; forcer avec une révocation côté AniList) et vérifier que l'écran le dit.

---

## 8. Porte de sortie

La beta publique (App Store, Chrome Web Store) ne s'ouvre que si :

1. la CI est verte sur `main` ;
2. §2 (Android) exécuté sur deux appareils, aucun cas A1–A12 en `echec` ;
3. §3 (réveil) mesuré sept jours, et la conclusion écrite dans `etat-des-lieux.md`, quelle qu'elle soit ;
4. §4.2 exécuté pour les quatre moteurs et les dix sites les plus utilisés, sur PC et téléphone ;
5. §5 exécuté pour ces dix sites, aucune requête publicitaire aboutie bloqueur activé ;
6. §7 exécuté sur les comptes de test, pour les deux services ;
7. aucun ticket P0 ouvert, aucune régression sur le corpus synthétique (E2E) ni sur les lignes `ok` du registre des exécutions.

Ce qui reste `non-execute` dans le registre le jour de la sortie est listé dans `etat-des-lieux.md` comme non vérifié. « Non vérifié » et « fonctionne » sont deux mots différents, et le document les garde différents.
