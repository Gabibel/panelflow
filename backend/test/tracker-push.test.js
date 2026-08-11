// Pushing progress out to AniList / MyAnimeList.
//
// This is the one feature in PanelFlow that writes to something the user owns
// somewhere else, so the tests are mostly about restraint: a link is never
// guessed, a chapter count never moves backwards, and a tracker being down
// never costs the user their bookmark. The rest pins the two API dialects —
// AniList reporting failure inside an HTTP 200, MAL refusing a JSON body —
// because both look like success to code that does not know about them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, addEntry, newUser, shutdown, base } from '../test-support/harness.js';
import { db } from '../src/db.js';
import { pickMatch } from '../src/tracker-push.js';

after(() => { globalThis.fetch = realFetch; shutdown(); });

// The harness talks to the app over the loopback socket with the same global
// fetch the tracker client uses, so the stub has to let its own traffic past.
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

/** One AniList media hit, in the shape the GraphQL query asks for. */
const media = (id, romaji, over = {}) => ({
  id,
  synonyms: [],
  title: { romaji, english: null, native: null },
  ...over,
});

/**
 * Stand in for AniList. Both the search and the mutation go to the same
 * endpoint, told apart by the operation in the body — which is also how a
 * caller that sent the wrong one would be caught here.
 */
function anilist({ hits = [], onSave = () => ({ data: { SaveMediaListEntry: { id: 1 } } }) } = {}) {
  const calls = { search: [], save: [] };
  outbound = async (url, init) => {
    assert.equal(url, 'https://graphql.anilist.co');
    assert.equal(init.headers.Authorization, 'Bearer tok');
    const { query, variables } = JSON.parse(init.body);
    if (query.includes('SaveMediaListEntry')) {
      calls.save.push(variables);
      return json(onSave(variables));
    }
    calls.search.push(variables.q);
    return json({ data: { Page: { media: hits } } });
  };
  return calls;
}

const connect = (userId, service, token = 'tok') =>
  db.prepare('INSERT INTO trackers (user_id, service, access_token) VALUES (?, ?, ?)')
    .run(userId, service, token);

const linkRow = (userId, libraryId, service) => db.prepare(
  'SELECT * FROM tracker_links WHERE user_id = ? AND library_id = ? AND service = ?',
).get(userId, libraryId, service);

const read = (token, libraryId, label) => api('PUT', `/api/progress/${libraryId}`, {
  chapterUrl: `https://example-manga-site.test/c/${encodeURIComponent(label)}`,
  chapterLabel: label,
}, token);

// --- who is this? -----------------------------------------------------------

test('an identical title once normalised is a match', () => {
  const { match, score } = pickMatch(
    [{ id: '30002', title: 'Ao no Hako (VF)' }],
    'Ao no Hako',
  );
  assert.equal(match.id, '30002');
  assert.equal(score, 1);
});

test('an alternative title matches as readily as the main one', () => {
  const { match } = pickMatch(
    [{ id: '30002', title: 'Ao no Hako', altTitles: ['Blue Box'] }],
    'Blue Box',
  );
  assert.equal(match.id, '30002');
});

test('a different work is never linked, but is still remembered as the guess', () => {
  const { match, best, score } = pickMatch(
    [{ id: '1', title: 'Blue Lock' }, { id: '2', title: 'Solo Leveling' }],
    'Ao no Hako',
  );
  assert.equal(match, null, 'a guess must not become a link');
  assert.ok(score < 0.9);
  assert.ok(best, 'the closest thing seen is what a "did you mean?" is made of');
});

test('nothing to choose from is not a match', () => {
  assert.deepEqual(pickMatch([], 'Ao no Hako'), { match: null, best: null, score: 0 });
});

// --- the push itself --------------------------------------------------------

test('reading a chapter tells the connected tracker how far', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  const calls = anilist({ hits: [media(30002, 'Ao no Hako')] });

  const r = await read(u.token, e.id, 'Chapitre 109 VF');

  assert.equal(r.status, 200);
  assert.deepEqual(calls.save, [{ id: 30002, p: 109 }]);
  assert.deepEqual(r.body.trackers, [
    { service: 'anilist', libraryId: e.id, ok: true, chapter: 109, remoteId: '30002' },
  ]);
  const link = await linkRow(u.id, e.id, 'anilist');
  assert.equal(link.state, 'linked');
  assert.equal(link.last_chapter, 109);
});

test('the title is resolved once, not on every page turn', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  const calls = anilist({ hits: [media(30002, 'Ao no Hako')] });

  await read(u.token, e.id, 'Chapitre 109');
  await read(u.token, e.id, 'Chapitre 110');
  await read(u.token, e.id, 'Chapitre 111');

  assert.equal(calls.search.length, 1, 'one search for three chapters');
  assert.equal(calls.save.length, 3);
});

test('the same chapter saved again is not sent again', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  const calls = anilist({ hits: [media(30002, 'Ao no Hako')] });

  await read(u.token, e.id, 'Chapitre 109');
  const again = await read(u.token, e.id, 'Chapitre 109');

  assert.equal(calls.save.length, 1);
  assert.equal(again.body.trackers[0].skipped, 'not-further');
});

test('rereading an old chapter never walks the tracker backwards', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  const calls = anilist({ hits: [media(30002, 'Ao no Hako')] });

  await read(u.token, e.id, 'Chapitre 109');
  await read(u.token, e.id, 'Chapitre 3');

  assert.deepEqual(calls.save, [{ id: 30002, p: 109 }]);
  assert.equal((await linkRow(u.id, e.id, 'anilist')).last_chapter, 109);
});

test('a chapter with no number in its label is not pushed at all', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  const calls = anilist({ hits: [media(30002, 'Ao no Hako')] });

  const r = await read(u.token, e.id, 'Oneshot');

  assert.equal(r.status, 200);
  assert.equal(calls.search.length + calls.save.length, 0);
});

test('an unmatched title is recorded once and never searched again', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  const calls = anilist({ hits: [media(1, 'Blue Lock')] });

  const r = await read(u.token, e.id, 'Chapitre 109');
  await read(u.token, e.id, 'Chapitre 110');

  assert.equal(calls.search.length, 1);
  assert.equal(calls.save.length, 0);
  assert.equal(r.body.trackers[0].skipped, 'unmatched');
  const link = await linkRow(u.id, e.id, 'anilist');
  assert.equal(link.remote_id, null);
  assert.equal(link.remote_title, 'Blue Lock', 'the near miss is kept to offer back');
});

test('no tracker connected costs no outbound request', async () => {
  const u = await newUser();
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  outbound = null; // any outbound call now throws

  const r = await read(u.token, e.id, 'Chapitre 109');

  assert.equal(r.status, 200);
  assert.equal(r.body.chapterLabel, 'Chapitre 109');
  assert.equal(r.body.trackers, undefined);
});

// --- when the tracker misbehaves -------------------------------------------

test('a tracker that is down does not cost the user their bookmark', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  outbound = async () => { throw new Error('network down'); };

  const r = await read(u.token, e.id, 'Chapitre 109');

  assert.equal(r.status, 200);
  assert.equal(r.body.chapterLabel, 'Chapitre 109');
  assert.equal(r.body.trackers[0].ok, false);
  assert.match(r.body.trackers[0].error, /network down/);
  assert.equal(await linkRow(u.id, e.id, 'anilist'), undefined, 'nothing was concluded');
});

test('AniList reporting failure inside an HTTP 200 is a failure', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  anilist({
    hits: [media(30002, 'Ao no Hako')],
    onSave: () => ({ errors: [{ message: 'Invalid token' }] }),
  });

  const r = await read(u.token, e.id, 'Chapitre 109');

  assert.equal(r.body.trackers[0].ok, false);
  assert.match(r.body.trackers[0].error, /Invalid token/);
  assert.equal((await linkRow(u.id, e.id, 'anilist')).last_chapter, null,
    'a push that failed must be retried, not recorded as sent');
});

// --- MyAnimeList ------------------------------------------------------------

test('MAL is searched over REST and updated form-encoded, in whole chapters', async () => {
  const u = await newUser();
  await connect(u.id, 'mal');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  const seen = [];
  outbound = async (url, init) => {
    seen.push({ url, init });
    if (url.startsWith('https://api.myanimelist.net/v2/manga?')) {
      return json({ data: [{ node: { id: 118230, title: 'Ao no Hako', alternative_titles: { en: 'Blue Box', synonyms: [] } } }] });
    }
    return json({ num_chapters_read: 109 });
  };

  await read(u.token, e.id, 'Chapitre 109.5 VF');

  const [search, push] = seen;
  assert.equal(new URL(search.url).searchParams.get('q'), 'Ao no Hako');
  assert.equal(search.init.headers.Authorization, 'Bearer tok');
  assert.equal(push.url, 'https://api.myanimelist.net/v2/manga/118230/my_list_status');
  assert.equal(push.init.method, 'PATCH');
  assert.equal(push.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  // MAL counts chapters, and 109.5 is not one of them.
  assert.equal(new URLSearchParams(push.init.body).get('num_chapters_read'), '109');
});

test('kitsu has no token to push with, and says so instead of failing quietly', async () => {
  const u = await newUser();
  await connect(u.id, 'kitsu');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  outbound = null;

  const r = await read(u.token, e.id, 'Chapitre 109');
  assert.equal(r.status, 200);
  assert.equal(r.body.trackers, undefined);

  const push = await api('POST', '/api/trackers/kitsu/push', {}, u.token);
  assert.equal(push.status, 501);
});

// --- the routes around it ---------------------------------------------------

test('the links are listable, with the series they belong to', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  anilist({ hits: [media(30002, 'Ao no Hako')] });
  await read(u.token, e.id, 'Chapitre 109');

  const r = await api('GET', '/api/trackers/links', undefined, u.token);

  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [{
    libraryId: e.id,
    service: 'anilist',
    remoteId: '30002',
    remoteTitle: 'Ao no Hako',
    state: 'linked',
    lastChapter: 109,
    updatedAt: r.body[0].updatedAt,
    title: 'Ao no Hako',
  }]);
});

test('the user can link by hand what the matcher would not guess', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  const calls = anilist({ hits: [media(1, 'Blue Lock')] });
  await read(u.token, e.id, 'Chapitre 109');
  assert.equal(calls.save.length, 0);

  const put = await api('PUT', `/api/trackers/anilist/link/${e.id}`,
    { remoteId: '30002', remoteTitle: 'Ao no Hako' }, u.token);
  assert.equal(put.status, 200);
  assert.equal(put.body.state, 'linked');

  await read(u.token, e.id, 'Chapitre 110');
  assert.deepEqual(calls.save, [{ id: 30002, p: 110 }]);
});

test('a muted series stays off the tracker without disconnecting the account', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  const calls = anilist({ hits: [media(30002, 'Ao no Hako')] });

  const put = await api('PUT', `/api/trackers/anilist/link/${e.id}`, { state: 'muted' }, u.token);
  assert.equal(put.body.state, 'muted');
  const r = await read(u.token, e.id, 'Chapitre 109');

  assert.equal(calls.save.length, 0);
  assert.equal(calls.search.length, 0, 'a mute is an answer, so nothing is looked up');
  assert.equal(r.body.trackers[0].skipped, 'muted');
});

test('linking without an id, or to a state that is not one, is refused', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });

  assert.equal((await api('PUT', `/api/trackers/anilist/link/${e.id}`,
    { state: 'linked' }, u.token)).status, 400);
  assert.equal((await api('PUT', `/api/trackers/anilist/link/${e.id}`,
    { state: 'whatever' }, u.token)).status, 400);
  assert.equal((await api('PUT', '/api/trackers/anilist/link/nope',
    { remoteId: '1' }, u.token)).status, 404);
});

test('forgetting a link makes the next chapter resolve it again', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  const calls = anilist({ hits: [media(30002, 'Ao no Hako')] });
  await read(u.token, e.id, 'Chapitre 109');

  const del = await api('DELETE', `/api/trackers/anilist/link/${e.id}`, undefined, u.token);
  assert.equal(del.status, 204);
  assert.equal((await api('DELETE', `/api/trackers/anilist/link/${e.id}`, undefined, u.token)).status, 404);

  await read(u.token, e.id, 'Chapitre 110');
  assert.equal(calls.search.length, 2);
});

test('the catalogue can be searched to fix a bad match', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  anilist({ hits: [media(30002, 'Ao no Hako', { synonyms: ['Blue Box'] })] });

  const r = await api('GET', '/api/trackers/anilist/search?q=ao%20no%20hako', undefined, u.token);

  assert.equal(r.status, 200);
  assert.deepEqual(r.body, [{ id: '30002', title: 'Ao no Hako', altTitles: ['Blue Box'] }]);
  assert.equal((await api('GET', '/api/trackers/anilist/search?q=a', undefined, u.token)).status, 400);
});

test('a service nobody connected answers 404, not a crash', async () => {
  const u = await newUser();
  assert.equal((await api('GET', '/api/trackers/anilist/search?q=abc', undefined, u.token)).status, 404);
  assert.equal((await api('POST', '/api/trackers/anilist/push', {}, u.token)).status, 404);
  assert.equal((await api('GET', '/api/trackers/nope/search?q=abc', undefined, u.token)).status, 404);
});

test('a backfill pushes everything that has a bookmark', async () => {
  const u = await newUser();
  const a = await addEntry(u.token, { title: 'Ao no Hako' });
  const b = await addEntry(u.token, { title: 'Blue Lock' });
  outbound = null;
  await read(u.token, a.id, 'Chapitre 109');
  await read(u.token, b.id, 'Chapitre 250');

  await connect(u.id, 'anilist');
  const calls = anilist({ hits: [media(30002, 'Ao no Hako'), media(1, 'Blue Lock')] });
  const r = await api('POST', '/api/trackers/anilist/push', {}, u.token);

  assert.equal(r.status, 200);
  assert.equal(r.body.pushed, 2);
  assert.equal(r.body.failed, 0);
  assert.deepEqual(calls.save.map((v) => v.p).sort((x, y) => x - y), [109, 250]);
});

test('disconnecting takes the links with it', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  anilist({ hits: [media(30002, 'Ao no Hako')] });
  await read(u.token, e.id, 'Chapitre 109');
  assert.ok(await linkRow(u.id, e.id, 'anilist'));

  const del = await api('DELETE', '/api/trackers/anilist', undefined, u.token);

  assert.equal(del.status, 204);
  assert.equal(await linkRow(u.id, e.id, 'anilist'), undefined,
    'reconnecting must not silently resume pushing to a months-old match');
});

test('one account cannot see or touch another account links', async () => {
  const u = await newUser();
  const other = await newUser();
  await connect(u.id, 'anilist');
  await connect(other.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  anilist({ hits: [media(30002, 'Ao no Hako')] });
  await read(u.token, e.id, 'Chapitre 109');

  assert.deepEqual((await api('GET', '/api/trackers/links', undefined, other.token)).body, []);
  assert.equal((await api('PUT', `/api/trackers/anilist/link/${e.id}`,
    { remoteId: '999' }, other.token)).status, 404);
  assert.equal((await linkRow(u.id, e.id, 'anilist')).remote_id, '30002');
});
