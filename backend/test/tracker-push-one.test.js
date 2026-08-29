// Sending one series' bookmark to the trackers, on demand, with an answer.
//
// Reported by a reader with AniList connected: a series that was not on their
// AniList list could not be put there from PanelFlow, on the one screen that
// knew the title, the chapter and the account. The write path already existed —
// the progress route pushes to every linked tracker as it saves — but only a
// page turn ever walked it, and a page turn has nobody reading the reply, so
// the outcome went into the alert store and no further.
//
// pushProgressNow() is that same request asked deliberately: the library sheet's
// "Add" button. What it has to get right is the reply, because for the first
// time a reader is waiting on it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootCore, json, entryFixture } from '../test-support/core.js';

const URL_ = 'https://scan.test/manga/kingdom';
const BOOKMARK = {
  sourceUrl: URL_,
  chapterUrl: 'https://scan.test/manga/kingdom/chapitre-874',
  chapterLabel: 'Chapitre 874',
  page: 3,
};

/** A signed-in store holding one entry and one bookmark, plus a fake backend. */
function boot({ entry = {}, progress = { [URL_]: BOOKMARK }, fetch: fetchImpl, token = 't',
  alerts } = {}) {
  return bootCore({
    storage: {
      authToken: token,
      library: [entryFixture({ title: 'Kingdom', sourceUrl: URL_, remoteId: 'r1', ...entry })],
      progress,
      ...(alerts ? { trackerAlerts: alerts } : {}),
    },
    fetch: fetchImpl,
  });
}

/** A backend that answers the progress PUT with these tracker results. */
const backend = (trackers, over = {}) => async (url, init) => {
  const path = String(url).replace('https://api.test', '');
  if (path === '/api/library' && init?.method === 'POST') return json({ id: 'r9' });
  if (path.startsWith('/api/progress/')) return json({ ...BOOKMARK, trackers });
  return json(over[path] ?? { ok: true });
};

test('the chapter the reader is on goes to the row the account knows', async () => {
  const { core, calls } = boot({ fetch: backend([{ service: 'anilist', ok: true, chapter: 874 }]) });

  const out = await core.pushProgressNow(URL_);
  assert.deepEqual(out.trackers, [{ service: 'anilist', ok: true, chapter: 874 }]);
  assert.equal(out.error, undefined);

  const put = calls.find((c) => c.url.includes('/api/progress/'));
  assert.equal(put.url, 'https://api.test/api/progress/r1');
  assert.equal(put.init.method, 'PUT');
  // Where the reader actually is — not chapter zero, which is what "add it to
  // my list" would mean if the bookmark were left out of it.
  assert.equal(JSON.parse(put.init.body).chapterLabel, 'Chapitre 874');
});

test('a series the account has never seen is created before it is pushed', async () => {
  // The push lives on the progress route, and the progress route works from a
  // library row: an entry added while signed out has no remote id yet.
  const { core, calls, storage } = boot({
    entry: { remoteId: undefined },
    fetch: backend([{ service: 'anilist', ok: true, chapter: 874 }]),
  });

  const out = await core.pushProgressNow(URL_);
  assert.deepEqual(out.trackers.length, 1);
  assert.equal(calls.filter((c) => c.url.endsWith('/api/library')).length, 1);
  assert.ok(calls.some((c) => c.url === 'https://api.test/api/progress/r9'));
  // And the row is remembered, so the next push does not create a second one.
  assert.equal(storage().library[0].remoteId, 'r9');
});

test('every reason it cannot be sent is a sentence, not an exception', async () => {
  const cases = [
    ['not signed in', { token: null }],
    ['not in the library', { entry: { sourceUrl: 'https://other.test/manga/x' } }],
    ['no chapter to send', { progress: {} }],
  ];
  for (const [why, over] of cases) {
    const { core, calls } = boot({ fetch: backend([]), ...over });
    const out = await core.pushProgressNow(URL_);
    assert.equal(out.error, why);
    assert.deepEqual(out.trackers, []);
    // Nothing left the machine on the way to that answer.
    assert.deepEqual(calls, [], why);
  }
});

test('a backend that is down is reported, not thrown at the sheet', async () => {
  // The sheet awaits this behind a button that says "Adding…", and a rejection
  // would leave that word on screen for good.
  const { core } = boot({ fetch: async () => { throw new Error('socket hang up'); } });
  const out = await core.pushProgressNow(URL_);
  assert.match(out.error, /socket hang up/);
  assert.deepEqual(out.trackers, []);
});

test('what the tracker refused is remembered where the badge reads it', async () => {
  // The sheet says it once, in front of the reader. The menu badge is the same
  // fact tomorrow, so both have to come from the same answer.
  const { core } = boot({
    fetch: backend([{ service: 'mal', error: 'invalid token' }]),
  });
  await core.pushProgressNow(URL_);
  assert.deepEqual(await core.getTrackerAlerts(), {
    mal: { error: 'invalid token', at: '2025-01-01T00:00:01.000Z' },
  });
});

test('a tracker that starts working again clears its own alert', async () => {
  const { core } = boot({
    alerts: { mal: { error: 'invalid token', at: '2025-01-01T00:00:00.000Z' } },
    fetch: backend([{ service: 'mal', ok: true, chapter: 874 }]),
  });
  await core.pushProgressNow(URL_);
  assert.deepEqual(await core.getTrackerAlerts(), {});
});

test('the hub carries it, because the sheet has no other way in', async () => {
  // The library sheet is a content script: `trackerPushOne` is the whole of its
  // access to any of this, on the phone and in the browser alike.
  const { hub } = boot({ fetch: backend([{ service: 'anilist', ok: true, chapter: 874 }]) });
  const out = await hub({ type: 'trackerPushOne', sourceUrl: URL_ });
  assert.equal(out.trackers[0].chapter, 874);
});
