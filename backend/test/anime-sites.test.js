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

test('chaque site vidéo est réellement injecté par le manifeste', () => {
  // Une entrée dans le fichier de règles qui n'atteint pas le manifeste est une
  // ligne qui ne fait rien — exactement le symptôme rapporté.
  for (const block of MANIFEST.content_scripts) {
    if (!block.js.includes('content/video-speed.js')) continue;
    for (const host of videoHosts()) {
      assert.ok(block.matches.includes(`*://*.${host}/*`), `${host} n’est pas injecté`);
    }
    return;
  }
  assert.fail('video-speed.js n’est déclaré nulle part');
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
    'l’hôte du lecteur observé n’est pas injecté — la pastille ne peut pas apparaître');
  // Et la garde anti-popup en a autant besoin : un onglet de pub ouvert depuis
  // le lecteur vient de l'origine du lecteur, pas de celle du site.
  const guard = MANIFEST.content_scripts.find((b) => b.js.includes('content/popup-guard.js'));
  assert.ok(guard.matches.includes('*://*.vidmoly.org/*'));
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

/** La règle du titre, extraite du popup livré (§0.4). */
function heading(entries) {
  const src = read('extension', 'popup', 'popup.js');
  const from = src.indexOf('function recentHeading(entries) {');
  const to = src.indexOf('function renderRecent() {');
  assert.ok(from !== -1 && to > from, 'recentHeading n’est plus là où ce test le cherche');
  return new Function('t', `${src.slice(from, to)} return recentHeading;`)(t)(entries);
}

test('on lit un manga', () => {
  assert.equal(heading([{ medium: 'manga' }, { medium: 'manga' }]), 'Recently read');
  // Une entrée d'avant le champ n'a pas de média : c'est un manga, comme tout
  // ce qui existait alors.
  assert.equal(heading([{}, {}]), 'Recently read');
});

test('on regarde un anime', () => {
  assert.equal(heading([{ medium: 'anime' }]), 'Recently watched');
});

test('et une liste qui tient les deux prend le mot vrai pour chacun', () => {
  // Un seul titre sur une seule liste. Le même raisonnement que folderStatus :
  // quand un écran ne peut pas dire laquelle des deux choses une ligne est, il
  // ne doit pas en choisir une et espérer.
  assert.equal(heading([{ medium: 'anime' }, { medium: 'manga' }]), 'Recently opened');
  assert.equal(heading([{ medium: 'novel' }, { medium: 'anime' }]), 'Recently opened');
});

test('un roman se lit, donc il garde le mot de la lecture', () => {
  assert.equal(heading([{ medium: 'novel' }]), 'Recently read');
});

test('les trois phrases existent dans les deux langues', () => {
  for (const lang of ['en', 'fr']) {
    const m = JSON.parse(read('shared', '_locales', lang, 'messages.json'));
    for (const key of ['popupGroupRecent', 'popupGroupRecentWatched', 'popupGroupRecentMixed']) {
      assert.ok(m[key]?.message, `${key} manque en ${lang}`);
    }
  }
});

// --- mettre un épisode dans la bibliothèque ---------------------------------

/** Le nettoyage de titre et la lecture du numéro, extraits du script livré. */
function lifted() {
  const src = read('extension', 'content', 'video-speed.js');
  const from = src.indexOf('  function pageTitle() {');
  const to = src.indexOf('  function addButton() {');
  assert.ok(from !== -1 && to > from, 'les fonctions ne sont plus là où ce test les cherche');
  let href = '';
  const make = new Function('document', 'location', `${src.slice(from, to)}
    return { pageTitle, episodeNumber };`);
  return (title, url) => make(
    { querySelector: () => null, title },
    { get href() { return url; } },
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
});

test('le média voyage jusqu’à la fiche, sinon l’anime est classé en manga', () => {
  // Le bouton ouvre la même fiche qu'une page de chapitre — doublons, migration,
  // et une ligne par tracker. Il ne sert à rien si `medium` est perdu en route :
  // la progression partirait dans le catalogue manga du tracker.
  const modal = read('extension', 'content', 'library-modal.js');
  assert.match(modal, /medium: state\.meta\.medium \?\? null/,
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
  assert.match(src, /postMessage\(\{ __panelflow: 'meta', meta: pageMeta \}/,
    'le parent doit descendre ce qu’il sait');
  assert.match(src, /postMessage\(\{ __panelflow: 'add' \}/,
    'le clic doit remonter là où la fiche peut s’ouvrir');
  // Un message n'est accepté que de son parent, et seul le sommet répond à un
  // ajout : une frame quelconque ne doit pas pouvoir ouvrir la fiche.
  assert.match(src, /e\.source === window\.parent/);
  assert.match(src, /data\.__panelflow === 'add' && window\.top === window/);
});

test('le bouton n’est offert que quand il sait ce qu’il ajouterait', () => {
  const src = read('extension', 'content', 'video-speed.js');
  assert.match(src, /addBtn\.hidden = true;/,
    'un bouton qui ne peut rien nommer ne doit pas être proposé');
  assert.match(src, /addBtn\.hidden = !meta;/);
  // Ni sur une page de série, ni sur l'hébergeur ouvert directement.
  assert.match(src, /if \(!onVideoSite \|\| !episode\) return;/);
  // La liste vient du fichier de règles, donc un site ajouté marche six heures
  // plus tard plutôt qu'à la prochaine republication.
  assert.match(src, /resp\.rules\.videoDomains/);
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
