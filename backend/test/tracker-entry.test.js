// What the reader's own tracker already says about the series in front of them.
//
// This is the read half of the tracker feature, and it feeds a form the reader
// is about to save — so the tests are about not putting words in their mouth: a
// title that only nearly matches must not fill anything in, a service that is
// down must cost the prefill and nothing else, and "not on your list" must stay
// distinguishable from "you have connected nothing".
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, shutdown, base } from '../test-support/harness.js';
import { db } from '../src/db.js';
import { myEntry } from '../src/tracker-push.js';
import {
  clampScore, cleanDate, fromAniListEntry, fromMalStatus, malFolder,
} from '../src/tracker-fields.js';

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

const connect = (userId, service, token = 'tok') =>
  db.prepare('INSERT INTO trackers (user_id, service, access_token) VALUES (?, ?, ?)')
    .run(userId, service, token);

/** One AniList hit carrying the signed-in reader's own list row. */
const media = (id, romaji, mine) => ({
  id,
  synonyms: [],
  title: { romaji, english: null, native: null },
  mediaListEntry: mine ?? null,
});

const anilistOnly = (hits) => {
  outbound = async (url) => {
    assert.equal(url, 'https://graphql.anilist.co');
    return json({ data: { Page: { media: hits } } });
  };
};

const LIST_ROW = {
  status: 'CURRENT',
  progress: 880,
  score: 8,
  startedAt: { year: 2025, month: 3, day: 4 },
  completedAt: { year: null, month: null, day: null },
};

// --- the field mapping ------------------------------------------------------

test('an AniList list row becomes PanelFlow fields, and an empty one becomes nothing', () => {
  assert.deepEqual(fromAniListEntry(LIST_ROW), {
    folder: 'reading',
    chaptersRead: 880,
    score: 8,
    startDate: '2025-03-04',
    finishDate: null,
  });
  // Rereading is reading; a series in the catalogue that the reader has never
  // listed comes back with no status at all, and that is not an entry.
  assert.equal(fromAniListEntry({ ...LIST_ROW, status: 'REPEATING' }).folder, 'reading');
  assert.equal(fromAniListEntry({ progress: 12 }), null);
  assert.equal(fromAniListEntry(null), null);
});

test('a MAL status becomes the same fields, whichever spelling it arrives in', () => {
  assert.deepEqual(fromMalStatus({
    status: 'on_hold', num_chapters_read: 12, score: 0,
    start_date: '0000-00-00', finish_date: '2024-01-09',
  }), {
    folder: 'paused',
    chaptersRead: 12,
    // 0 is "not scored" on both services, and a form showing 0/10 would be
    // claiming the reader gave it the worst possible grade.
    score: null,
    // MAL writes an unset date as zeroes, which no client can render.
    startDate: null,
    finishDate: '2024-01-09',
  });
  assert.equal(malFolder('on-hold'), 'paused');
  assert.equal(malFolder('plan to read'), 'plan');
  assert.equal(fromMalStatus({ num_chapters_read: 3 }), null);
  assert.equal(clampScore(11), null);
  assert.equal(cleanDate('2024-01-09'), '2024-01-09');
});

// --- resolving one series ---------------------------------------------------

test('myEntry answers with the reader’s own row when the title is certainly the same', async () => {
  anilistOnly([media(30002, 'Ao no Hako', LIST_ROW)]);
  const entry = await myEntry('anilist', 'tok', 'Ao no Hako');
  assert.deepEqual(entry, {
    service: 'anilist',
    remoteId: '30002',
    remoteTitle: 'Ao no Hako',
    folder: 'reading',
    chaptersRead: 880,
    score: 8,
    startDate: '2025-03-04',
    finishDate: null,
  });
});

test('a title that merely resembles the page fills nothing in', async () => {
  // pickMatch keeps this as a "did you mean?", which is the right answer for a
  // search box and the wrong one for a form about to be saved: it would write
  // a stranger's score and start date onto someone else's series.
  anilistOnly([media(1, 'Blue Lock', LIST_ROW), media(2, 'Solo Leveling', LIST_ROW)]);
  assert.equal(await myEntry('anilist', 'tok', 'Ao no Hako'), null);
});

test('a series in the catalogue that the reader never listed is not an entry', async () => {
  anilistOnly([media(30002, 'Ao no Hako', null)]);
  assert.equal(await myEntry('anilist', 'tok', 'Ao no Hako'), null);
});

test('myEntry does not go looking for a service that cannot answer, or a title too short to search', async () => {
  outbound = null; // any outbound call from here fails the test
  assert.equal(await myEntry('kitsu', 'tok', 'Ao no Hako'), null);
  assert.equal(await myEntry('anilist', 'tok', 'A'), null);
  assert.equal(await myEntry('anilist', 'tok', '   '), null);
});

// --- the route the library sheet calls --------------------------------------

test('the sheet is told what AniList holds, and which title it matched', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  anilistOnly([media(30002, 'Ao no Hako', LIST_ROW)]);

  const r = await api('GET', '/api/trackers/entry?title=Ao%20no%20Hako', undefined, u.token);

  assert.equal(r.status, 200);
  assert.deepEqual(r.body.connected, ['anilist']);
  assert.equal(r.body.entries.length, 1);
  assert.equal(r.body.entries[0].service, 'anilist');
  assert.equal(r.body.entries[0].remoteTitle, 'Ao no Hako');
  assert.equal(r.body.entries[0].folder, 'reading');
  assert.equal(r.body.entries[0].chaptersRead, 880);
  assert.deepEqual(r.body.errors, []);
});

test('connected but not on the list is a different answer from nothing connected', async () => {
  const listed = await newUser();
  await connect(listed.id, 'anilist');
  anilistOnly([]);
  const found = await api('GET', '/api/trackers/entry?title=Ao%20no%20Hako', undefined, listed.token);
  assert.deepEqual(found.body.connected, ['anilist']);
  assert.deepEqual(found.body.entries, []);

  const bare = await newUser();
  outbound = null;
  const none = await api('GET', '/api/trackers/entry?title=Ao%20no%20Hako', undefined, bare.token);
  assert.equal(none.status, 200);
  assert.deepEqual(none.body.connected, []);
  assert.deepEqual(none.body.entries, []);
});

test('a tracker that is down costs the prefill, not the answer', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist');
  await connect(u.id, 'mal');
  outbound = async (url) => {
    if (url.startsWith('https://graphql.anilist.co')) throw new Error('socket hang up');
    return json({ data: [{ node: {
      id: 118230,
      title: 'Ao no Hako',
      alternative_titles: { en: 'Blue Box', synonyms: [] },
      my_list_status: { status: 'reading', num_chapters_read: 109, score: 9, start_date: '2025-01-02' },
    } }] });
  };

  const r = await api('GET', '/api/trackers/entry?title=Ao%20no%20Hako', undefined, u.token);

  assert.equal(r.status, 200, 'one tracker failing must not fail the sheet');
  // The service that answered still prefills.
  assert.equal(r.body.entries.length, 1);
  assert.equal(r.body.entries[0].service, 'mal');
  assert.equal(r.body.entries[0].chaptersRead, 109);
  assert.equal(r.body.entries[0].score, 9);
  assert.equal(r.body.entries[0].startDate, '2025-01-02');
  // And the one that did not is named, so the sheet can say which.
  assert.equal(r.body.errors.length, 1);
  assert.equal(r.body.errors[0].service, 'anilist');
  assert.match(r.body.errors[0].error, /hang up/);
});

test('kitsu is connected but cannot be asked, so it is not claimed as a source', async () => {
  const u = await newUser();
  await connect(u.id, 'kitsu');
  outbound = null;

  const r = await api('GET', '/api/trackers/entry?title=Ao%20no%20Hako', undefined, u.token);

  assert.equal(r.status, 200);
  assert.deepEqual(r.body.connected, []);
  assert.deepEqual(r.body.entries, []);
});

test('the route wants a title, and is not readable without an account', async () => {
  const u = await newUser();
  outbound = null;
  assert.equal((await api('GET', '/api/trackers/entry', undefined, u.token)).status, 400);
  assert.equal((await api('GET', '/api/trackers/entry?title=A', undefined, u.token)).status, 400);
  assert.equal((await api('GET', '/api/trackers/entry?title=Ao%20no%20Hako')).status, 401);
});

test('"entry" is a route, not a service name', async () => {
  const u = await newUser();
  outbound = null;
  // The catch-all `/:service` sits after it; if that order is ever lost, this
  // asks to disconnect a tracker called "entry" instead of reading one.
  const r = await api('GET', '/api/trackers/entry?title=Ao%20no%20Hako', undefined, u.token);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.entries));
});
