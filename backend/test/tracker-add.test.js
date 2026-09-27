// "Add to AniList" from a series' sheet, and the anime half of the catalogues.
//
// Two things the sheet could not do before: add a series that has no bookmark
// yet ("no chapter to send"), and add an anime at all — the search only ever
// looked among manga, where "Cyberpunk: Edgerunners" is the manga adaptation,
// a different work counted in chapters. The rules the page-turn push keeps are
// kept here too: a guess is never taken, and what the reader already has on
// the tracker is never rewritten.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, addEntry, newUser, shutdown, base } from '../test-support/harness.js';
import { db } from '../src/db.js';

after(async () => { globalThis.fetch = realFetch; await shutdown(); });

const realFetch = globalThis.fetch;
let outbound = null;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (url.startsWith(base)) return realFetch(input, init);
  if (!outbound) throw new Error(`unexpected outbound fetch: ${url}`);
  return outbound(url, init);
};

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
});

const media = (id, romaji, over = {}) => ({
  id, synonyms: [], title: { romaji, english: null, native: null }, ...over,
});

function anilist({ hits = [], entry = null, list = [] } = {}) {
  const calls = { search: [], save: [], entry: [], list: [] };
  outbound = async (url, init) => {
    assert.equal(url, 'https://graphql.anilist.co');
    const { query, variables } = JSON.parse(init.body);
    if (query.includes('SaveMediaListEntry')) {
      calls.save.push(variables);
      return json({ data: { SaveMediaListEntry: { id: 1 } } });
    }
    if (query.includes('Media(id:')) {
      calls.entry.push(variables.id);
      return json({ data: { Media: { mediaListEntry: entry } } });
    }
    if (query.includes('Viewer')) return json({ data: { Viewer: { id: 7 } } });
    if (query.includes('MediaListCollection')) {
      calls.list.push(variables.type);
      return json({ data: { MediaListCollection: { lists: [{ entries: list }] } } });
    }
    calls.search.push(variables);
    return json({ data: { Page: { media: hits } } });
  };
  return calls;
}

const connect = (userId, service) =>
  db.prepare('INSERT INTO trackers (user_id, service, access_token) VALUES (?, ?, ?)')
    .run(userId, service, 'tok');

const linkRow = (userId, libraryId, service) => db.prepare(
  'SELECT * FROM tracker_links WHERE user_id = ? AND library_id = ? AND service = ?',
).get(userId, libraryId, service);

const add = (token, service, libraryId, body = {}) =>
  api('POST', `/api/trackers/${service}/add/${libraryId}`, body, token);

test('a series with no bookmark is added on the shelf it is on here, at zero', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako', folder: 'plan' });
  const calls = anilist({ hits: [media(30002, 'Ao no Hako')] });

  const r = await add(u.token, 'anilist', e.id);

  assert.equal(r.status, 200);
  assert.equal(r.body.added, true);
  assert.equal(calls.search[0].type, 'MANGA');
  assert.deepEqual(calls.save, [{ id: 30002, p: 0, s: 'PLANNING' }]);
  const link = await linkRow(u.id, e.id, 'anilist');
  assert.equal(link.state, 'linked');
  assert.equal(link.remote_status, 'plan');
  assert.equal(link.last_chapter, 0);
});

test('an anime is looked for among anime, and its episode is the count', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Cyberpunk: Edgerunners', medium: 'anime' });
  // The bookmark first, with nothing to find: the page turn settles on "no
  // match", which is exactly the state a reader then presses "add" from.
  anilist({ hits: [] });
  await api('PUT', `/api/progress/${e.id}`, {
    chapterUrl: 'https://example-manga-site.test/cyberpunk/episode-3', chapterLabel: 'Episode 3',
  }, u.token);
  const calls = anilist({ hits: [media(120377, 'Cyberpunk: Edgerunners')] });

  const r = await add(u.token, 'anilist', e.id);

  assert.equal(r.body.added, true);
  assert.equal(calls.search.at(-1).type, 'ANIME', 'the manga adaptation is another work');
  assert.deepEqual(calls.save.at(-1), { id: 120377, p: 3, s: 'CURRENT' });
  assert.equal(r.body.count, 3);
});

test('a series the reader already has over there is linked, never rewritten', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako', folder: 'plan' });
  const calls = anilist({
    hits: [media(30002, 'Ao no Hako', { mediaListEntry: { status: 'COMPLETED', progress: 180 } })],
  });

  const r = await add(u.token, 'anilist', e.id);

  assert.equal(r.body.already, true);
  assert.equal(r.body.folder, 'completed');
  assert.equal(r.body.count, 180);
  assert.equal(calls.save.length, 0, 'their shelf and count are theirs');
  assert.equal((await linkRow(u.id, e.id, 'anilist')).last_chapter, 180);
});

test('a title the catalogue is not sure about comes back with its guesses, and the pick is added', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Le Mari de ma soeur' });
  let calls = anilist({ hits: [media(1, 'Blue Lock'), media(2, 'Otouto no Otto')] });

  const first = await add(u.token, 'anilist', e.id);
  assert.equal(first.body.ok, false);
  assert.equal(first.body.skipped, 'unmatched');
  assert.deepEqual(first.body.hits.map((h) => h.id), ['1', '2']);
  assert.equal(calls.save.length, 0, 'a guess is never taken');
  assert.equal(first.body.hits[0].mine, undefined, 'the reader’s own rows stay on the server');

  calls = anilist({ entry: null });
  const second = await add(u.token, 'anilist', e.id, { remoteId: '2', remoteTitle: 'Otouto no Otto' });
  assert.equal(second.body.added, true);
  assert.deepEqual(calls.save, [{ id: 2, p: 0, s: 'CURRENT' }]);
  assert.equal((await linkRow(u.id, e.id, 'anilist')).remote_title, 'Otouto no Otto');
});

test('pressing add again asks again, even after a page turn settled on no match', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  await db.prepare(`INSERT INTO tracker_links (user_id, library_id, service, state)
    VALUES (?, ?, 'anilist', 'unmatched')`).run(u.id, e.id);
  const calls = anilist({ hits: [media(30002, 'Ao no Hako')] });

  const r = await add(u.token, 'anilist', e.id);

  assert.equal(r.body.added, true);
  assert.equal(calls.save.length, 1);
});

test('MAL keeps anime at its own endpoint, with its own words for the shelf and the count', async () => {
  const u = await newUser();
  await connect(u.id, 'mal');
  const e = await addEntry(u.token, { title: 'Cyberpunk: Edgerunners', medium: 'anime', folder: 'paused' });
  const seen = [];
  outbound = async (url, init) => {
    seen.push({ url, init });
    if (url.startsWith('https://api.myanimelist.net/v2/anime?')) {
      return json({ data: [{ node: { id: 42310, title: 'Cyberpunk: Edgerunners' } }] });
    }
    return json({});
  };

  const r = await add(u.token, 'mal', e.id);

  assert.equal(r.body.added, true);
  const [search, patch] = seen;
  assert.match(new URL(search.url).searchParams.get('fields'), /num_episodes_watched/);
  assert.equal(patch.url, 'https://api.myanimelist.net/v2/anime/42310/my_list_status');
  const body = new URLSearchParams(patch.init.body);
  assert.equal(body.get('status'), 'on_hold');
  assert.equal(body.get('num_watched_episodes'), '0');
});

test('an anime watched on the page turn is pushed as episodes to MAL', async () => {
  const u = await newUser();
  await connect(u.id, 'mal');
  const e = await addEntry(u.token, { title: 'Cyberpunk: Edgerunners', medium: 'anime' });
  const seen = [];
  outbound = async (url, init) => {
    seen.push({ url, init });
    if (url.startsWith('https://api.myanimelist.net/v2/anime?')) {
      return json({ data: [{ node: { id: 42310, title: 'Cyberpunk: Edgerunners' } }] });
    }
    return json({});
  };

  await api('PUT', `/api/progress/${e.id}`, {
    chapterUrl: 'https://example-manga-site.test/cyberpunk/episode-4', chapterLabel: 'Episode 4',
  }, u.token);

  const patch = seen.find((s) => s.init?.method === 'PATCH');
  assert.equal(patch.url, 'https://api.myanimelist.net/v2/anime/42310/my_list_status');
  const body = new URLSearchParams(patch.init.body);
  assert.equal(body.get('num_watched_episodes'), '4');
  assert.equal(body.get('status'), 'watching');
});

test('a pull reads the anime list too, and never mistakes an anime id for a manga one', async () => {
  const u = await newUser();
  await connect(u.id, 'mal');
  const anime = await addEntry(u.token, { title: 'Cyberpunk: Edgerunners', medium: 'anime' });
  await db.prepare(`INSERT INTO tracker_links (user_id, library_id, service, remote_id, state)
    VALUES (?, ?, 'mal', '7', 'linked')`).run(u.id, anime.id);
  outbound = async (url) => {
    if (url.includes('/users/@me/animelist')) {
      return json({ data: [{ node: { id: 7 }, list_status: { status: 'watching', num_episodes_watched: 6 } }] });
    }
    // Manga 7 is somebody else entirely, and further along.
    return json({ data: [{ node: { id: 7 }, list_status: { status: 'reading', num_chapters_read: 99 } }] });
  };

  const r = await api('POST', '/api/trackers/mal/pull', {}, u.token);

  assert.equal(r.status, 200);
  const link = await linkRow(u.id, anime.id, 'mal');
  assert.equal(link.last_chapter, 6);
  assert.equal(link.remote_status, 'reading');
});

test('adding needs a connection, and an entry of the account', async () => {
  const u = await newUser();
  const other = await newUser();
  const e = await addEntry(other.token, { title: 'Ao no Hako' });
  assert.equal((await add(u.token, 'anilist', e.id)).status, 404, 'not connected');
  await connect(u.id, 'anilist');
  anilist({ hits: [] });
  assert.equal((await add(u.token, 'anilist', e.id)).status, 404, 'another account’s series');
  assert.equal((await add(u.token, 'anilist', e.id, { remoteId: { $ne: 1 } })).status, 400);
});
