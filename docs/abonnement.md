# PanelFlow Premium : mise en place

Ce que le code fait, et ce qui reste à faire à la main (comptes, contrats, clés).
Décision du 2026-10-27 : Premium vend de la place hors ligne et des statistiques
détaillées. Il ne vend jamais l'accès aux chapitres, et tout ce qui est gratuit
aujourd'hui le reste.

## Ce que fait le code

- **Achat** : uniquement dans l'app iPhone, par l'App Store, via le SDK
  RevenueCat (`react-native-purchases`, fichier `native/src/premium.js`).
- **Vérité** : le serveur n'écrit le statut que d'après la réponse de RevenueCat
  (`GET /v1/subscribers/{id}`), demandée avec sa clé secrète
  (`backend/src/premium.js`). L'app ne dit jamais « j'ai payé » : elle demande
  au serveur de revérifier (`POST /api/premium/refresh`).
- **Webhook** : `POST /api/premium/webhook`. Il vérifie l'en-tête
  `Authorization`, puis revérifie chaque compte concerné auprès de RevenueCat.
  Il ne lit rien d'autre dans l'événement.
- **Hors réseau** : l'app garde la dernière réponse de l'App Store et la date de
  fin. Un abonnement qui se renouvelle reste valable 3 jours de plus sans
  réseau.
- **Suppression du compte** : le client RevenueCat est supprimé aussi. L'app
  prévient que l'abonnement Apple, lui, continue tant qu'il n'est pas résilié.

## À faire, dans l'ordre

### 1. App Store Connect

1. Accords, taxes et banque : signer l'accord **Paid Apps** et remplir
   les coordonnées bancaires et fiscales.
2. Demander l'**App Store Small Business Program** (commission de 15 %).
3. App PanelFlow, Abonnements :
   - créer un groupe « PanelFlow Premium » ;
   - ajouter deux abonnements auto-renouvelables :
     - `panelflow_premium_monthly` : 1 mois, 1,99 € ;
     - `panelflow_premium_yearly` : 1 an, 14,99 €.
   - Pour chacun :
     - une offre de lancement « essai gratuit, 1 semaine » ;
     - un nom et une description en français et en anglais ;
     - une capture de l'écran Premium pour la revue.
4. Créer une **clé d'API In-App Purchase** (Utilisateurs et accès, Intégrations)
   pour RevenueCat. Ne la colle nulle part ailleurs que dans RevenueCat.

### 2. RevenueCat (compte à créer par toi)

1. Créer le projet et l'app iOS (bundle `dev.panelflow`), puis y déposer la
   clé In-App Purchase.
2. Créer l'**entitlement** `premium`, et y attacher les deux produits.
3. Créer l'offering `default` (courante) avec deux packages, Monthly et Annual.
4. Récupérer :
   - la **clé publique iOS** (commence par `appl_`) pour l'app ;
   - une **clé secrète v1** (commence par `sk_`) pour le serveur.
5. Intégrations, Webhooks :
   - URL `https://<ton domaine>/api/premium/webhook` ;
   - en-tête d'autorisation : une longue valeur aléatoire, par exemple
     `Bearer ` suivi de 40 caractères.

### 3. Variables d'environnement (jamais dans le dépôt)

| Où | Nom | Valeur |
|---|---|---|
| Vercel (Production) | `REVENUECAT_SECRET_KEY` | la clé `sk_…` |
| Vercel (Production) | `REVENUECAT_WEBHOOK_AUTH` | exactement la valeur de l'en-tête du webhook |
| EAS, environnement `production` | `EXPO_PUBLIC_REVENUECAT_IOS_KEY` | la clé `appl_…` |

Sans `REVENUECAT_SECRET_KEY`, le serveur répond « Premium indisponible » et ne
vend rien. Sans `EXPO_PUBLIC_REVENUECAT_IOS_KEY`, la page Premium de l'app dit
« pas encore disponible ».

### 4. Avant de vendre pour de vrai

- **Statut.** Les mentions légales disent « édité à titre non professionnel ».
  Vendre un abonnement est une activité commerciale : il faut un statut
  (micro-entreprise par exemple), un SIRET, et l'identité complète de l'éditeur
  dans les mentions légales. À trancher par toi, éventuellement avec un
  comptable.
- **Hébergement.** L'offre Hobby de Vercel interdit l'usage commercial : il faut
  passer en **Pro** (20 $ par mois) avant d'encaisser.
- **Fiche App Store.** Ajouter dans la description le lien vers les conditions
  (`/conditions.html`) et le lien vers l'EULA standard d'Apple. Mettre à jour
  les étiquettes de confidentialité : « Historique d'achats », lié au compte,
  fonctionnement de l'app.

### 5. Build et test

- La version passe à **0.1.2**, parce qu'un module natif est ajouté. Il faut donc
  un nouveau build ; une mise à jour OTA ne suffit pas.
- Dans TestFlight, les achats se font en **sandbox** et sont gratuits. Le
  webhook reçoit `environment: SANDBOX`, et le serveur les accepte, ce qui
  permet de tester de bout en bout.

## Vérifier que tout marche

1. TestFlight : Compte, puis PanelFlow Premium. Les deux prix s'affichent, en
   euros.
2. Acheter le mensuel (sandbox). Le message « Bienvenue » apparaît, et la page
   dit « actif, renouvellement le … ».
3. Sur le site, connecté au même compte : `GET /api/premium` répond
   `active: true`.
4. Supprimer l'app, la réinstaller, puis « Restaurer les achats » : Premium
   revient.
