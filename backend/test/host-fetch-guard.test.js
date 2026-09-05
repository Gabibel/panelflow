// La série sur un site que ce navigateur n'a pas le droit d'interroger.
//
// Signalé depuis chrome://extensions :
//
//   Access to fetch at 'https://mangack.com/manga/eternally-regressing-knight/'
//   from origin 'chrome-extension://…' has been blocked by CORS policy
//
// mangack.com n'est pas dans le fichier de règles, donc l'extension ne détient
// aucune permission d'hôte pour lui, donc le worker — qui tourne sur une origine
// `chrome-extension://` — se fait refuser par le CORS. Le site n'y est pour
// rien, et ça ne réussira jamais : ni au prochain cycle, ni au suivant.
//
// Le `catch` disait pourtant « site unreachable — try next cycle ». Une panne
// permanente déguisée en incident passager, une ligne rouge par série et par
// vérification dans la page d'erreurs de l'extension, et rien du tout pour le
// lecteur.
//
// Rien n'est perdu pour autant : le veilleur serveur atteint ces sites sans
// permissions de navigateur, et le premier client qui s'ouvre récupère ce qu'il
// a trouvé. Ce qu'il fallait, c'était demander avant plutôt qu'apprendre de
// l'échec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootCore, html, entryFixture } from '../test-support/core.js';
import { bootWorker } from '../test-support/worker.js';

const series = (chapter) => html(`<html><body>
  <a href="/manga/x/chapitre-${chapter}">Chapitre ${chapter}</a>
</body></html>`);

test('une origine interdite n’est pas demandée du tout', async () => {
  const asked = [];
  const { core } = bootCore({
    storage: {
      library: [
        entryFixture({ sourceUrl: 'https://permis.test/manga/a', sourceDomain: 'permis.test',
          lastKnownChapter: '10' }),
        entryFixture({ sourceUrl: 'https://mangack.com/manga/b', sourceDomain: 'mangack.com',
          lastKnownChapter: '10' }),
      ],
    },
    fetch: async (url) => { asked.push(String(url)); return series(12); },
    // Le prédicat que l'extension fournit ; le site et le téléphone n'en
    // passent aucun et gardent le comportement d'avant.
    canFetch: (url) => !String(url).includes('mangack.com'),
  });

  await core.checkNewChapters();

  assert.deepEqual(asked, ['https://permis.test/manga/a'],
    'la requête vouée au CORS a quand même été envoyée');
});

test('les séries permises sont vérifiées normalement à côté', async () => {
  const seen = [];
  const { core } = bootCore({
    storage: {
      library: [entryFixture({ sourceUrl: 'https://permis.test/manga/a',
        sourceDomain: 'permis.test', lastKnownChapter: '10' })],
    },
    fetch: async (url) => { seen.push(String(url)); return series(12); },
    canFetch: () => true,
  });
  await core.checkNewChapters();
  assert.deepEqual(seen, ['https://permis.test/manga/a']);
  const lib = await core.getLibrary();
  assert.equal(lib[0].lastKnownChapter, '12', 'la vérification n’a rien trouvé');
});

test('sans prédicat, rien ne change pour le site et le téléphone', async () => {
  // Le cœur est partagé et ne connaît aucune permission : seule l'extension en
  // a. L'absence de réponse doit valoir oui, pas non.
  const seen = [];
  const { core } = bootCore({
    storage: {
      library: [entryFixture({ sourceUrl: 'https://ailleurs.test/m/a',
        sourceDomain: 'ailleurs.test', lastKnownChapter: '1' })],
    },
    fetch: async (url) => { seen.push(String(url)); return series(2); },
  });
  await core.checkNewChapters();
  assert.equal(seen.length, 1, 'un client sans permissions doit continuer à interroger');
});

test('le worker de l’extension demande ses permissions avant de sortir', async () => {
  // Le bout qui manquait vraiment : le prédicat doit être *branché*, pas
  // seulement exister. Un cœur qui sait demander et un worker qui ne lui donne
  // rien, c'est la même erreur CORS avec du code en plus.
  const w = bootWorker({
    storage: {
      library: [entryFixture({ sourceUrl: 'https://mangack.com/manga/b',
        sourceDomain: 'mangack.com', lastKnownChapter: '10' })],
    },
    fetch: async () => series(12),
  });
  await w.send({ type: 'checkNow' });
  assert.ok(!w.calls.some((c) => c.url.includes('mangack.com')),
    'le worker a interrogé un site pour lequel il n’a pas de permission');
});

test('un site accordé à la main depuis le popup redevient vérifiable', async () => {
  // C'est la sortie offerte au lecteur, et elle doit marcher : accorder
  // l'origine depuis le popup est ce qui fait que cette branche cesse d'être
  // prise. Sinon le message lui demande de faire une chose sans effet.
  const w = bootWorker({
    storage: {
      library: [entryFixture({ sourceUrl: 'https://mangack.com/manga/b',
        sourceDomain: 'mangack.com', lastKnownChapter: '10' })],
    },
    fetch: async () => series(12),
  });
  w.grant('*://*.mangack.com/*');
  await w.send({ type: 'checkNow' });
  assert.ok(w.calls.some((c) => c.url.includes('mangack.com')),
    'accorder le site depuis le popup n’a rien changé');
});
