// The latest chapter is a measurement, and the newest measurement wins.
//
// "Return of the SSS-Class Ranker", read to chapter 2, wore a "2005 nouv."
// badge on the iPhone (October 2026): 2007 - 2. The 2007 was a sidebar on the
// series page that links another series' chapter 2007 (latest-chapter.test.js
// holds that half, fixed since). The detection now answers 300, but the 2007
// already stored could not come down: the watcher only ever raised the value
// (latest > known), and every merge on the clients kept the higher of two
// (furtherChapter). One wrong reading was there for good.
//
// So each value now carries when it was measured. A measurement replaces an
// older one in either direction; a value with no date (an older client, a
// stale local copy) only fills a series nobody has measured yet. The watcher
// also measures every series it never measured, without its HTTP validators,
// which is the one-time repair of the values stored before this.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { api, base, newUser, shutdown } from '../test-support/harness.js';
import { bootCore, json, html } from '../test-support/core.js';
import { runWatch } from '../src/routes/watch.js';
import { db } from '../src/db.js';

after(shutdown);

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
await import(pathToFileURL(join(root, 'shared', 'library-view.js')).href);
const { newChapters } = globalThis.PanelFlowView;

const SERIES_URL = 'https://asurascans.test/comics/return-of-the-sss-class-ranker-5b2c91aa';
const chapterUrl = (n) => `${SERIES_URL}/chapter/${n}`;

/** The series page as the site builds it: its own chapters, and a sidebar. */
const seriesPage = (last) => [
  '<a href="/comics/martial-peak-9f1e2d/chapter/2007">Chapter 2007</a>',
  ...[last, last - 1, 1].map((n) =>
    `<a href="/comics/return-of-the-sss-class-ranker-5b2c91aa/chapter/${n}">Chapter ${n}</a>`),
].join('\n');

/** A phone pointed at this server, signed in, with the series read to `read`. */
async function phoneWith({ stored, read }) {
  const user = await newUser();
  const phone = bootCore({
    storage: { settings: { backendUrl: base } },
    fetch: (url, init) => fetch(url, init),
  });
  await phone.core.authenticate('login', user.email, 'password123');
  await phone.core.addToLibrary({
    title: 'Return of the SSS-Class Ranker',
    sourceDomain: 'asurascans.test',
    sourceUrl: SERIES_URL,
    coverUrl: 'https://asurascans.test/covers/sss.webp',
    lastKnownChapter: String(stored),
  });
  await phone.core.chapterVisited({
    sourceUrl: SERIES_URL, chapterUrl: chapterUrl(read), chapterLabel: `Chapter ${read}`,
  });
  return { user, phone };
}

/** What the badge on the phone's shelf says for the series. */
async function badgeOn(phone) {
  const { library, progress } = phone.storage();
  const entry = library.find((e) => e.sourceUrl === SERIES_URL);
  return newChapters(entry, (progress || {})[SERIES_URL]);
}

const serverRow = (userId) => db.prepare(
  'SELECT * FROM library WHERE user_id = ? AND source_url = ?',
).get(userId, SERIES_URL);

/** The nightly watcher, with the series page answering `last` as its newest chapter. */
const watchSays = (last, seen = []) => runWatch({
  pacingMs: 0,
  fetch: async (url, validators) => {
    seen.push({ url, validators });
    if (url !== SERIES_URL) throw new Error('unreachable');
    return seriesPage(last);
  },
});

// --- the report ---------------------------------------------------------------

test('2007 stored, 300 measured: the badge comes down to 298 and stays there', async () => {
  const { user, phone } = await phoneWith({ stored: 2007, read: 2 });
  assert.equal(await badgeOn(phone), 2005, 'the report, reproduced');

  await watchSays(300);
  assert.equal((await serverRow(user.id)).last_known_chapter, '300',
    'the server kept 2007 over a fresh measurement of 300');

  await phone.core.syncAll();
  assert.equal(await badgeOn(phone), 298, 'the phone kept its own 2007');

  // And the phone does not hand its old value back on the next sync.
  await phone.core.syncAll();
  assert.equal((await serverRow(user.id)).last_known_chapter, '300');
});

// --- who wins -----------------------------------------------------------------

test('a value with no date does not replace a measured one, in either direction', async () => {
  const { user } = await phoneWith({ stored: 2007, read: 2 });
  await watchSays(300);
  const row = await serverRow(user.id);

  // An older client, or a copy that was never measured, sending what it holds.
  await api('PUT', `/api/library/${row.id}`, { lastKnownChapter: '2007' }, user.token);
  assert.equal((await serverRow(user.id)).last_known_chapter, '300');
  await api('POST', '/api/library', {
    title: 'Return of the SSS-Class Ranker', sourceDomain: 'asurascans.test',
    sourceUrl: SERIES_URL, lastKnownChapter: '2007',
  }, user.token);
  assert.equal((await serverRow(user.id)).last_known_chapter, '300');
});

test('a newer measurement replaces an older one, and an older one does not', async () => {
  const { user } = await phoneWith({ stored: 2007, read: 2 });
  await watchSays(300);
  // Measured two days ago, so that "a minute later" is still in the past.
  const at = Date.now() - 2 * 86_400_000;
  await db.prepare('UPDATE library SET chapter_measured_at = ? WHERE user_id = ?')
    .run(new Date(at).toISOString(), user.id);
  const row = await serverRow(user.id);

  // The extension read the page in the reader's browser after the watcher did.
  const later = new Date(at + 60_000).toISOString();
  let r = await api('PUT', `/api/library/${row.id}`,
    { lastKnownChapter: '301', chapterMeasuredAt: later }, user.token);
  assert.equal(r.body.lastKnownChapter, '301');
  assert.equal(r.body.chapterMeasuredAt, later);

  // A device that measured yesterday and only now came back online.
  const earlier = new Date(at - 86_400_000).toISOString();
  r = await api('PUT', `/api/library/${row.id}`,
    { lastKnownChapter: '250', chapterMeasuredAt: earlier }, user.token);
  assert.equal(r.body.lastKnownChapter, '301');
});

test('a measurement dated in the future counts as made now', async () => {
  // A phone whose clock is a year ahead would otherwise win every argument
  // for a year.
  const { user } = await phoneWith({ stored: 10, read: 2 });
  const row = await serverRow(user.id);
  const r = await api('PUT', `/api/library/${row.id}`,
    { lastKnownChapter: '12', chapterMeasuredAt: '2099-01-01T00:00:00.000Z' }, user.token);
  assert.equal(r.body.lastKnownChapter, '12');
  assert.ok(Date.parse(r.body.chapterMeasuredAt) <= Date.now());
});

// --- the repair ----------------------------------------------------------------

test('the watcher measures a series it never measured, validators or not', async () => {
  // The values stored before this have no date. A 304 would leave them as
  // they are for as long as the page does not change, so they are fetched
  // without the validators once, and measured.
  const { user } = await phoneWith({ stored: 2007, read: 2 });
  await db.prepare('UPDATE library SET etag = ?, chapter_measured_at = NULL WHERE source_url = ?')
    .run('"v1"', SERIES_URL);
  const seen = [];
  await watchSays(300, seen);
  const asked = seen.find((s) => s.url === SERIES_URL);
  assert.equal(asked.validators.etag, null, 'asked conditionally: a 304 would keep 2007');
  assert.equal((await serverRow(user.id)).last_known_chapter, '300');
});

test('a measurement that comes down announces nothing', async () => {
  const { user } = await phoneWith({ stored: 2007, read: 2 });
  await watchSays(300);
  const news = await api('GET', '/api/news', undefined, user.token);
  assert.deepEqual(news.body, []);
});

// --- on a device ---------------------------------------------------------------

/** A device whose server answers the library with `rows` and everything else empty. */
const deviceWith = (library, rows) => bootCore({
  storage: { authToken: 't', library },
  fetch: async (url) => {
    const path = new URL(url).pathname;
    return json(path === '/api/library' ? rows : []);
  },
});

test('a dated reading on the device is not overruled by an older one from the server', async () => {
  const local = { id: 'a', remoteId: 'r1', sourceUrl: SERIES_URL, title: 'SSS',
    lastKnownChapter: '301', chapterMeasuredAt: '2026-10-21T10:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
  const row = { id: 'r1', sourceUrl: SERIES_URL, title: 'SSS',
    lastKnownChapter: '300', chapterMeasuredAt: '2026-10-21T03:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' };
  const dev = deviceWith([local], [row]);
  await dev.core.pullLibrary();
  const [entry] = dev.storage().library;
  assert.equal(entry.lastKnownChapter, '301', 'the newer edit of the row carried the older reading in');
  assert.equal(entry.chapterMeasuredAt, local.chapterMeasuredAt);
});

test('two copies of one series keep the newer reading, not the higher one', async () => {
  const copy = (id, chapter, at) => ({ id, sourceUrl: `${SERIES_URL}${id === 'b' ? '/' : ''}`,
    sourceDomain: 'asurascans.test', title: 'SSS', lastKnownChapter: chapter, chapterMeasuredAt: at });
  const dev = deviceWith([copy('a', '2007', null), copy('b', '300', '2026-10-21T03:00:00.000Z')], []);
  await dev.core.dedupeLibrary();
  const library = dev.storage().library;
  assert.equal(library.length, 1);
  assert.equal(library[0].lastKnownChapter, '300');
  assert.equal(library[0].chapterMeasuredAt, '2026-10-21T03:00:00.000Z');
});

test('the check on the device dates what it reads, and lowers a wrong value', async () => {
  const entry = { id: 'a', sourceUrl: SERIES_URL, sourceDomain: 'asurascans.test', title: 'SSS',
    lastKnownChapter: '2007' };
  const dev = bootCore({
    storage: { library: [entry] },
    fetch: async (url) => (String(url) === SERIES_URL ? html(seriesPage(300)) : json({})),
  });
  await dev.core.checkNewChapters();
  const [after] = dev.storage().library;
  assert.equal(after.lastKnownChapter, '300');
  assert.ok(after.chapterMeasuredAt, 'the reading has no date');
  assert.equal(dev.notifications.length, 0, 'coming down is not a new chapter');
});
