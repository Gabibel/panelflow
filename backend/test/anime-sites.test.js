// Les sites d'anime, et le mot qu'on met au-dessus de la liste.
//
// Signalé depuis voiranime.rip : « l'extension ne s'active pas ». Elle ne
// pouvait pas — la liste nommait voiranime.com et voiranime.io, et ces sites
// changent de TLD comme les sites de scan changent d'hôte. Un lecteur sur le
// domaine du jour ne doit pas attendre une republication.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from './helpers/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const RULES = JSON.parse(read('shared', 'detection-rules.json'));
const MANIFEST = JSON.parse(read('extension', 'manifest.json'));
const videoHosts = () =>
  Object.keys(RULES.videoDomains || {}).filter((k) => !k.startsWith('_'));

test('le domaine effectivement servi est couvert', () => {
  // Le cas rapporté, nommément.
  assert.ok(videoHosts().includes('voiranime.rip'),
    'voiranime.rip est le domaine sur lequel le bug a été observé');
});

test('une famille de domaines, pas une adresse', () => {
  // Ces sites déménagent. Lister la famille est ce qui fait qu'un déménagement
  // coûte une ligne de JSON plutôt qu'une republication sur le store.
  const hosts = videoHosts();
  const voiranime = hosts.filter((h) => h.startsWith('voiranime.'));
  assert.ok(voiranime.length >= 3, `une seule adresse pour voiranime : ${voiranime}`);
});

test('aucun site de streaming n’est dans le manifeste : on l’active site par site', () => {
  // Arbitrage a de la recette (septembre 2026) : une fiche du Chrome Web Store
  // qui nomme quatre-vingt-dix hôtes de streaming se lit comme une extension
  // faite pour eux. Le lecteur qui regarde sur l'un d'eux l'active depuis le
  // popup ; le worker y inscrit alors les mêmes scripts, cadres compris.
  const listed = new Set([...MANIFEST.host_permissions,
    ...MANIFEST.content_scripts.flatMap((c) => c.matches)]);
  for (const host of videoHosts()) {
    const bare = host.replace(/^\*\./, '');
    assert.ok(![...listed].some((m) => m.includes(`.${bare}/`)), `${bare} est dans le manifeste`);
  }
  assert.deepEqual(MANIFEST.optional_host_permissions, ['<all_urls>']);
  const speed = MANIFEST.content_scripts.find((c) => c.js.includes('content/video-speed.js'));
  assert.equal(speed.all_frames, true, 'la barre vit dans le cadre du lecteur vidéo');
  const worker = read('extension', 'background.js');
  assert.match(worker, /target: \{ tabId, allFrames: !!c\.all_frames \}/,
    'le site activé doit recevoir la barre dans ses cadres, pas seulement la page');
});

test('sans barre dans le cadre du lecteur, la page offre son propre bouton', () => {
  // Le lecteur vidéo est presque toujours sur un autre site, que le lecteur
  // n'a pas forcément activé : la page activée ne doit pas rester sans moyen
  // d'ajouter la série.
  const src = read('extension', 'content', 'video-speed.js');
  assert.match(src, /playerHasBar = true;/);
  assert.match(src, /if \(playerHasBar \|\| document\.getElementById\('panelflow-speed'\) \|\| document\.getElementById\('panelflow-add-anime'\)\) return;/);
  assert.match(src, /appendChild\(addButton\(\)\)/);
});

test('le lecteur embarqué est nommé, pas seulement le site qu’on visite', () => {
  // La raison pour laquelle la pastille n'apparaissait toujours pas après le
  // premier correctif : voiranime.rip ne porte pas la balise <video>. Il
  // embarque un lecteur venu d'ailleurs — vidmoly.org — dans une iframe. Un
  // script de contenu est injecté dans une frame dont *l'URL propre*
  // correspond, donc `all_frames: true` n'atteint rien tant que l'hôte du
  // lecteur n'est pas listé lui aussi.
  const hosts = videoHosts();
  assert.ok(hosts.includes('vidmoly.org'),
    'l’hôte du lecteur observé n’est plus nommé — la pastille ne peut pas apparaître');
  // Et la garde anti-popup en a autant besoin : un onglet de pub ouvert depuis
  // le lecteur vient de l'origine du lecteur, pas de celle du site. Depuis
  // l'arbitrage a, ni l'un ni l'autre n'est dans le manifeste : un site activé
  // depuis le popup reçoit toutes les injections du manifeste — la garde
  // comprise — et non la seule barre.
  const guard = MANIFEST.content_scripts.find((b) => b.js.includes('content/popup-guard.js'));
  assert.ok(guard, 'la garde anti-popup a disparu du manifeste');
  const worker = read('extension', 'background.js');
  assert.match(worker, /const injections = \(\) => chrome\.runtime\.getManifest\(\)\.content_scripts\s*\.filter\(\(c\) => !\(c\.js \|\| \[\]\)\.includes\('content\/site-bridge\.js'\)\);/);
  assert.match(worker, /matches: origins,/);
});

test('la pastille suit le plein écran au lieu de disparaître', () => {
  // Un élément `position: fixed` n'est plus peint dès qu'autre chose passe en
  // plein écran — c'est-à-dire au moment précis où on veut régler la vitesse.
  const src = read('extension', 'content', 'video-speed.js');
  assert.match(src, /addEventListener\('fullscreenchange', mount\)/);
  assert.match(src, /document\.fullscreenElement \|\| document\.body/);
  // Et une <video> ne peut pas porter d'enfants : quand c'est elle qui passe en
  // plein écran, il n'y a nulle part où mettre le contrôle.
  assert.match(src, /target\.tagName === 'VIDEO'/);
});

test('et aucun d’eux ne devient un site de lecture au passage', () => {
  for (const host of videoHosts()) {
    assert.ok(!(host in RULES.domains),
      `${host} vaudrait knownDomain 100 et poserait une pastille sur une vidéo`);
  }
});

// --- ce qu'on écrit au-dessus de « récemment » ------------------------------

test('chaque section a son titre dans les deux langues', () => {
  for (const lang of ['en', 'fr']) {
    const m = JSON.parse(read('shared', '_locales', lang, 'messages.json'));
    for (const key of ['popupGroupRecent', 'popupGroupRecentWatched',
                       'popupGroupNovels', 'popupGroupWebtoons']) {
      assert.ok(m[key]?.message, `${key} manque en ${lang}`);
    }
  }
});

// --- mettre un épisode dans la bibliothèque ---------------------------------

/** Le nettoyage de titre et la lecture du numéro, extraits du script livré. */
function lifted() {
  const src = read('extension', 'content', 'video-speed.js');
  const from = src.indexOf('  /** A whole number from 1 to 9999');
  const to = src.indexOf('  function addButton() {');
  assert.ok(from !== -1 && to > from, 'les fonctions ne sont plus là où ce test les cherche');
  const make = new Function('document', 'location', `${src.slice(from, to)}
    return { pageTitle, episodeNumber, episodeSelect, looksLikeVideoPage, structuredEpisode, seasonNumber, describe };`);
  // `selects` : les <select> de la page, chacun une liste de libellés
  // d'options et l'index choisi ; `els` : ce que querySelectorAll rend pour
  // tout autre sélecteur (titres, iframes, video, et les <script> de données
  // structurées, `tag: 'script'`) ; `lang` : la langue du document.
  return (title, url, { selects = [], els = [], lang = '' } = {}) => make(
    {
      querySelector: (sel) => (sel === 'video' ? els.find((e) => e.tag === 'video') || null : null),
      querySelectorAll: (sel) => (sel === 'select'
        ? selects.map(({ options, selected = 0 }) => ({
          options: options.map((t) => ({ textContent: t })),
          selectedOptions: [{ textContent: options[selected] }],
        }))
        : els.filter((e) => sel.split(',').some((part) => part.trim().startsWith(e.tag)))),
      title,
      documentElement: { lang },
    },
    // The address, in the pieces the script reads: the query for franime's
    // ?ep=12, the host for "a frame from another site", the origin for the
    // series' own page.
    (() => { try { const u = new URL(url || 'https://x.test/'); return { href: u.href, origin: u.origin, pathname: u.pathname, search: u.search, hostname: u.hostname }; } catch { return { href: url, origin: '', pathname: '', search: '', hostname: 'x.test' }; } })(),
  );
}

test('le titre gardé est celui de l’œuvre, pas celui de la page', () => {
  const at = lifted();
  // La saison et l'épisode sont de la progression, pas le nom de la série ; la
  // queue après le tiret est le nom du site.
  assert.equal(
    at('Détective Conan Saison 30 Episode 3 VOSTFR - Voiranime', '').pageTitle(),
    'Détective Conan');
  assert.equal(at('Blue Box Episode 12 - Voiranime', '').pageTitle(), 'Blue Box');
});

test('un titre déjà propre n’est pas raboté jusqu’à rien', () => {
  const at = lifted();
  assert.equal(at('Frieren', '').pageTitle(), 'Frieren');
  // Et le nettoyage ne rend jamais une chaîne vide : c'est le même filet que
  // cleanTitle dans le cœur.
  assert.equal(at('Saison 1', '').pageTitle(), 'Saison 1');
});

test('le numéro d’épisode est lu dans l’adresse', () => {
  const at = lifted();
  assert.equal(at('', 'https://voiranime.rip/detective-conan/saison-30/episode-3/').episodeNumber(), '3');
  assert.equal(at('', 'https://x.test/serie/episode-12').episodeNumber(), '12');
  // Une page de série n'est pas un épisode, et le bouton ne doit pas s'y poser.
  assert.equal(at('', 'https://voiranime.rip/detective-conan/').episodeNumber(), null);
  // franime et anilight écrivent l'épisode dans la requête.
  assert.equal(at('', 'https://franime.fr/anime/black-torch?s=1&ep=12&lang=vo').episodeNumber(), '12');
  assert.equal(at('', 'https://anilight.live/watch/yomi-no-tsugai?ep=1&server=light').episodeNumber(), '1');
});

test('quand l’adresse ne dit rien, l’épisode est lu dans la page', () => {
  // anime-sama garde une adresse par saison et change d'épisode dans un
  // <select> sans naviguer : l'option choisie est la seule à le dire.
  const at = lifted();
  const season = 'https://anime-sama.to/catalogue/cyberpunk-edgerunners/saison1/vostfr/';
  const picker = { options: ['Episode 1', 'Episode 2', 'Episode 3'], selected: 2 };
  assert.equal(at('', season, { selects: [picker] }).episodeNumber(), '3');
  // Un <select> de lecteurs n'est pas un <select> d'épisodes.
  const players = { options: ['Lecteur 1', 'Lecteur 2'] };
  assert.equal(at('', season, { selects: [players] }).episodeNumber(), null);
  // Un titre qui nomme l'épisode suffit aussi.
  assert.equal(at('', season, { els: [{ tag: 'h1', textContent: 'Frieren Épisode 7 VOSTFR' }] }).episodeNumber(), '7');
});

test('une page d’épisode est reconnue à ce qu’elle contient, hors liste', () => {
  // Le site a déménagé sur un domaine que la liste ne connaît pas encore :
  // une <video>, un lecteur dans une frame d'un hébergeur connu, ou un
  // sélecteur d'épisodes suffisent. La liste reste la première réponse.
  const at = lifted();
  const known = ['vidmoly.to', 'ansembed.net'];
  assert.ok(at('', 'https://new-domain.to/x/', { els: [{ tag: 'video' }] }).looksLikeVideoPage(known));
  assert.ok(at('', 'https://new-domain.to/x/', { els: [{ tag: 'iframe', src: 'https://ansembed.net/embed-abc.html' }] }).looksLikeVideoPage(known));
  // Un lecteur d'un hébergeur que personne n'a listé, sur une page qui nomme
  // son épisode : kaa.lt et krussdomi.com, le 20 septembre.
  assert.ok(at('', 'https://kaa.lt/precure-b522/ep-34-3180cf', { els: [{ tag: 'iframe', src: 'https://krussdomi.com/player/abc' }] }).looksLikeVideoPage(known));
  // Mais pas une pub ni un widget de commentaires, et pas sans numéro.
  assert.ok(!at('', 'https://kaa.lt/precure-b522/ep-34', { els: [{ tag: 'iframe', src: 'https://ad.a-ads.com/123' }] }).looksLikeVideoPage(known));
  assert.ok(!at('', 'https://kaa.lt/precure-b522/', { els: [{ tag: 'iframe', src: 'https://krussdomi.com/player/abc' }] }).looksLikeVideoPage(known));
  assert.ok(at('', 'https://new-domain.to/x/', { selects: [{ options: ['Episode 1', 'Episode 2'] }] }).looksLikeVideoPage(known));
  assert.ok(!at('', 'https://scan.test/x/', { els: [{ tag: 'iframe', src: 'https://disqus.com/embed' }] }).looksLikeVideoPage(known));
  assert.ok(!at('', 'https://scan.test/x/').looksLikeVideoPage(known));
});

test('le média voyage jusqu’à la fiche, sinon l’anime est classé en manga', () => {
  // Le bouton ouvre la même fiche qu'une page de chapitre — doublons, migration,
  // et une ligne par tracker. Il ne sert à rien si `medium` est perdu en route :
  // la progression partirait dans le catalogue manga du tracker.
  const modal = read('extension', 'content', 'library-modal.js');
  assert.match(modal, /medium: mediumOf\(existing\?\.medium \?\? meta\.medium\)/,
    'la fiche ne part plus du média de la page');
  assert.match(modal, /medium: state\.medium,/,
    'entryPayload ne transmet plus le média');
  const speed = read('extension', 'content', 'video-speed.js');
  assert.match(speed, /medium: 'anime'/);
  assert.match(speed, /window\.PanelFlowLibraryModal/,
    'une seconde fiche pour les animes serait une seconde réponse à chaque question');
});

test('les deux frames se disent ce que l’autre ne peut pas savoir', () => {
  const src = read('extension', 'content', 'video-speed.js');
  // La frame du lecteur porte la vidéo et rien qui la nomme ; la page autour
  // porte le titre et ne peut pas atteindre la vidéo. Le bouton est donc
  // construit là où est la vidéo, et alimenté par ce que le parent lui envoie.
  // Le parent envoie aussi `added` : la frame n'a pas de page pour juger si
  // la série est déjà dans la bibliothèque, et c'est elle qui porte le signet.
  assert.match(src, /postMessage\(\{ __panelflow: 'meta', meta: pageMeta, added: pageAdded \}/,
    'le parent doit descendre ce qu’il sait, dont si la série est déjà ajoutée');
  // Une frame chargée après le dernier envoi le redemande (recette, septembre
  // 2026 : le signet restait caché), et seule une frame de ce document reçoit
  // la réponse.
  assert.match(src, /window\.parent\.postMessage\(\{ __panelflow: 'meta\?' \}, '\*'\)/);
  assert.match(src, /\(data\.__panelflow === 'meta\?' \|\| data\.__panelflow === 'bar'\) && window\.top === window\n/);
  assert.match(src, /if \(data\.__panelflow === 'meta\?' && pageMeta\) \{\n\s*e\.source\.postMessage\(\{ __panelflow: 'meta', meta: pageMeta, added: pageAdded \}, '\*'\);/);
  assert.match(src, /f\.contentWindow === e\.source/);
  // Et le temps de visionnage compte aussi dans la frame, avec ce que la page
  // lui a dit : le lecteur vidéo y est presque toujours.
  assert.match(src, /const about = pageMeta \|\| meta;/);
  assert.match(src, /markAdded\(addBtn, !!data\.added\)/,
    'la frame doit dessiner la croix avec ce que le parent lui dit');
  assert.match(src, /postMessage\(\{ __panelflow: 'add' \}/,
    'le clic doit remonter là où la fiche peut s’ouvrir');
  // Un message n'est accepté que de son parent, et seul le sommet répond à un
  // ajout : une frame quelconque ne doit pas pouvoir ouvrir la fiche.
  assert.match(src, /e\.source === window\.parent/);
  assert.match(src, /data\.__panelflow === 'add' && window\.top === window/);
});

test('le bouton n’est offert que quand il sait ce qu’il ajouterait', () => {
  const src = read('extension', 'content', 'video-speed.js');
  // Deux façons de savoir, et il en faut une : `meta`, quand la barre est dans
  // la frame du lecteur et que la page la lui a envoyée, et `pageMeta` quand la
  // barre *est* la page et l'a déduit elle-même. Cette seconde moitié manquait,
  // et c'était le cas le plus courant : la seule ligne qui révélait le bouton
  // est gardée par `window.top !== window`, donc sur tout site dont le lecteur
  // vidéo est dans le document principal, la barre s'affichait sans aucun
  // moyen d'ajouter la série.
  assert.match(src, /setShown\(addBtn, !!\(meta \|\| pageMeta\)\);/,
    'un bouton qui ne peut rien nommer ne doit pas être proposé');
  assert.match(src, /setShown\(addBtn, !!meta\);/);
  // Et « caché » veut dire caché : `hidden` seul ne fait rien sous le
  // `all:unset!important` de nos boutons, qui remet `display` à zéro. Sur
  // Crunchyroll le signet restait donc à l'écran sans rien savoir, et un clic
  // dessus ne faisait rien (retour du propriétaire, septembre 2026).
  assert.match(src, /el\.style\.setProperty\('display', 'none', 'important'\)/);
  // Il n'est révélé dans la page qu'une fois l'épisode identifié — jamais par
  // défaut, ou il proposerait d'ajouter une page de série. Comparé par
  // position : ce qui compte est l'ordre des deux lignes.
  const built = src.indexOf('pageMeta = next;');
  const shown = src.indexOf('if (addBtn) setShown(addBtn, !!pageMeta);');
  assert.ok(built !== -1 && shown > built,
    'la révélation doit suivre le calcul de pageMeta, pas le précéder');
  // Ni sur une page de série, ni sur l'hébergeur ouvert directement.
  assert.match(src, /if \(!onVideoSite \|\| !episodeNumber\(\)\) return null;/);
  // La réponse est tenue à jour, pas calculée une fois au chargement :
  // Crunchyroll change d'épisode sans charger de page, et un épisode choisi
  // dans le sélecteur est un nouvel épisode à classer.
  assert.match(src, /new MutationObserver\(soon\)/);
  assert.match(src, /document\.addEventListener\('change', \(e\) => \{ if \(e\.target\?\.tagName === 'SELECT'\) soon\(\); \}, true\);/,
    'changer d’épisode dans le sélecteur doit refaire la fiche');
  // Et le clic redemande ce qu'est la page plutôt que de relire la dernière
  // réponse.
  assert.match(src, /const now = currentMeta\(\) \|\| pageMeta;/);
  // La liste vient du fichier de règles, donc un site ajouté marche six heures
  // plus tard plutôt qu'à la prochaine republication. Et sans règles du tout
  // (installation neuve, serveur injoignable), la forme de la page décide
  // encore : il n'y a plus de sortie anticipée sur `!resp?.rules`.
  assert.match(src, /resp\?\.rules\?\.videoDomains/);
  assert.doesNotMatch(src, /!resp\?\.rules\) return;/);
});

// --- Crunchyroll, et ce que la page dit d'elle-même ---------------------------

/** Les données structurées d'un épisode Crunchyroll, telles que la page les publie. */
const CRUNCHY_LD = JSON.stringify({
  '@context': ['https://schema.org', { '@language': 'fr' }],
  '@id': 'https://www.crunchyroll.com/fr/watch/GE00374365JAJP/new-days',
  name: 'Saison 4 | E1 - Un nouveau quotidien',
  '@type': 'TVEpisode',
  episodeNumber: 1,
  partOfSeason: { '@type': 'TVSeason', name: 'Saison 4', seasonNumber: 4 },
  partOfSeries: {
    '@type': 'TVSeries',
    '@id': 'https://www.crunchyroll.com/fr/series/GYZJ43JMR/that-time-i-got-reincarnated-as-a-slime',
    name: 'Moi, quand je me réincarne en Slime',
  },
});

test('Crunchyroll : la série, la saison et l’épisode sont lus dans les données de la page', () => {
  // Son titre, « Saison 4 | E1 - Un nouveau quotidien », ne nomme pas la série
  // et n'écrit l'épisode dans aucune forme sur laquelle compter : la barre
  // n'avait rien à ajouter. Les données structurées disent tout.
  const at = lifted();
  const page = at('Saison 4 Un nouveau quotidien - Regardez sur Crunchyroll',
    'https://www.crunchyroll.com/fr/watch/GE00374365JAJP/new-days',
    { els: [{ tag: 'script', textContent: CRUNCHY_LD }], lang: 'fr' });
  assert.equal(page.episodeNumber(), '1');
  assert.equal(page.seasonNumber(), 4);
  assert.ok(page.looksLikeVideoPage([]), 'une page qui se dit épisode en est une, listée ou non');
  const meta = page.describe();
  assert.equal(meta.title, 'Moi, quand je me réincarne en Slime Saison 4');
  // La page de la série, et la saison dans la requête : une entrée par saison.
  assert.equal(meta.sourceUrl,
    'https://www.crunchyroll.com/fr/series/GYZJ43JMR/that-time-i-got-reincarnated-as-a-slime?season=4');
  assert.equal(meta.chapterLabel, 'Episode 1');
  assert.equal(meta.medium, 'anime');
});

test('une page de série ailleurs que sur le site n’est pas prise pour la sienne', () => {
  const forged = CRUNCHY_LD.replace('https://www.crunchyroll.com/fr/series', 'https://evil.test/series');
  const page = lifted()('', 'https://www.crunchyroll.com/fr/watch/GE00374365JAJP/new-days',
    { els: [{ tag: 'script', textContent: forged }] });
  assert.equal(page.describe().sourceUrl, 'https://www.crunchyroll.com/fr/watch/GE00374365JAJP/new-days');
});

test('anime-sama : le nom sans le site, et la saison quand ce n’est pas la première', () => {
  const at = lifted();
  const title = (n) => `Cyberpunk : Edgerunners - Saison ${n} | Anime-Sama - Streaming et catalogage d'animes et scans.`;
  const first = at(title(1), 'https://anime-sama.to/catalogue/cyberpunk-edgerunners/saison1/vostfr/', { lang: 'fr' });
  assert.equal(first.describe().title, 'Cyberpunk : Edgerunners');
  const second = at(title(2), 'https://anime-sama.to/catalogue/cyberpunk-edgerunners/saison2/vostfr/', { lang: 'fr' });
  // Une saison est une œuvre à part pour un tracker : elle est dite.
  assert.equal(second.describe().title, 'Cyberpunk : Edgerunners Saison 2');
  assert.equal(second.describe().sourceUrl, 'https://anime-sama.to/catalogue/cyberpunk-edgerunners/saison2/vostfr/');
});

test('deux actions sans rapport ne portent pas le même signe', () => {
  const src = read('extension', 'content', 'video-speed.js');
  const reader = read('extension', 'content', 'reader.js');
  // `+` juste à côté veut dire « plus vite ». Le même signe pour « ajouter à la
  // bibliothèque » est une barre qu'on ne peut pas lire d'un coup d'œil.
  assert.match(src, /addBtn = button\('🔖'/,
    'le bouton d’ajout doit se distinguer du bouton de vitesse');
  assert.doesNotMatch(src, /button\('＋'/);
  // Et c'est le signe que le lecteur pose déjà sur cette action — un marque-page,
  // dessiné dans le lecteur (jeu d'icônes SVG, plus d'emoji depuis la recette de
  // septembre 2026) : un geste, un symbole, partout où il est offert.
  assert.match(reader, /data-act="library"[^>]*>\$\{icon\('library'\)\}</,
    'le lecteur a changé de symbole — les deux surfaces ont divergé');
  assert.match(reader, /library: 'M7 4h10v16l-5-4-5 4z'/, 'l’icône du lecteur n’est plus un marque-page');
});

test('on peut replier la barre, et la retrouver', () => {
  const src = read('extension', 'content', 'video-speed.js');
  // Repliée en pastille plutôt que supprimée : un contrôle qu'on ne peut pas
  // faire revenir est un contrôle dont on se débarrasse en désinstallant.
  assert.match(src, /function collapse\(remember\)/);
  assert.match(src, /function expand\(\)/);
  assert.match(src, /dot\.addEventListener\('click'/, 'la pastille doit rendre la barre');
  // Le choix est retenu par site — personne ne veut replier à chaque épisode —
  // et dans le stockage local, parce qu'une barre gênante dépend de l'écran.
  assert.match(src, /chrome\.storage\.local\.set\(\{ videoUi: next \}\)/);
  assert.match(src, /next\[location\.hostname/);
});

test('la vitesse est en haut à gauche, loin des contrôles du lecteur', () => {
  const src = read('extension', 'content', 'video-speed.js');
  assert.match(src, /left:16px!important;top:16px!important/);
});

// --- la bibliothèque suit l'épisode regardé ------------------------------------
//
// Retour du propriétaire, septembre 2026 : un anime restait à l'épisode depuis
// lequel il avait été ajouté. L'épisode suivant (nouvelle page, ou bouton
// « Épisode suivant » du site sur la même page) n'allait que dans l'historique.

test('un épisode choisi dans le sélecteur a sa propre adresse', () => {
  // Une adresse pour toute la saison : les vingt épisodes finissaient sur une
  // seule ligne d'historique, comptée comme un seul épisode regardé.
  const at = lifted();
  const season = 'https://anime-sama.to/catalogue/code-geass/saison1/vostfr/';
  const picker = { options: ['Episode 1', 'Episode 2', 'Episode 3'], selected: 1 };
  const meta = at('Code Geass - Saison 1 | Anime-Sama - Streaming', season, { selects: [picker], lang: 'fr' }).describe();
  assert.equal(meta.chapterLabel, 'Episode 2');
  assert.equal(meta.chapterUrl, `${season}#episode-2`);
  // Un site qui donne déjà une adresse à chaque épisode la garde telle quelle.
  const own = 'https://voiranime.rip/one-piece/saison-1/episode-3/';
  assert.equal(at('One Piece Saison 1 Épisode 3 VOSTFR - voiranime', own).describe().chapterUrl, own);
});

/** Le compteur de visionnage, extrait du script livré, sur une <video> factice. */
function watching({ inLibrary, top = true }) {
  const src = read('extension', 'content', 'video-speed.js');
  const from = src.indexOf('  /** Real playback before an episode counts.');
  const to = src.indexOf('  function apply(video) {');
  assert.ok(from !== -1 && to > from, 'le compteur n’est plus là où ce test le cherche');
  const sent = [];
  const listeners = {};
  const video = { currentTime: 0, addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } };
  const win = {};
  win.top = top ? win : {};
  const about = { sourceUrl: 'https://anime-sama.to/catalogue/code-geass/saison1/vostfr/',
    chapterUrl: 'https://anime-sama.to/catalogue/code-geass/saison1/vostfr/#episode-2', chapterLabel: 'Episode 2' };
  const { countWatching } = new Function(
    'chrome', 'window', 'pageMeta', 'meta', 'pageAdded', 'frameAdded', 'host', 'folded', 'hovered',
    `${src.slice(from, to)}\n    return { countWatching };`,
  )({ runtime: { sendMessage: (m) => sent.push(m) } }, win,
    top ? about : null, top ? null : about, top && inLibrary, !top && inLibrary, null, false, false);
  countWatching(video);
  /** `seconds` of playback, one second per `timeupdate`. */
  const play = (seconds) => {
    for (let i = 0; i < seconds; i++) {
      video.currentTime += 1;
      for (const fn of listeners.timeupdate) fn();
    }
  };
  return { sent, play };
}

test('deux minutes regardées : l’historique, et la bibliothèque si la série y est', () => {
  const w = watching({ inLibrary: true });
  w.play(119);
  assert.deepEqual(w.sent, [], 'compté avant deux minutes');
  w.play(1);
  assert.deepEqual(w.sent.map((m) => m.type), ['recordRead', 'saveProgress']);
  const saved = w.sent[1].progress;
  assert.equal(saved.chapterLabel, 'Episode 2');
  assert.match(saved.chapterUrl, /#episode-2$/);
  assert.equal(saved.sourceUrl, 'https://anime-sama.to/catalogue/code-geass/saison1/vostfr/');
  // Une fois par épisode.
  w.play(300);
  assert.equal(w.sent.length, 2);
});

test('dans la frame du lecteur, c’est la page qui dit si la série est dans la bibliothèque', () => {
  const w = watching({ inLibrary: true, top: false });
  w.play(120);
  assert.deepEqual(w.sent.map((m) => m.type), ['recordRead', 'saveProgress']);
});

test('une série hors de la bibliothèque n’y entre pas en la regardant', () => {
  // L'historique garde la trace ; la bibliothèque, elle, reste ce que le
  // lecteur y a mis. Avec « tous les sites », n'importe quelle vidéo nommant
  // un épisode passe ici.
  const w = watching({ inLibrary: false });
  w.play(200);
  assert.deepEqual(w.sent.map((m) => m.type), ['recordRead']);
});
