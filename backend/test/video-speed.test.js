// L'accélérateur de vidéo.
//
// Pas un lecteur : le lecteur du site reste où il est, et ce fichier ne touche
// qu'à `playbackRate` sur la balise `<video>` qu'il a déjà. C'est toute la
// conception — remplacer un lecteur veut dire gérer les sources, les
// sous-titres, le DRM et le plein écran sur chaque site qui existe, alors que
// régler une vitesse est une propriété que tous les navigateurs implémentent
// pareil depuis quinze ans.
//
// L'arithmétique est extraite du fichier livré (§0.4), jamais recopiée ici.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const src = read('extension', 'content', 'video-speed.js');

/** Les bornes et l'arrondi, sortis du script livré. */
function lift() {
  const from = src.indexOf('  const MIN = 0.5;');
  const to = src.indexOf('  // What the reader last chose');
  assert.ok(from !== -1 && to > from, 'les bornes ne sont plus là où ce test les cherche');
  return new Function(`${src.slice(from, to)}
    return { snap, clamp, label, MIN, MAX, STEP, DEFAULT };`)();
}

test('la plage demandée est celle qui est livrée', () => {
  const { MIN, MAX, STEP, DEFAULT } = lift();
  assert.equal(MIN, 0.5);
  assert.equal(MAX, 4);
  assert.equal(STEP, 0.5);
  assert.equal(DEFAULT, 1);
});

test('toute la grille de 0,5 à 4 est atteignable, et rien entre les crans', () => {
  const { snap, MIN, MAX, STEP } = lift();
  const grid = [];
  for (let r = MIN; r <= MAX + 1e-9; r += STEP) grid.push(Math.round(r * 10) / 10);
  assert.deepEqual(grid, [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
  for (const r of grid) assert.equal(snap(r), r, `${r}× doit rester ${r}×`);
  // Entre deux crans, on tombe sur le plus proche : une vitesse hors grille
  // arrive d'un lecteur qui a son propre menu, pas d'un clic sur nos boutons.
  assert.equal(snap(1.7), 1.5);
  assert.equal(snap(1.8), 2);
  assert.equal(snap(2.24), 2);
});

test('on ne sort pas des bornes, même en insistant', () => {
  const { snap } = lift();
  assert.equal(snap(0.1), 0.5, 'sous 0,5 rien n’est intelligible');
  assert.equal(snap(0), 0.5);
  assert.equal(snap(-3), 0.5);
  assert.equal(snap(9), 4, 'au-delà de 4 rien n’est regardable');
  // L'infini n'est pas « le plus vite possible », c'est une absence de réponse :
  // aucun lecteur ne rapporte ça, donc on retombe sur la vitesse normale.
  assert.equal(snap(Infinity), 1);
});

test('une valeur qui n’est pas un nombre retombe sur la vitesse normale', () => {
  // Une vitesse lue depuis un lecteur qui répond n'importe quoi ne doit pas
  // laisser la vidéo à NaN — c'est-à-dire figée, sans message.
  const { snap, DEFAULT } = lift();
  for (const bad of [NaN, undefined, null, 'vite', {}]) {
    assert.equal(snap(bad), DEFAULT, `${String(bad)} doit retomber sur 1×`);
  }
});

test('l’affichage ne montre pas les décimales du flottant', () => {
  // 0.5 + 0.5 + 0.5 vaut 1.5000000000000002 en JavaScript, et c'est ce qui
  // serait écrit sur le bouton.
  const { label } = lift();
  assert.equal(label(1.5000000000000002), '1.5×');
  assert.equal(label(1), '1×');
  assert.equal(label(4), '4×');
});

test('le son n’est jamais coupé par nous', () => {
  // Le lecteur a demandé à aller plus vite, pas à regarder en silence. Un
  // lecteur qui coupe le son tout seul à 2,5× a l'air cassé, pas prévenant.
  assert.doesNotMatch(src, /\.muted\s*=\s*true/);
  assert.doesNotMatch(src, /\.volume\s*=\s*0/);
});

test('le script est injecté dans toutes les frames', () => {
  // Sur une page de streaming le lecteur est presque toujours dans une iframe,
  // et un script cantonné à la frame principale n'y trouve aucune vidéo.
  const manifest = JSON.parse(read('extension', 'manifest.json'));
  const block = manifest.content_scripts.find((b) => b.js.includes('content/video-speed.js'));
  assert.ok(block, 'video-speed.js n’est déclaré nulle part');
  assert.equal(block.all_frames, true);
  assert.ok(block.matches.length > 0, 'un script sans site est un script mort');
});

test('les sites d’anime sont injectés sans devenir des sites de lecture', () => {
  // Une entrée sous `domains` vaut knownDomain 100, donc une pastille « Reader
  // Mode » sur chaque page d'épisode. Les deux listes sont séparées pour ça, et
  // les deux atterrissent quand même dans le manifeste.
  const rules = JSON.parse(read('shared', 'detection-rules.json'));
  const video = Object.keys(rules.videoDomains || {}).filter((k) => !k.startsWith('_'));
  assert.ok(video.length >= 3, 'la liste des sites vidéo est vide');
  for (const host of video) {
    assert.ok(!(host in rules.domains),
      `${host} est dans les deux listes — il vaudrait knownDomain 100`);
  }
  const manifest = JSON.parse(read('extension', 'manifest.json'));
  const block = manifest.content_scripts.find((b) => b.js.includes('content/video-speed.js'));
  for (const host of video) {
    assert.ok(block.matches.includes(`*://*.${host}/*`), `${host} n’est pas injecté`);
  }
});

test('la garde anti-popup couvre aussi les sites d’anime', () => {
  // C'est la moitié de ce qu'on vient chercher sur ces sites : une pub à chaque
  // clic. popup-guard.js existait déjà et fait exactement ça — il fallait juste
  // que ces domaines soient dans sa liste.
  const manifest = JSON.parse(read('extension', 'manifest.json'));
  const guard = manifest.content_scripts.find((b) => b.js.includes('content/popup-guard.js'));
  const rules = JSON.parse(read('shared', 'detection-rules.json'));
  for (const host of Object.keys(rules.videoDomains || {}).filter((k) => !k.startsWith('_'))) {
    assert.ok(guard.matches.includes(`*://*.${host}/*`),
      `${host} n’est pas protégé des popups`);
  }
});
