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
