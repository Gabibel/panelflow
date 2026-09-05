// De quelle sorte d'œuvre il s'agit.
//
// PanelFlow n'a suivi qu'une seule chose pendant toute sa vie : un manga sur un
// site de scan. Rien dans le modèle ne le disait — ni les 17 champs du schéma,
// ni la table `library` — parce que rien n'avait besoin de le dire tant qu'il
// n'y avait qu'une réponse possible.
//
// `medium` est cette réponse, rendue explicite avant que les light novels et les
// animes ne la rendent nécessaire. Une colonne et non un tag : c'est ce sur quoi
// un tracker route pour décider s'il parle de chapitres ou d'épisodes, et une
// valeur inventée par un client est une progression écrite dans le mauvais
// catalogue sur le vrai compte de quelqu'un.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootCore, json, entryFixture } from '../test-support/core.js';
import { MEDIA, DEFAULT_MEDIUM } from '../src/panelflow-core.js';
import { base, shutdown } from '../test-support/harness.js';

test.after(shutdown);

const signUp = async () => {
  const email = `medium-${crypto.randomUUID()}@test.dev`;
  const r = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'correct horse battery' }),
  });
  return (await r.json()).token;
};
const api = (token, path, init = {}) => fetch(`${base}/api${path}`, {
  ...init,
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
});

test('la liste des médias est close et nommée une seule fois', () => {
  assert.deepEqual(MEDIA, ['manga', 'novel', 'anime', 'webtoon']);
  assert.equal(DEFAULT_MEDIUM, 'manga');
});

test('une bibliothèque existante est du manga, sans rien avoir à dire', async () => {
  // Le défaut n'est pas nul : chaque ligne qui existe aujourd'hui est un manga,
  // et un null obligerait chaque lecteur à répondre « je ne sais pas » puis à
  // deviner — soit la même règle écrite à quatre endroits.
  const token = await signUp();
  const r = await api(token, '/library', {
    method: 'POST',
    body: JSON.stringify({ title: 'Kingdom', sourceDomain: 'scan.test',
      sourceUrl: 'https://scan.test/manga/kingdom' }),
  });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).medium, 'manga');
});

test('un roman et un anime se rangent pour ce qu’ils sont', async () => {
  const token = await signUp();
  for (const [medium, url] of [['novel', 'https://ln.test/n/1'], ['anime', 'https://av.test/a/1']]) {
    const r = await api(token, '/library', {
      method: 'POST',
      body: JSON.stringify({ title: `Œuvre ${medium}`, sourceDomain: 'x.test', sourceUrl: url, medium }),
    });
    assert.equal((await r.json()).medium, medium);
  }
});

test('un média inventé est refusé, pas rangé quelque part', async () => {
  // Refusé et non replié en silence : c'est un client qui se trompe, et le
  // corriger sans le dire est ce qui fait durer l'erreur.
  const token = await signUp();
  const r = await api(token, '/library', {
    method: 'POST',
    body: JSON.stringify({ title: 'x', sourceDomain: 'x.test', sourceUrl: 'https://x.test/1',
      medium: 'donghua' }),
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /medium must be one of manga, novel, anime, webtoon/);
});

test('modifier une entrée sans parler du média ne l’efface pas', async () => {
  // La colonne est NOT NULL, et un éditeur qui ne connaît pas les médias — une
  // version antérieure du client, la modale d'édition — envoie son PUT sans.
  const token = await signUp();
  const made = await (await api(token, '/library', {
    method: 'POST',
    body: JSON.stringify({ title: 'Roman', sourceDomain: 'ln.test',
      sourceUrl: 'https://ln.test/n/2', medium: 'novel' }),
  })).json();

  const put = await api(token, `/library/${made.id}`, {
    method: 'PUT', body: JSON.stringify({ score: 8 }),
  });
  const after = await put.json();
  assert.equal(after.score, 8);
  assert.equal(after.medium, 'novel', 'le média a été perdu par une édition qui ne le mentionnait pas');
});

test('le cœur fixe le média à la création et n’y revient jamais', async () => {
  // Ré-ajouter est aussi la façon dont la modale enregistre : quelqu'un qui a
  // corrigé une détection à la main ne doit pas se la faire reprendre.
  const { core } = bootCore({ storage: {} });
  const first = await core.addToLibrary({ ...entryFixture(), medium: 'anime' });
  assert.equal(first.medium, 'anime');

  const again = await core.addToLibrary({ ...entryFixture({ id: first.id }),
    sourceUrl: first.sourceUrl, medium: 'manga' });
  assert.equal(again.medium, 'anime', 'un ré-ajout a réécrit un média corrigé à la main');
});

test('le cœur refuse une valeur qu’il ne connaît pas plutôt que de la stocker', async () => {
  const { core } = bootCore({ storage: {} });
  const made = await core.addToLibrary({ ...entryFixture(), medium: 'donghua' });
  assert.equal(made.medium, 'manga', 'une valeur inconnue doit se replier, pas voyager');
});

test('le média monte au serveur avec l’entrée', async () => {
  const sent = [];
  const { core } = bootCore({
    storage: { authToken: 't' },
    fetch: async (url, init) => {
      if (String(url).endsWith('/api/library') && init?.method === 'POST') {
        sent.push(JSON.parse(init.body));
        return json({ id: 'remote-1', ...JSON.parse(init.body) }, 201);
      }
      return json([], 200);
    },
  });
  await core.addToLibrary({ ...entryFixture(), medium: 'novel' });
  await core.syncAll();
  assert.ok(sent.length, 'rien n’a été poussé');
  assert.equal(sent[0].medium, 'novel');
});

test('le schéma partagé connaît le champ et toutes ses valeurs', async () => {
  const { readFileSync } = await import('node:fs');
  const schema = JSON.parse(readFileSync(
    new URL('../../shared/schemas/library-entry.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.properties.medium.enum, MEDIA,
    'le schéma et le cœur ont divergé sur ce qu’un média peut être');
});

test('la colonne arrive par migration, pas par recréation de table', async () => {
  // Une table recréée est une table dont les lignes sont copiées à la main, et
  // c'est ainsi qu'on perd une colonne que personne ne regardait ce jour-là.
  const { readFileSync } = await import('node:fs');
  const db = readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
  assert.match(db, /medium: "TEXT NOT NULL DEFAULT 'manga'"/,
    'le média doit être déclaré parmi les colonnes ajoutées par migrate()');
  assert.doesNotMatch(db, /DROP TABLE library|CREATE TABLE library_new/);
});
