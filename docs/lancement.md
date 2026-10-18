# Avant la publication : sécurité, site et App Store

Revue du 12 octobre 2026, faite sur le code de `main` et sur la configuration
Vercel du projet (en lecture seule). Elle reprend deux listes qui circulent
(« 20 choses à vérifier avant de lancer ton site web » et « 20 essential
website security checks ») et les exigences d'Apple. Pour chaque point : où
on en est, ce qui le prouve dans le dépôt, et ce qui reste à faire, en
distinguant ce que le code fait de ce qui se règle à la main dans un tableau
de bord.

Légende : ✅ en place · 🔧 ajouté pendant cette revue · 👤 à faire par toi
(un réglage ou un compte, pas du code) · ➖ sans objet pour PanelFlow, avec la
raison.

---

## 1. Sécurité (20 points)

| # | Point | État | Où c'est, ou ce qu'il reste |
| --- | --- | --- | --- |
| 1 | Clés d'API cachées | ✅ | Aucune clé dans le code des clients (extension, site, app). Les secrets (session, base, e-mail, AniList, MyAnimeList, Brave) ne vivent que dans les variables d'environnement de Vercel. |
| 2 | Variables d'environnement | ✅ | `backend/.env.example` les liste sans valeur. Le serveur refuse de démarrer en production sans `PANELFLOW_JWT_SECRET` (`backend/src/auth.js`). |
| 3 | Clés dans git | ✅ | Tout l'historique (108 commits) a été fouillé : aucun secret. `.gitignore` exclut `.env`, `.env.*` et `.vercel`. |
| 4 | Routes d'administration protégées | ✅ | La seule route « admin » est le passage nocturne (`/api/watch/run`) : secret partagé comparé en temps constant, et refus si aucun secret n'est configuré. |
| 5 | Authentification | ✅ | Mots de passe hachés avec bcrypt, sessions signées de 30 jours, toutes coupées par un changement de mot de passe (`token_epoch`). |
| 6 | Permissions des utilisateurs | ✅ | Chaque requête filtre par compte (`user_id`). Un test vérifie qu'un compte ne peut ni lire, ni modifier, ni supprimer l'entrée d'un autre (`library.test.js`). |
| 7 | Entrées nettoyées | ✅ | Adresses e-mail normalisées, longueurs bornées, adresses web limitées à http(s) (`http-url.js`), corps de requête plafonné à 1 Mo. |
| 8 | Protection XSS | ✅ | Politique CSP stricte (`script-src 'self'`, aucun script en ligne), textes insérés en `textContent`. Aucun texte venu d'une page ou d'un utilisateur n'est injecté comme HTML. |
| 9 | Injection SQL | ✅ | Toutes les requêtes sont paramétrées. Les rares fragments assemblés sont des constantes du code, jamais une saisie. |
| 10 | Règles de la base | ✅🔧 | La base n'est lisible que par le serveur. Les suppressions sont en cascade : supprimer un compte efface tout. **Ajouté** : les jetons AniList et MyAnimeList, jusqu'ici en clair, sont chiffrés (AES-256-GCM, `backend/src/sealed.js`). Les anciennes lignes sont chiffrées par le passage nocturne. |
| 11 | Limitation de débit | ✅ 👤 | En place sur la connexion, l'inscription, le mot de passe oublié, la réinitialisation, le changement d'adresse, les pages lues pour le compte d'un utilisateur et le relais de couvertures (`rate-limit.js`). 👤 Facultatif : une règle de limitation sur `/api/*` dans le pare-feu Vercel (Firewall), si ton offre le permet. |
| 12 | Plafond de dépenses | 👤 | Rien à coder. À vérifier dans chaque tableau de bord : Vercel (l'offre Hobby s'arrête à ses limites au lieu de facturer ; en Pro, régler « Spend Management »), Turso, Resend, Expo, et Brave Search si une clé payante est utilisée. |
| 13 | Envois de fichiers | ✅ | Seuls deux envois existent, tous deux avec un compte : l'import MyAnimeList (XML lu sans analyseur XML, donc sans faille XXE) et la restauration d'une sauvegarde. Aucun fichier n'est stocké sur le serveur. |
| 14 | Protection CSRF | ➖ | Pas de cookie : la session voyage dans l'en-tête `Authorization`, qu'un autre site ne peut pas envoyer à ta place. Le retour OAuth des trackers est protégé par un `state` signé qui expire au bout de 15 minutes. |
| 15 | Réglages CORS | ✅ | `Access-Control-Allow-Origin: *`, voulu : l'extension et l'app appellent l'API d'ailleurs. Sans cookie, un autre site ne peut rien lire sans le jeton, qu'il n'a pas. |
| 16 | HTTPS | ✅🔧 | Vercel redirige le HTTP vers le HTTPS. **Ajouté** : l'en-tête HSTS est envoyé par le serveur lui-même (2 ans), sauf en local. |
| 17 | En-têtes de sécurité | ✅ | CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, et maintenant HSTS. |
| 18 | Cookies sécurisés | ➖ | Aucun cookie, nulle part (testé par `legal-pages.test.js`). Sur l'iPhone, la session est dans le trousseau d'iOS. |
| 19 | Mode debug désactivé | ✅ | Une erreur ne renvoie jamais de pile d'appels, seulement une référence courte à retrouver dans les journaux. `X-Powered-By` est retiré. |
| 20 | Réglages de production | ✅ | Région Dublin (UE), aperçus protégés par l'authentification Vercel, Node 24. Les déploiements de production des PR #17 et #18 avaient échoué côté Vercel, puis ont été rattrapés : voir la section 4. |

**Dépendances** : aucune faille connue dans celles du serveur (`npm audit`).
L'app en signale 30, toutes dans les outils de compilation (Metro, CLI Expo,
signature) et aucune dans le code qui tourne sur le téléphone. Elles partiront
avec la prochaine mise à jour d'Expo, à faire en dehors d'une période de
publication et à tester sur TestFlight.

---

## 2. Site web (20 points)

| # | Point | État | Où c'est, ou ce qu'il reste |
| --- | --- | --- | --- |
| 1 | Page RGPD | ✅ | `confidentialite.html` / `privacy.html` : tables, durées, destinataires et droits. Des tests vérifient que chaque table de la base y figure. |
| 2 | Page de CGU | ✅ | `conditions.html` / `terms.html`, plus les mentions légales. |
| 3 | API hors du front | ✅ | Le site ne parle qu'à son propre serveur. Aucun secret côté navigateur. |
| 4 | HTTPS forcé | ✅🔧 | Redirection Vercel et HSTS (voir sécurité, point 16). |
| 5 | Bannière cookies | ➖ | Aucun cookie et aucun traceur, donc aucun consentement à demander (règles de la CNIL). La page de confidentialité le dit. |
| 6 | Meta title | ✅🔧 | Un titre par page. **Ajouté** : une description sur la page d'accueil (les pages légales en avaient déjà). |
| 7 | Image pour les réseaux | 🔧 | `web/og-image.png` (1200×630, le logo sur fond papier, dessinée par `scripts/build-icons.mjs`), avec les balises Open Graph et Twitter dans `web/index.html`. |
| 8 | Favicon | 🔧 | `web/icons/` : SVG, PNG 32 px, icône d'écran d'accueil iPhone et icônes du manifeste web (`web/manifest.webmanifest`). `/favicon.ico` répond aussi. |
| 9 | Sitemap et robots.txt | 🔧 | `/sitemap.xml` (accueil, aide, pages légales, en deux langues) et `/robots.txt` (qui écarte `/api/`). |
| 10 | Textes alternatifs des images | ✅ | Les couvertures ont un `alt` vide, voulu : le titre est écrit juste à côté, et un lecteur d'écran le lirait deux fois. Les icônes sont `aria-hidden`. |
| 11 | Images compressées | ✅ | Le site n'a que des icônes de quelques Ko. Les couvertures viennent des sites, relayées sans être stockées. |
| 12 | (masqué sur ta capture) | — | — |
| 13 | Contraste | ✅ | Testé : au moins 4,5:1 sur tous les fonds, dans les deux thèmes (`contrast.test.js`). |
| 14 | Site responsive | ✅ | Vérifié de 360 à 1280 px. Aucun défilement horizontal sur les nouvelles pages. |
| 15 | Page 404 | 🔧 | `web/404.html`, en français et en anglais. L'API garde ses réponses JSON. |
| 16 | Liens cassés | 🔧 | Un test parcourt chaque lien et chaque ancre de chaque page du site (`launch-site.test.js`). Aucun lien cassé. |
| 17 | Validation des formulaires | ✅ | Vérifiée côté navigateur et côté serveur : adresse, mot de passe (8 à 72 octets), âge, dates. |
| 18 | Anti-spam | ✅ | Limites par réseau à l'inscription, et par adresse pour les e-mails (3 par heure vers une même boîte). Le signalement passe par la messagerie de l'utilisateur, il n'y a donc aucun formulaire à spammer. |
| 19 | Outil d'analytics | ➖ | Choix assumé : aucun outil de mesure, c'est une promesse des pages légales. Pour suivre l'usage sans traceur : les statistiques d'App Store Connect et du Chrome Web Store, et des comptes agrégés côté serveur. |
| 20 | Un seul appel à l'action | ➖ | Le site est l'app elle-même (connexion puis bibliothèque), pas une page de présentation. Pour une future page vitrine : un seul bouton, « Télécharger sur l'App Store ». |

**Aussi ajouté** : une page **Aide** (`aide.html` / `support.html`) avec le
contact, les questions fréquentes (compte, mot de passe, export, suppression,
trackers, hors ligne) et ce qui protège les données. Elle est reliée depuis
le site, les pages légales, les réglages de l'app et ceux de l'extension, et
c'est l'« URL d'assistance » exigée par l'App Store.

---

## 3. App Store : ce qui reste avant d'envoyer

Le détail de chaque réponse est dans `docs/store-listing.md`.

- ✅ Suppression du compte dans l'app (règle 5.1.1(v)).
- ✅ Manifeste de confidentialité, sans pistage.
- ✅ Session dans le trousseau d'iOS, et chiffrement déclaré (`ITSAppUsesNonExemptEncryption: false`).
- ✅ « Se connecter avec Apple » non exigé (pas de connexion par un tiers).
- 👤 **Classification par âge : 16+** (accès web non restreint). Réponses dans `store-listing.md`.
- 👤 **App Privacy** : six types de données, aucun pistage. Réponses dans `store-listing.md`.
- 👤 **URL d'assistance et de confidentialité** : `…/aide.html` et `…/confidentialite.html`.
- 👤 **Compte de démo** pour la revue : à créer sur la production, et à saisir dans App Store Connect, jamais dans le dépôt.
- 👤 **Captures d'écran** : direction fixée dans `store-listing.md` (thème papier, aucun nom de site).

### 3 bis. Android : prérequis de chaque publication

- **Le pont du navigateur passe avant la page (SEC-7).** Sur le build Android à publier (APK de test du même commit), lancer la mesure d'ordre : 60 chargements, **0 attendu** où le premier script de la page passe avant l'injection de l'app. Un seul suffit à bloquer la publication. Outil : `qa-sim/tools/android/order-probe.mjs 60`, sur le banc QA local (`qa-sim/`, hors dépôt : émulateur, fausse source avec la route `/__qa/order-probe`, APK de la copie QA) ; avant le correctif : 7 sur 20, après : 0 sur 60 (octobre 2026).
- Le correctif de react-native-webview (`native/patches/`) est appliqué à chaque installation par `postinstall: patch-package --error-on-fail` : s'il ne s'applique plus (bibliothèque mise à jour), l'installation, donc le build EAS et la CI, échoue au lieu de livrer la bibliothèque sans correctif. La CI le vérifie sur le résultat (`native-adblock.test.js`, « the installed library is the patched one »).
- **Ce que Google Play lira dans l'APK.** `node qa-sim/tools/android/apk-facts.mjs <fichier.apk>` (même banc QA, hors dépôt) : SDK cible 36 ou plus (exigé pour toute nouvelle app ou mise à jour depuis le 31 août 2026), bibliothèques natives 64 bits alignées sur 16 Ko, et la liste des permissions, où ne doivent plus figurer ni « afficher par-dessus les autres apps » (`SYSTEM_ALERT_WINDOW`), ni le stockage partagé, ni la biométrie : `native/app.json` les bloque (`blockedPermissions`) depuis la QA P8. Mesuré sur l'APK de test 0.1.1 (octobre 2026) : cible 36, minimum 24, 68 bibliothèques toutes alignées ; les cinq permissions inutiles y figuraient encore.

### 3 ter. Google Play : la première publication

- 👤 **Compte développeur** : un compte personnel créé après le 13 novembre 2023 doit d'abord passer un test fermé de **12 testeurs pendant 14 jours d'affilée** avant d'avoir accès à la production (un compte d'organisation en est dispensé).
- 👤 **Build de publication** : un AAB, `npx eas build --platform android --profile production` dans `native/` (le script `build:android` fait un APK de test). Il porte le correctif SEC-7 et les permissions bloquées ; les deux prérequis de 3 bis se vérifient sur un APK du même commit.
- 👤 **Signature** : EAS a créé la clé Android du projet au premier build de test (OPS-10, BUGS.md) ; elle devient la clé d'envoi de Play App Signing. La garder (EAS la conserve, en faire une copie).
- 👤 **Fiche** : mêmes textes que l'App Store (`store-listing.md`) ; pas de publicité ; public visé 15 ans et plus (l'inscription le demande) ; questionnaire de classification : accès web non restreint, oui.
- 👤 **Sécurité des données** : les faits sont ceux du manifeste iOS (adresse e-mail, identifiant de compte, bibliothèque, historique des chapitres lus, progression, tous facultatifs car liés au compte ; identifiant d'installation aléatoire envoyé à Expo à chaque vérification de mise à jour, pour tous). Chiffré en transit : oui. Suppression : dans l'app et sur le web, `https://panelflow-backend.vercel.app/support.html#delete`.
- 👤 **Accès pour la revue** : le même compte de démo que pour Apple.

### 3 quater. Chrome Web Store

- ✅ Paquet reproductible : `npm run pack` donne les mêmes octets en CI et ici (SHA-256 identique, QA P8), sans `localhost` ni `_metadata`.
- ✅ Aucun code distant : tout script injecté vient du paquet ; les règles et la liste anti-pub reçues du serveur sont des données.
- ✅ Déclaration « Limited Use » dans la politique de confidentialité (`#usage-limite`, `#limited-use`), exigée par le règlement du store sur les données : en ligne à la fusion de la PR.
- 👤 **Onglet « Pratiques de confidentialité »** du tableau de bord : justification de chaque permission (texte prêt dans `store-listing.md`), données traitées (adresse e-mail, identifiants de connexion au moment de se connecter, historique des chapitres lus), et les trois certifications.
- 👤 **Décision à prendre avant l'envoi** : le manifeste nomme 166 sites de lecture, que la revue voit ; le règlement interdit d'aider à accéder sans autorisation à des contenus protégés (« Malicious and Prohibited Products »). C'est le principal risque de refus ou de retrait (QA P8, REPORT.md). Ce n'est pas un avis juridique.

---

## 4. Le déploiement de la production

Le 12 octobre 2026, les déploiements de production des fusions des PR #17
et #18 ont échoué en 3 secondes, avant toute compilation, avec le code
`git_info_fail` : GitHub limitait temporairement les appels de Vercel
(« secondary rate limit »). Les aperçus de ces mêmes commits, eux, étaient
prêts, et la production est restée quelques heures sur la fusion de la
PR #16. La fusion de la PR #19 a tout redéployé (état « Ready »), et
`/robots.txt` et `/aide.html` répondent en production.

Si cela se reproduit, ce n'est pas le code. Dans Vercel : Deployments, le
dernier déploiement de `main`, puis « Redeploy ». Vérifier ensuite qu'il
passe à « Ready » et qu'il est bien le déploiement de production. Après
chaque fusion, la liste des déploiements de production dit si le site a
vraiment changé.

---

## 5. Le freemium (idée : payer 2,99 € au-delà de 50 ou 100 œuvres)

C'est faisable, et le serveur garde déjà un niveau par compte
(`users.tier`, `free` par défaut). Mais plusieurs points sont à trancher
avant d'écrire du code.

**Ce qu'Apple impose.**
- Débloquer une fonction dans l'app passe obligatoirement par l'achat intégré
  (règle 3.1.1).
- Apple garde 15 % avec le Small Business Program (inscription à demander),
  30 % sinon. Sur 2,99 € TTC en France, il reste environ 2,12 € (ou 1,74 €).
  Apple gère la TVA et la facturation.
- Un achat fait ailleurs (site, extension) ne peut débloquer l'app que si le
  même achat existe aussi dans l'app (règle 3.1.3(b)).
- Il faut signer l'accord « Paid Apps » dans App Store Connect, avec
  coordonnées bancaires et fiscales.

**Ce que ça change ailleurs.**
- **Hébergement.** L'offre Hobby de Vercel interdit tout usage commercial.
  Encaisser un paiement impose l'offre Pro, soit 20 $ par mois : une dizaine
  d'achats par mois rien que pour la couvrir.
- **Pages légales.** Les conditions disent aujourd'hui « gratuit, sans achat
  intégré », et les mentions « édité à titre non professionnel ». Vendre fait
  de PanelFlow une activité commerciale : il faut des conditions de vente
  (droit de rétractation compris), une identité complète d'éditeur et, en
  France, un statut (micro-entreprise par exemple). Un test du dépôt échoue
  exprès si une bibliothèque de paiement arrive alors que les conditions
  disent encore « gratuit, sans achat intégré ».
- **Technique.**
  - L'achat est vérifié par le serveur (App Store Server API), puis le compte
    passe au niveau payant.
  - La limite est appliquée partout où une série entre : ajout, import,
    restauration, déplacement.
  - Sans compte, la limite est tenue sur l'appareil.
  - Un bouton « Restaurer mes achats » est obligatoire.

**Les risques pour le produit.**
- **L'import.** Une liste AniList ou MyAnimeList fait souvent plus de 100
  œuvres. Le premier geste d'un nouvel utilisateur se heurterait donc au mur.
- **L'image.** L'étude de MangaPin montre que son point fort payant (la
  synchronisation) est aussi la source de ses pires avis (« bibliothèque
  effacée »). L'avantage de PanelFlow, c'est justement que la bibliothèque et
  la synchronisation sont gratuites. Faire payer la bibliothèque elle-même
  donne l'impression qu'elle est prise en otage.
- **La revue d'Apple.** Faire payer une app qui sert surtout à lire sur des
  sites de scans attire davantage l'attention de la revue et des ayants
  droit. MangaPin le fait, donc c'est possible, mais le risque n'est pas nul.

**Recommandation.**
1. Publier d'abord **gratuitement**, pour gagner des utilisateurs et des notes.
2. Plus tard, une offre « PanelFlow+ » qui vend du **confort**, pas la
   bibliothèque. Exemples :
   - statistiques avancées ;
   - thèmes et réglages du lecteur en plus ;
   - vérification plus fréquente des nouveaux chapitres ;
   - icône d'app au choix.
3. Achat unique (2,99 à 4,99 €) plutôt qu'abonnement : plus simple et plus
   rassurant.
4. Bibliothèque, synchronisation, export, suppression et trackers restent
   gratuits pour toujours.
5. Si tu tiens à une limite d'œuvres :
   - la mettre haut (200 plutôt que 50) ;
   - ne jamais bloquer un import ;
   - ne jamais retirer ni cacher ce qui est déjà dans la bibliothèque ;
   - garder intacts les comptes qui dépassent déjà la limite.
