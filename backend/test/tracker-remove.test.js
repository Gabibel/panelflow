// "Remove it from AniList too", from the question asked when a series leaves
// the library.
//
// The one tracker write that takes something away, so what is tested first is
// what it must not take: a series the catalogue is not sure about, a guess, an
// entry of another account. Then that it does take the right one, from both
// services and from both halves of MAL.
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

function anilist({ hits = [], listEntry = null } = {}) {
  const calls = { search: [], lookup: [], deleted: [] };
  outbound = async (url, init) => {
    assert.equal(url, 'https://graphql.anilist.co');
    const { query, variables } = JSON.parse(init.body);
    if (query.includes('DeleteMediaListEntry')) {
      calls.deleted.push(variables.id);
      return json({ data: { DeleteMediaListEntry: { deleted: true } } });
    }
    if (query.includes('Media(id:')) {
      calls.lookup.push(variables.id);
      return json({ data: { Media: { mediaListEntry: listEntry } } });
    }
    calls.search.push(variables);
    return json({ data: { Page: { media: hits } } });
  };
  return calls;
}

const connect = (userId, service) =>
  db.prepare('INSERT INTO trackers (user_id, service, access_token) VALUES (?, ?, ?)')
    .run(userId, service, 'tok');

const link = (userId, libraryId, service, remoteId, state = 'linked') => db.prepare(`
  INSERT INTO tracker_links (user_id, library_id, service, remote_id, remote_title, state)
  VALUES (?, ?, ?, ?, 'Ao no Hako', ?)`).run(userId, libraryId, service, remoteId, state);

const linkRow = (userId, libraryId, service) => db.prepare(
  'SELECT * FROM tracker_links WHERE user_id = ? AND library_id = ? AND service = ?',
).get(userId, libraryId, service);

const remove = (token, service, libraryId) =>
  api('DELETE', `/api/trackers/${service}/entry/${libraryId}`, undefined, token);

test('a linked series is taken off the AniList list, by its list entry, and the link goes too', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  await link(u.id, e.id, 'anilist', '30002');
  const calls = anilist({ listEntry: { id: 987 } });

  const r = await remove(u.token, 'anilist', e.id);

  assert.equal(r.status, 200);
  assert.equal(r.body.removed, true);
  assert.deepEqual(calls.lookup, [30002]);
  assert.deepEqual(calls.deleted, [987], 'the list entry’s id, not the media’s');
  assert.equal(calls.search.length, 0, 'a link is the answer; nothing is searched');
  assert.equal(await linkRow(u.id, e.id, 'anilist'), undefined);
});

test('a series already removed from the library can still be taken off, right after', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  await link(u.id, e.id, 'anilist', '30002');
  await api('DELETE', `/api/library/${e.id}`, undefined, u.token);
  const calls = anilist({ listEntry: { id: 987 } });

  const r = await remove(u.token, 'anilist', e.id);

  assert.equal(r.body.removed, true);
  assert.deepEqual(calls.deleted, [987]);
});

test('with no link, only the reader’s own entry for a title the catalogue is sure of is removed', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  const calls = anilist({
    hits: [media(30002, 'Ao no Hako', { mediaListEntry: { status: 'CURRENT', progress: 12 } })],
    listEntry: { id: 555 },
  });

  const r = await remove(u.token, 'anilist', e.id);

  assert.equal(r.body.removed, true);
  assert.equal(r.body.remoteTitle, 'Ao no Hako');
  assert.deepEqual(calls.deleted, [555]);
});

test('a guess is never removed, and neither is a series they do not have', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Le Mari de ma soeur' });
  // Two hits, neither of them the title: not sure, so nothing is touched.
  let calls = anilist({
    hits: [media(1, 'Blue Lock', { mediaListEntry: { status: 'CURRENT', progress: 3 } }),
      media(2, 'Otouto no Otto', { mediaListEntry: { status: 'CURRENT', progress: 3 } })],
  });
  let r = await remove(u.token, 'anilist', e.id);
  assert.equal(r.body.removed, false);
  assert.equal(calls.deleted.length, 0, 'a guess would have deleted a stranger’s series');

  // Linked, but not on their list: there is nothing over there to delete.
  const other = await addEntry(u.token, { title: 'Ao no Hako' });
  await link(u.id, other.id, 'anilist', '30002');
  calls = anilist({ listEntry: null });
  r = await remove(u.token, 'anilist', other.id);
  assert.equal(r.body.removed, false);
  assert.equal(calls.deleted.length, 0);
});

test('MAL deletes from the list the series belongs to, and a 404 there is "was not on it"', async () => {
  const u = await newUser();
  await connect(u.id, 'mal');
  const anime = await addEntry(u.token, { title: 'Cyberpunk: Edgerunners', medium: 'anime' });
  await link(u.id, anime.id, 'mal', '42310');
  const seen = [];
  outbound = async (url, init) => {
    seen.push({ url, method: init?.method });
    return json({});
  };
  let r = await remove(u.token, 'mal', anime.id);
  assert.equal(r.body.removed, true);
  assert.deepEqual(seen, [{ url: 'https://api.myanimelist.net/v2/anime/42310/my_list_status', method: 'DELETE' }]);

  const manga = await addEntry(u.token, { title: 'Ao no Hako' });
  await link(u.id, manga.id, 'mal', '7');
  seen.length = 0;
  outbound = async (url, init) => { seen.push({ url, method: init?.method }); return json({ error: 'not_found' }, 404); };
  r = await remove(u.token, 'mal', manga.id);
  assert.equal(r.status, 200);
  assert.equal(r.body.removed, false);
  assert.equal(seen[0].url, 'https://api.myanimelist.net/v2/manga/7/my_list_status');
});

test('removing needs a connection, and a series of the account', async () => {
  const u = await newUser();
  const other = await newUser();
  const e = await addEntry(other.token, { title: 'Ao no Hako' });
  assert.equal((await remove(u.token, 'anilist', e.id)).status, 404, 'not connected');
  await connect(u.id, 'anilist');
  const calls = anilist({ listEntry: { id: 1 } });
  assert.equal((await remove(u.token, 'anilist', e.id)).status, 404, 'another account’s series');
  assert.equal(calls.deleted.length, 0);
});

test('a tracker that fails to answer is a 502, and the link is kept for another try', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  await link(u.id, e.id, 'anilist', '30002');
  outbound = async () => json({ errors: [{ message: 'Too Many Requests' }] }, 429);
  const r = await remove(u.token, 'anilist', e.id);
  assert.equal(r.status, 502);
  assert.ok(await linkRow(u.id, e.id, 'anilist'));
});
