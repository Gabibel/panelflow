// Les rayons du popup, et ce qu'ils se passent entre eux.
//
// Quatre sortes d'œuvres partagent une bibliothèque, un moteur de rendu, une
// liste de progression et un veilleur. Ce fichier ne teste pas chaque morceau
// isolément — d'autres fichiers le font — il teste qu'ils restent d'accord :
// qu'un anime n'apparaisse pas sous « Lus récemment », qu'un light novel ait
// son rayon, qu'une couverture et un numéro suivent leur entrée quel que soit
// le rayon qui la dessine, et qu'un nouvel épisode remonte comme un chapitre.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootCore, html, entryFixture } from '../test-support/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const POPUP = read('extension', 'popup', 'popup.js');
const MARKUP = read('extension', 'popup', 'popup.html');

test('chaque rayon existe dans le balisage et a sa liste', () => {
  for (const group of ['recent', 'watched', 'novel', 'webtoon']) {
    assert.ok(MARKUP.includes(`data-group="${group}"`), `pas de section ${group}`);
  }
  for (const id of ['recent-list', 'watched-list', 'novel-list', 'webtoon-list']) {
    assert.ok(MARKUP.includes(`id="${id}"`), `pas de liste ${id}`);
  }
});

test('un rayon vide ne s’affiche pas', () => {
  // Un titre au-dessus d'une liste vide est une fonctionnalité dont le lecteur
  // doit deviner qu'il ne s'en sert pas.
  assert.match(POPUP, /section\.hidden = rows\.length === 0;/);
  assert.match(POPUP, /section\.hidden = items\.length === 0;/);
  for (const group of ['watched', 'novel', 'webtoon']) {
    assert.ok(MARKUP.includes(`data-group="${group}" hidden`), `${group} devrait naître caché`);
  }
});

test('une seule carte pour tous les rayons', () => {
  // Une seconde copie serait un second endroit où corriger la prochaine
  // couverture, le prochain badge, la prochaine cible de reprise.
  assert.match(POPUP, /function buildCard\(entry\)/);
  const uses = (POPUP.match(/buildCard\(entry\)/g) || []).length;
  assert.ok(uses >= 4, `buildCard n’est utilisé que ${uses} fois — un rayon dessine autre chose`);

  const from = POPUP.indexOf('function buildCard(entry)');
  const body = POPUP.slice(from, POPUP.indexOf('function renderLibrary()', from));
  for (const part of ['coverInto(', 'card-title', 'card-badge', 'card-ch', 'card-new']) {
    assert.ok(body.includes(part), `la carte ne dessine plus ${part}`);
  }
});

test('un anime ne tombe pas dans « Lus récemment »', () => {
  // Les deux listes lisent la même progression ; sans exclusion l'anime
  // apparaîtrait dans les deux, sous deux mots dont l'un est faux.
  assert.match(POPUP, /const watched = new Set\(state\.library/);
  assert.match(POPUP, /\.filter\(\(p\) => !watched\.has\(p\.sourceUrl\)\)/);
  assert.match(POPUP, /medium\) === 'anime'/, '« Vus récemment » doit ne prendre que les animes');
});

test('les rayons trient comme la grille, pas chacun dans son coin', () => {
  assert.match(POPUP, /PanelFlowView\.sortLibrary\(rows, \{ by: state\.view\.sort/,
    'un rayon qui trie autrement contredit la grille au-dessus de lui');
});

test('une entrée sans média reste un manga, donc reste dans la grille', async () => {
  // Toute la bibliothèque d'avant le champ. Un rayon qui les happerait viderait
  // la grille principale sans que personne ait rien demandé.
  const { core } = bootCore({ storage: {} });
  const made = await core.addToLibrary(entryFixture());
  assert.equal(made.medium, 'manga');
  assert.match(POPUP, /\(e\.medium \|\| 'manga'\) === medium/,
    'le rayon doit lire l’absence de média comme du manga');
});

test('un nouvel épisode remonte comme un nouveau chapitre', async () => {
  // Le veilleur ne connaît pas les médias, et c'est voulu : « quelque chose est
  // sorti » est la même question. Ce test existe pour que ça le reste une fois
  // les animes dedans.
  const entry = entryFixture({
    title: 'Détective Conan',
    sourceUrl: 'https://av.test/detective-conan', sourceDomain: 'av.test',
    lastKnownChapter: '3', medium: 'anime',
  });
  const boot = bootCore({
    storage: { library: [entry] },
    fetch: async () => html('<a href="/detective-conan/episode-4">Episode 4</a>'),
  });

  await boot.core.checkNewChapters();

  const lib = await boot.core.getLibrary();
  assert.equal(lib[0].lastKnownChapter, '4', 'l’épisode 4 n’a pas été vu');
  assert.equal(boot.notifications.length, 1, 'aucune alerte pour un nouvel épisode');
  assert.equal(lib[0].medium, 'anime', 'le média n’a pas survécu au passage du veilleur');
});

test('couverture et numéro suivent l’entrée, quel que soit le rayon', async () => {
  const { core } = bootCore({ storage: {} });
  const ln = await core.addToLibrary(entryFixture({
    title: 'Mushoku Tensei', sourceUrl: 'https://ln.test/mt', sourceDomain: 'ln.test',
    coverUrl: 'https://ln.test/c.jpg', lastKnownChapter: '286', medium: 'novel',
  }));
  assert.equal(ln.medium, 'novel');
  assert.equal(ln.coverUrl, 'https://ln.test/c.jpg');
  assert.equal(ln.lastKnownChapter, '286');
  // Le rayon lit `state.library` : c'est la même entrée, pas une copie que
  // quelqu'un devrait penser à tenir à jour.
  assert.match(POPUP, /state\.library\.filter\(\(e\) => \(e\.medium \|\| 'manga'\) === medium\)/);
});

test('les tags d’une œuvre ne sont pas ses propres sous-pages', () => {
  // Voiranime liste les saisons et les éditions d'une série comme des tags :
  // « Détective Conan », « Détective Conan saison 3 », « Détective Conan vostfr ».
  // Chacun ne parle que de cette série, ce qu'un genre n'est précisément pas.
  const detect = read('extension', 'content', 'detect.js');
  const from = detect.indexOf('function namesTheWork(text, title) {');
  const to = detect.indexOf('function genresInDom(', from);
  assert.ok(from !== -1 && to > from, 'la règle n’est plus là où ce test la cherche');
  const namesTheWork = new Function(`${detect.slice(from, to)} return namesTheWork;`)();

  const title = 'Détective Conan';
  for (const bad of ['Détective Conan', 'Détective Conan saison 3', 'Détective Conan vostfr',
    'detective conan vf', 'DÉTECTIVE CONAN SAISON 1']) {
    assert.equal(namesTheWork(bad, title), true, `« ${bad} » aurait dû être écarté`);
  }
  for (const good of ['Policier', 'Shōnen', 'Mystère', 'Comédie', 'Enquête']) {
    assert.equal(namesTheWork(good, title), false, `« ${good} » est un genre valable`);
  }
  // Sans titre connu on ne jette rien : c'est un filtre, pas une politique.
  assert.equal(namesTheWork('Détective Conan', null), false);
});
