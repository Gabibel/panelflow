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

after(async () => { globalThis.fetch = realFetch; await shutdown(); });

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
function anilist({
  hits = [], entry, list = [],
  onSave = () => ({ data: { SaveMediaListEntry: { id: 1 } } }),
} = {}) {
  // `promote` is the half of a save that is not in the variables: the shelf is
  // named by choosing a different mutation document, so which one was sent is
  // the only evidence that a series was moved to Reading — or left alone.
  const calls = { search: [], save: [], promote: [], entry: [], list: [] };
  outbound = async (url, init) => {
    assert.equal(url, 'https://graphql.anilist.co');
    assert.equal(init.headers.Authorization, 'Bearer tok');
    const { query, variables } = JSON.parse(init.body);
    if (query.includes('SaveMediaListEntry')) {
      calls.save.push(variables);
      calls.promote.push(query.includes('status: CURRENT'));
      return json(onSave(variables));
    }
    if (query.includes('Media(id:')) {
      calls.entry.push(variables.id);
      return json({ data: { Media: { mediaListEntry: entry ?? null } } });
    }
    if (query.includes('Viewer')) return json({ data: { Viewer: { id: 7 } } });
    if (query.includes('MediaListCollection')) {
      calls.list.push(variables.user);
      return json({ data: { MediaListCollection: { lists: [{ entries: list }] } } });
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
    {
      service: 'anilist', libraryId: e.id, ok: true, chapter: 109, remoteId: '30002',
      // The search said AniList has no entry for it, so PanelFlow is creating
      // one, and a series being read belongs on Reading rather than nowhere.
      promoted: true,
    },
  ]);
  const link = await linkRow(u.id, e.id, 'anilist');
  assert.equal(link.state, 'linked');
  assert.equal(link.last_chapter, 109);
  assert.equal(link.remote_status, 'reading');
});

// --- the shelf, which is the reader's and not ours --------------------------

test('a series the reader finished is not dragged back to Reading', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  const calls = anilist({
    hits: [media(30002, 'Ao no Hako', {
      mediaListEntry: { status: 'COMPLETED', progress: 50 },
    })],
  });

  const r = await read(u.token, e.id, 'Chapitre 109');

  assert.deepEqual(calls.save, [{ id: 30002, p: 109 }]);
  assert.deepEqual(calls.promote, [false], 'progress yes, shelf no');
  assert.equal(r.body.trackers[0].promoted, undefined);
  assert.equal((await linkRow(u.id, e.id, 'anilist')).remote_status, 'completed');
});

test('a series waiting on the plan-to-read shelf is moved to Reading', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  const calls = anilist({
    hits: [media(30002, 'Ao no Hako', {
      mediaListEntry: { status: 'PLANNING', progress: 0 },
    })],
  });

  const r = await read(u.token, e.id, 'Chapitre 1');

  assert.deepEqual(calls.promote, [true]);
  assert.equal(r.body.trackers[0].promoted, true);
  assert.equal((await linkRow(u.id, e.id, 'anilist')).remote_status, 'reading');
});

test('what the tracker already counted is never overwritten by our bookmark', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  // 120 chapters read on AniList; the reader opens chapter 5 here. Without the
  // count coming back from the search, the first page turn would report 5.
  const calls = anilist({
    hits: [media(30002, 'Ao no Hako', {
      mediaListEntry: { status: 'CURRENT', progress: 120 },
    })],
  });

  const r = await read(u.token, e.id, 'Chapitre 5');

  assert.equal(calls.save.length, 0);
  assert.equal(r.body.trackers[0].skipped, 'not-further');
  assert.equal((await linkRow(u.id, e.id, 'anilist')).last_chapter, 120);
});

test('a link made by hand asks the tracker before writing over it', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  // The manual link carries a remote id and nothing else — no count, no shelf —
  // so the first push has to ask rather than assume the entry is empty.
  const calls = anilist({ entry: { status: 'COMPLETED', progress: 200 } });
  await api('PUT', `/api/trackers/anilist/link/${e.id}`,
    { remoteId: '30002', remoteTitle: 'Ao no Hako' }, u.token);

  await read(u.token, e.id, 'Chapitre 5');

  assert.deepEqual(calls.entry, [30002]);
  assert.equal(calls.save.length, 0, '200 chapters are not replaced by 5');
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

// --- so that a dead connection stops looking like a live one ----------------

test('a refused push is left on the connection for the account screen to show', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  anilist({
    hits: [media(30002, 'Ao no Hako')],
    onSave: () => ({ errors: [{ message: 'Invalid token' }] }),
  });

  await read(u.token, e.id, 'Chapitre 109');

  const r = await api('GET', '/api/trackers', undefined, u.token);
  assert.match(r.body[0].lastError, /Invalid token/);
  assert.ok(r.body[0].lastErrorAt);
  assert.equal(r.body[0].lastPushAt, null);
});

test('a connection that starts working again stops saying it is broken', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  let broken = true;
  anilist({
    hits: [media(30002, 'Ao no Hako')],
    onSave: () => (broken ? { errors: [{ message: 'Invalid token' }] } : { data: { SaveMediaListEntry: { id: 1 } } }),
  });

  await read(u.token, e.id, 'Chapitre 109');
  broken = false;
  await read(u.token, e.id, 'Chapitre 110');

  const r = await api('GET', '/api/trackers', undefined, u.token);
  assert.equal(r.body[0].lastError, null);
  assert.ok(r.body[0].lastPushAt, 'and says when it last reached the service');
});

test('the same refusal keeps the date it first happened', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  anilist({
    hits: [media(30002, 'Ao no Hako')],
    onSave: () => ({ errors: [{ message: 'Invalid token' }] }),
  });

  await read(u.token, e.id, 'Chapitre 109');
  const first = (await api('GET', '/api/trackers', undefined, u.token)).body[0].lastErrorAt;
  await read(u.token, e.id, 'Chapitre 110');

  const later = (await api('GET', '/api/trackers', undefined, u.token)).body[0].lastErrorAt;
  assert.equal(later, first,
    '"it stopped working in March" must not become "a moment ago" every time you read');
});

test('a chapter already sent is neither a success nor a failure', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  anilist({ hits: [media(30002, 'Ao no Hako')] });

  await read(u.token, e.id, 'Chapitre 109');
  const before = (await api('GET', '/api/trackers', undefined, u.token)).body[0].lastPushAt;
  await read(u.token, e.id, 'Chapitre 109');

  const after = (await api('GET', '/api/trackers', undefined, u.token)).body[0].lastPushAt;
  assert.equal(after, before, 'nothing was sent, so nothing new was proved');
});

// --- the other direction ----------------------------------------------------

test('a pull brings the tracker own count back without touching the bookmark', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  anilist({ hits: [media(30002, 'Ao no Hako')] });
  await read(u.token, e.id, 'Chapitre 109');

  // Meanwhile the reader gets to 130 somewhere that is not PanelFlow.
  anilist({ list: [{ mediaId: 30002, status: 'CURRENT', progress: 130 }] });
  const r = await api('POST', '/api/trackers/anilist/pull', {}, u.token);

  assert.equal(r.status, 200);
  assert.equal(r.body.updated, 1);
  assert.deepEqual(r.body.ahead, [{ libraryId: e.id, title: 'Ao no Hako', here: 109, there: 130 }]);
  assert.equal((await linkRow(u.id, e.id, 'anilist')).last_chapter, 130);

  // The bookmark is a URL on a scan site; a chapter count cannot become one.
  const progress = await api('GET', '/api/progress', undefined, u.token);
  assert.equal(progress.body.find((p) => p.libraryId === e.id).chapterLabel, 'Chapitre 109');
});

test('what a pull learned stops the next page turn from undoing it', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  const e = await addEntry(u.token, { title: 'Ao no Hako' });
  anilist({ hits: [media(30002, 'Ao no Hako')] });
  await read(u.token, e.id, 'Chapitre 109');

  anilist({ list: [{ mediaId: 30002, status: 'COMPLETED', progress: 130 }] });
  await api('POST', '/api/trackers/anilist/pull', {}, u.token);

  const calls = anilist({ hits: [media(30002, 'Ao no Hako')] });
  await read(u.token, e.id, 'Chapitre 110');

  assert.equal(calls.save.length, 0, '110 is behind the 130 the tracker reported');
  assert.equal((await linkRow(u.id, e.id, 'anilist')).remote_status, 'completed');
});

test('pulling from a service nobody connected is a 404, not an empty success', async () => {
  const u = await newUser();
  assert.equal((await api('POST', '/api/trackers/anilist/pull', {}, u.token)).status, 404);
  await connect(u.id, 'kitsu');
  assert.equal((await api('POST', '/api/trackers/kitsu/pull', {}, u.token)).status, 501);
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
    remoteStatus: 'reading',
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
