// The chapters you have read, on every device you read on.
//
// NEW-4, reproduced twelve times out of twelve: read four chapters in one
// browser, sign into the same account in a second one or on a phone, and not
// one of them shows as read. Not on the chapter wheel, not to "hide read
// chapters", not at the end of a chapter, whose "mark as read" offered itself
// again. A backup restored with 151 reads in it reached a fresh client as zero.
// The "continue" target was right all along, which is what made it look like
// a drawing bug: the bookmark is pulled from the account, the history never was.
//
// Every device pushed its reads and none asked for anybody else's, and
// getReadChapters only ever looked at this device's own copy. So the tests
// below run two real cores against the real server, signed into one account:
// that is the only shape the bug exists in. One core alone, or a server that
// is a mock, passes whether the reads come back or not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { api, base, newUser, addEntry, shutdown } from '../test-support/harness.js';
import { db } from '../src/db.js';
import { READ_LIMIT } from '../src/routes/history.js';
import { bootCore } from '../test-support/core.js';

test.after(shutdown);

/** A device pointed at this server, with nothing on it yet. */
const device = () => bootCore({
  storage: { settings: { backendUrl: base } },
  fetch: (url, init) => fetch(url, init),
});

/**
 * Sign a device in the way the hub's `auth` message does, awaited: adopt what
 * the account holds, then sync. The hub starts the second half and returns at
 * once, which is right for a sign-in screen and no use to a test that wants to
 * look at the result.
 */
async function signIn(dev, email) {
  await dev.core.authenticate('login', email, 'password123');
  await dev.core.pullLibrary();
  await dev.core.syncAll();
}

// With a cover and a latest chapter of its own, so that no sync asks the
// server to scrape a page that does not exist.
const SERIES = {
  title: 'Ao no Hako',
  sourceDomain: 'sushiscan.test',
  sourceUrl: 'https://sushiscan.test/manga/ao-no-hako/',
  coverUrl: 'https://sushiscan.test/covers/ao-no-hako.jpg',
  lastKnownChapter: '160',
};
const chapter = (n) => `https://sushiscan.test/ao-no-hako-chapitre-${n}/`;

/** Read chapter `n` on a device, the way the reader banks a chapter. */
const readOn = (dev, n) => dev.core.recordRead({
  sourceUrl: SERIES.sourceUrl,
  chapterUrl: chapter(n),
  chapterLabel: `Chapitre ${n}`,
  seconds: 240,
  pages: 18,
});

/** An account with SERIES on it and chapters `read` read in one browser. */
async function readInOneBrowser(read) {
  const user = await newUser();
  const first = device();
  await signIn(first, user.email);
  await first.core.addToLibrary(SERIES);
  for (const n of read) await readOn(first, n);
  return user;
}

// --- two devices, one account -------------------------------------------------

test('chapters read on one device are read on the next one signed into the account', async () => {
  const { email } = await readInOneBrowser([109, 110, 111, 112]);

  const second = device();
  await signIn(second, email);

  const expected = [109, 110, 111, 112].map(chapter).sort();
  assert.deepEqual((await second.core.getReadChapters(SERIES.sourceUrl)).sort(), expected,
    'the second device sees none of what the first one read');
  // Asked the way the reader asks: through the hub, with the address the page
  // guessed from the chapter it is on, which is not the one the library files
  // the series under.
  const { chapters } = await second.hub({
    type: 'getReadChapters', sourceUrl: 'https://sushiscan.test/ao-no-hako-chapitre-112/',
  });
  assert.deepEqual(chapters.sort(), expected);
  // Still per series: another series' wheel has nothing to grey.
  assert.deepEqual(await second.core.getReadChapters('https://sushiscan.test/manga/blue-lock/'), []);
});

test('reads the account holds from elsewhere reach a fresh install', async () => {
  // The other half of the report: a backup restored with 151 reads in it, and
  // a client signed in afterwards that saw none. Written straight to the API
  // here, because what matters is that the reads are on the account and were
  // never on this device, not which door they came in through.
  const user = await newUser();
  const entry = await addEntry(user.token, SERIES);
  for (let n = 1; n <= 151; n++) {
    const r = await api('POST', '/api/history', {
      libraryId: entry.id, chapterUrl: chapter(n), chapterLabel: `Chapitre ${n}`,
      seconds: 300, pages: 20,
    }, user.token);
    assert.equal(r.status, 201);
  }

  const fresh = device();
  await signIn(fresh, user.email);
  assert.equal((await fresh.core.getReadChapters(SERIES.sourceUrl)).length, 151);
});

test('what a device read itself and what the account read are one answer', async () => {
  const { email } = await readInOneBrowser([109, 110]);
  const second = device();
  await signIn(second, email);
  // Read on this device as well: one chapter the first device also read, one
  // it did not. Each is named once.
  await readOn(second, 110);
  await readOn(second, 111);

  assert.deepEqual((await second.core.getReadChapters(SERIES.sourceUrl)).sort(),
    [109, 110, 111].map(chapter).sort());
});

test('what was pulled is never sent back', async () => {
  // The account's reads are filed beside the history, never in it: a history
  // row carries seconds still owed to the server, so a pulled read written
  // there would be added to the account a second time by the next flush.
  const { email, token } = await readInOneBrowser([109, 110, 111, 112]);
  const before = (await api('GET', '/api/history/stats', undefined, token)).body;

  const second = device();
  await signIn(second, email);
  await second.core.syncAll();
  await second.core.flushHistory();

  assert.deepEqual(second.storage().history ?? {}, {},
    'what came down from the account was written into this device\'s history');
  assert.ok(!second.calls.some((c) => c.url.endsWith('/api/history') && c.init?.method === 'POST'),
    'the device that only pulled sent reading history to the server');
  const after = (await api('GET', '/api/history/stats', undefined, token)).body;
  assert.equal(after.chapters, before.chapters);
  assert.equal(after.seconds, before.seconds);
});

// --- signing out -------------------------------------------------------------

test('signing out takes the account\'s reads with it', async () => {
  const { email } = await readInOneBrowser([109, 110]);
  const second = device();
  await signIn(second, email);
  await readOn(second, 111);
  assert.equal((await second.core.getReadChapters(SERIES.sourceUrl)).length, 3);

  // Synced first, then gone: the next person to open this browser finds
  // nobody's reading, the account's or this device's (shared/panelflow-core.js,
  // logout). Chapter 111 is on the server now, not lost.
  const out = await second.core.logout();
  assert.equal(out.synced, true);
  assert.deepEqual(second.storage().accountReads, {}, 'the account\'s reads outlived the sign-out');
  assert.deepEqual(await second.core.getReadChapters(SERIES.sourceUrl), []);
  const back = device();
  await signIn(back, email);
  assert.deepEqual((await back.core.getReadChapters(SERIES.sourceUrl)).sort(),
    [109, 110, 111].map(chapter).sort());
});

test('an answer that comes back after signing out is dropped', async () => {
  const { email } = await readInOneBrowser([109]);

  // A device that signs out while its pull is still on the wire. Once: the
  // sign-out syncs first, and that sync asks for the reads again.
  let signingOut = false;
  const dev = bootCore({
    storage: { settings: { backendUrl: base } },
    fetch: async (url, init) => {
      const resp = await fetch(url, init);
      if (String(url).endsWith('/api/history/read') && !signingOut) {
        signingOut = true;
        await dev.core.logout();
      }
      return resp;
    },
  });
  await dev.core.authenticate('login', email, 'password123');
  await dev.core.pullLibrary();
  await dev.core.pullReadChapters();

  assert.deepEqual(dev.storage().accountReads, {});
  assert.deepEqual(await dev.core.getReadChapters(SERIES.sourceUrl), []);
});

test('signing into another account does not keep the last one\'s reads', async () => {
  const { email } = await readInOneBrowser([109, 110]);
  const other = await newUser();

  const dev = device();
  await signIn(dev, email);
  assert.equal((await dev.core.getReadChapters(SERIES.sourceUrl)).length, 2);
  // No sign-out in between, and no sync after: only the sign-in itself.
  await dev.core.authenticate('login', other.email, 'password123');
  assert.deepEqual(await dev.core.getReadChapters(SERIES.sourceUrl), []);
});

// --- the route ---------------------------------------------------------------

test('the read set is this account\'s own, once per chapter, grouped by series', async () => {
  const u = await newUser();
  const a = await addEntry(u.token, { sourceUrl: 'https://x.test/manga/a', title: 'A' });
  const b = await addEntry(u.token, { sourceUrl: 'https://x.test/manga/b', title: 'B' });
  const read = (libraryId, chapterUrl, day) => api('POST', '/api/history',
    { libraryId, chapterUrl, seconds: 60, pages: 5, ...(day ? { day } : {}) }, u.token);
  await read(a.id, 'https://x.test/a/1', '2026-01-01');
  await read(a.id, 'https://x.test/a/1', '2026-01-03'); // a reread is still one chapter
  await read(a.id, 'https://x.test/a/2');
  await read(b.id, 'https://x.test/b/1');

  // Somebody else's reading, which must not leak into this answer.
  const v = await newUser();
  const theirs = await addEntry(v.token, { sourceUrl: 'https://x.test/manga/a', title: 'A' });
  await api('POST', '/api/history',
    { libraryId: theirs.id, chapterUrl: 'https://x.test/a/9', seconds: 60 }, v.token);

  const r = await api('GET', '/api/history/read', undefined, u.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.truncated, false);
  const bySeries = Object.fromEntries(r.body.series.map((s) => [s.libraryId, s]));
  assert.deepEqual(Object.keys(bySeries).sort(), [a.id, b.id].sort());
  assert.equal(bySeries[a.id].sourceUrl, 'https://x.test/manga/a');
  assert.deepEqual(bySeries[a.id].chapters.sort(), ['https://x.test/a/1', 'https://x.test/a/2']);
  assert.deepEqual(bySeries[b.id].chapters, ['https://x.test/b/1']);
});

test('a removed series keeps its reads in the set', async () => {
  // As in the log: a series you removed is still one you read, and it may be
  // added back, under the same address or another of the same series.
  const u = await newUser();
  const e = await addEntry(u.token);
  await api('POST', '/api/history', { libraryId: e.id, chapterUrl: 'https://x.test/c/1', seconds: 60 }, u.token);
  await api('DELETE', `/api/library/${e.id}`, undefined, u.token);

  const r = await api('GET', '/api/history/read', undefined, u.token);
  assert.deepEqual(r.body.series.map((s) => s.chapters), [['https://x.test/c/1']]);
});

test('the read set needs an account', async () => {
  const r = await api('GET', '/api/history/read', undefined, null);
  assert.equal(r.status, 401);
});

test('a history past the limit is cut, newest kept, and says it was cut', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  // Written straight to the table: READ_LIMIT requests would test the clock.
  const rows = [{
    sql: 'INSERT INTO history (user_id, library_id, chapter_url, day, pages, seconds) VALUES (?, ?, ?, ?, 1, 60)',
    args: [u.id, e.id, 'https://x.test/c/oldest', '2020-01-01'],
  }];
  for (let n = 0; n < READ_LIMIT; n++) {
    rows.push({ ...rows[0], args: [u.id, e.id, `https://x.test/c/${n}`, '2026-01-02'] });
  }
  for (let i = 0; i < rows.length; i += 1000) await db.batch(rows.slice(i, i + 1000));

  const r = await api('GET', '/api/history/read', undefined, u.token);
  assert.equal(r.body.truncated, true);
  const chapters = r.body.series.flatMap((s) => s.chapters);
  assert.equal(chapters.length, READ_LIMIT);
  assert.ok(!chapters.includes('https://x.test/c/oldest'), 'the cut fell on a recent read');
});
