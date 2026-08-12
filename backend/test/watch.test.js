// The server-side chapter watcher.
//
// This is the one part of PanelFlow that acts on its own, with nobody watching
// and no way to notice it went wrong: a bug here is either an alert for a
// chapter the reader finished last spring, or silence for weeks. Both look
// exactly like "nothing happened".
//
// So what is pinned down below is the arithmetic around the announcement — when
// a chapter counts as new, when it counts as merely newly *known*, and that a
// series followed by ten accounts is still fetched once — plus the rotation,
// which is what stops a library larger than one run from only ever having its
// first page checked.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, addEntry, shutdown } from '../test-support/harness.js';
import { bootWorker, entryFixture } from '../test-support/worker.js';
import { runWatch } from '../src/routes/watch.js';
import { db } from '../src/db.js';

after(shutdown);

const page = (n) => `<a href="/manga/x/chapter-${n}">Chapter ${n}</a>`;

/** runWatch with the network replaced by a lookup table, and no pauses. */
const run = (pages, opts = {}) => {
  const asked = [];
  const stats = runWatch({
    pacingMs: 0,
    ...opts,
    fetch: async (url) => {
      asked.push(url);
      const html = pages[url];
      if (html === undefined) throw new Error('unreachable');
      return html;
    },
  });
  return stats.then((s) => ({ ...s, asked }));
};

const newsOf = (token) => api('GET', '/api/news', undefined, token);

// --- the cron endpoint ------------------------------------------------------
// First in the file, deliberately: it runs the real watcher, and at this point
// no account has a library for it to go fetch.

test('the runner will not run for anyone who cannot prove the platform sent them', async () => {
  const before = process.env.PANELFLOW_CRON_SECRET;
  delete process.env.PANELFLOW_CRON_SECRET;
  delete process.env.CRON_SECRET;

  // An endpoint that makes the server fetch dozens of third-party pages is an
  // amplifier, so no secret means no runner at all — not an open one.
  const off = await api('POST', '/api/watch/run', undefined, null);
  assert.equal(off.status, 503);

  process.env.PANELFLOW_CRON_SECRET = 'sesame';
  const anon = await api('POST', '/api/watch/run', undefined, null);
  assert.equal(anon.status, 401);
  const wrong = await api('POST', '/api/watch/run', undefined, 'sesam');
  assert.equal(wrong.status, 401, 'a prefix of the secret was accepted');

  const ok = await api('POST', '/api/watch/run', undefined, 'sesame');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.series, 0);

  if (before === undefined) delete process.env.PANELFLOW_CRON_SECRET;
  else process.env.PANELFLOW_CRON_SECRET = before;
});

test('the cron reaches the runner with the verb it actually uses', async () => {
  process.env.PANELFLOW_CRON_SECRET = 'sesame';
  const r = await api('GET', '/api/watch/run', undefined, 'sesame');
  assert.equal(r.status, 200, 'Vercel Cron sends GET and would 404 on this route');
  delete process.env.PANELFLOW_CRON_SECRET;
});

// --- what counts as news ----------------------------------------------------

test('a first sighting is remembered, not announced', async () => {
  // The alternative is that the run after this ships tells every reader that
  // every series they follow has a new chapter — all of them ones read months
  // ago. The baseline pass is silent by design.
  const u = await newUser();
  const url = 'https://first.test/manga/a';
  const entry = await addEntry(u.token, { sourceUrl: url, lastKnownChapter: null });

  const s = await run({ [url]: page(250) });
  assert.equal(s.news, 0);
  assert.deepEqual((await newsOf(u.token)).body, []);

  const row = await db.prepare('SELECT last_known_chapter FROM library WHERE id = ?').get(entry.id);
  assert.equal(row.last_known_chapter, '250');
});

test('a chapter above what the library knew is news, once', async () => {
  const u = await newUser();
  const url = 'https://news.test/manga/b';
  await addEntry(u.token, { title: 'Berserk', sourceUrl: url, lastKnownChapter: '100' });

  const first = await run({ [url]: page(101) });
  assert.equal(first.news, 1);

  const list = await newsOf(u.token);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].chapter, '101');
  assert.equal(list.body[0].title, 'Berserk');
  assert.equal(list.body[0].sourceUrl, url);

  // Same page tomorrow: the library now knows 101, so there is nothing to say.
  const again = await run({ [url]: page(101) });
  assert.equal(again.news, 0);
  assert.equal((await newsOf(u.token)).body.length, 1, 'the same chapter was filed twice');
});

test('a site that goes backwards is not treated as a discovery', async () => {
  // Half-loaded pages and paginated chapter lists both under-report. Writing
  // the lower number back would make the *next* run announce the chapter the
  // reader has already read.
  const u = await newUser();
  const url = 'https://flaky.test/manga/c';
  const entry = await addEntry(u.token, { sourceUrl: url, lastKnownChapter: '300' });

  const s = await run({ [url]: page(12) });
  assert.equal(s.news, 0);
  const row = await db.prepare('SELECT last_known_chapter FROM library WHERE id = ?').get(entry.id);
  assert.equal(row.last_known_chapter, '300');
});

test('one fetch serves every account following the same series', async () => {
  // The politeness rule that matters most: a popular series must not cost the
  // site one request per subscriber.
  const url = 'https://shared.test/manga/one-piece';
  const a = await newUser();
  const b = await newUser();
  await addEntry(a.token, { title: 'One Piece', sourceUrl: url, lastKnownChapter: '1100' });
  await addEntry(b.token, { title: 'One Piece', sourceUrl: url, lastKnownChapter: '1099' });

  const s = await run({ [url]: page(1101) });
  assert.equal(s.asked.filter((u) => u === url).length, 1);
  assert.equal(s.news, 2, 'both readers should have been told');
  assert.equal((await newsOf(a.token)).body.length, 1);
  assert.equal((await newsOf(b.token)).body.length, 1);
});

test('only series still being read are checked', async () => {
  const u = await newUser();
  const dropped = 'https://folders.test/manga/dropped';
  const done = 'https://folders.test/manga/completed';
  const paused = 'https://folders.test/manga/paused';
  await addEntry(u.token, { sourceUrl: dropped, folder: 'dropped', lastKnownChapter: '1' });
  await addEntry(u.token, { sourceUrl: done, folder: 'completed', lastKnownChapter: '1' });
  await addEntry(u.token, { sourceUrl: paused, folder: 'paused', lastKnownChapter: '1' });

  const s = await run({ [dropped]: page(9), [done]: page(9), [paused]: page(9) });
  assert.ok(s.asked.includes(paused), 'a paused series still gets its new chapters');
  assert.ok(!s.asked.includes(dropped), 'a dropped series was fetched');
  assert.ok(!s.asked.includes(done), 'a finished series was fetched');
  assert.equal((await newsOf(u.token)).body.length, 1);
});

// --- the rotation -----------------------------------------------------------

test('a run too small for the library picks up where the last one stopped', async () => {
  // Without this, a library of 200 series and a run of 60 would check the same
  // 60 forever and the other 140 never.
  const u = await newUser();
  const urls = [1, 2, 3].map((n) => `https://rotate.test/manga/${n}`);
  for (const url of urls) await addEntry(u.token, { sourceUrl: url, lastKnownChapter: '1' });
  const pages = Object.fromEntries(urls.map((u2) => [u2, page(2)]));

  const first = await run(pages, { limit: 2 });
  const second = await run(pages, { limit: 2 });
  assert.equal(first.asked.length, 2);
  // The one left out of the first run has no checked_at at all, so it sorts
  // ahead of both of the ones that do.
  const missed = urls.find((u2) => !first.asked.includes(u2));
  assert.equal(second.asked[0], missed);
});

test('a site that is down does not hold up the rotation behind it', async () => {
  const u = await newUser();
  const dead = 'https://gone.test/manga/x';
  const alive = 'https://alive.test/manga/y';
  await addEntry(u.token, { sourceUrl: dead, lastKnownChapter: '1' });
  await addEntry(u.token, { sourceUrl: alive, lastKnownChapter: '1' });

  const s = await run({ [alive]: page(2) });          // `dead` is not in the table
  assert.ok(s.failed >= 1);
  assert.ok(s.asked.includes(dead) && s.asked.includes(alive),
    'the run stopped at the unreachable series');
  assert.equal((await newsOf(u.token)).body.length, 1, 'the reachable series was not checked');

  const row = await db.prepare('SELECT checked_at FROM library WHERE source_url = ?').get(dead);
  assert.ok(row.checked_at, 'an unreachable series would sit at the head of the queue forever');
});

test('a run stops on its deadline rather than being killed by the platform', async () => {
  // Being killed loses the checked_at writes, and a run that never records what
  // it did is a run that repeats itself.
  const u = await newUser();
  const urls = [1, 2, 3].map((n) => `https://slow.test/manga/${n}`);
  for (const url of urls) await addEntry(u.token, { sourceUrl: url, lastKnownChapter: '1' });

  const s = await run(Object.fromEntries(urls.map((u2) => [u2, page(2)])), {
    hosts: 1, pacingMs: 30, deadlineMs: 1,
  });
  assert.equal(s.ranOut, true);
  assert.ok(s.asked.length < 3, 'the deadline did not stop anything');
});

// --- asking twice for the same page -----------------------------------------

test('the second run quotes back what the first was given, and a 304 costs nothing', async () => {
  const u = await newUser();
  const url = 'https://cond.test/manga/a';
  await addEntry(u.token, { sourceUrl: url, lastKnownChapter: '1' });

  const asked = [];
  // A fetch that answers the way a real site does: the page and its validators
  // the first time, "not modified" every time they come back.
  // Only this URL exists for it: the tests above left their own series in the
  // table, and they would otherwise be counted into every number below.
  const conditional = (html) => async (u2, seen = {}) => {
    if (u2 !== url) throw new Error('unreachable');
    asked.push(seen);
    if (seen.etag === 'W/"v7"') return { unchanged: true, html: null };
    return { unchanged: false, html, etag: 'W/"v7"', lastModified: 'Tue, 05 Aug 2026 10:00:00 GMT' };
  };

  const first = await runWatch({ pacingMs: 0, fetch: conditional(page(2)) });
  assert.equal((await newsOf(u.token)).body.length, 1);
  assert.equal(first.unchanged, 0);
  assert.deepEqual(asked[0], { etag: null, lastModified: null }, 'nothing to quote on a first sighting');

  const second = await runWatch({ pacingMs: 0, fetch: conditional(page(9)) });
  assert.deepEqual(asked[1], { etag: 'W/"v7"', lastModified: 'Tue, 05 Aug 2026 10:00:00 GMT' });
  assert.equal(second.unchanged, 1);
  assert.ok(second.checked >= 1, 'a 304 is a successful check, not a failure');
  // The fixture would have announced chapter 9 had the body been read. It was
  // not: the site said the page had not changed, and that answer is trusted.
  assert.equal(second.news, 0);
  assert.equal((await newsOf(u.token)).body.length, 1);

  // And the rotation still moved, or one 304-ing series would be re-asked
  // first forever.
  const row = await db.prepare('SELECT checked_at, etag FROM library WHERE source_url = ?').get(url);
  assert.ok(row.checked_at);
  // A third run must still have something to quote: a 304 carries no
  // validators, and storing what it did not send would throw away the very
  // thing that produced it.
  assert.equal(row.etag, 'W/"v7"');
  await runWatch({ pacingMs: 0, fetch: conditional(page(9)) });
  assert.deepEqual(asked[2], { etag: 'W/"v7"', lastModified: 'Tue, 05 Aug 2026 10:00:00 GMT' });
});

test('a page that has changed replaces the validators it was checked against', async () => {
  const u = await newUser();
  const url = 'https://cond2.test/manga/b';
  await addEntry(u.token, { sourceUrl: url, lastKnownChapter: '1' });

  const only = (html, etag) => async (u2) => {
    if (u2 !== url) throw new Error('unreachable');
    return { unchanged: false, html, etag };
  };
  await runWatch({ pacingMs: 0, fetch: only(page(2), '"one"') });
  await runWatch({ pacingMs: 0, fetch: only(page(3), '"two"') });
  const row = await db.prepare('SELECT etag, last_known_chapter FROM library WHERE source_url = ?').get(url);
  assert.equal(row.etag, '"two"', 'the old validator would make the next run miss a real change');
  assert.equal(row.last_known_chapter, '3');
});

// --- draining ---------------------------------------------------------------

test('news is unseen until a client says otherwise, and stays readable after', async () => {
  const u = await newUser();
  const url = 'https://drain.test/manga/d';
  const entry = await addEntry(u.token, { sourceUrl: url, lastKnownChapter: '5' });
  await run({ [url]: page(6) });

  const marked = await api('POST', '/api/news/seen', {
    items: [{ libraryId: entry.id, chapter: '6' }],
  }, u.token);
  assert.equal(marked.body.marked, 1);
  assert.deepEqual((await newsOf(u.token)).body, [], 'a seen chapter came back as unseen');

  // Kept, not deleted: the web app shows a "while you were away" list, and a
  // notification nobody was at the screen for is the whole reason it exists.
  const all = await api('GET', '/api/news?all=1', undefined, u.token);
  assert.equal(all.body.length, 1);
  assert.equal(all.body[0].seen, true);
});

test("one account never drains another account's news", async () => {
  const a = await newUser();
  const b = await newUser();
  const url = 'https://private.test/manga/e';
  const entry = await addEntry(a.token, { sourceUrl: url, lastKnownChapter: '5' });
  await addEntry(b.token, { sourceUrl: url, lastKnownChapter: '5' });
  await run({ [url]: page(6) });

  await api('POST', '/api/news/seen', { items: [{ libraryId: entry.id, chapter: '6' }] }, b.token);
  assert.equal((await newsOf(a.token)).body.length, 1, "b marked a's news as seen");
});

test('news for a removed series is not offered to the reader', async () => {
  const u = await newUser();
  const url = 'https://removed.test/manga/f';
  const entry = await addEntry(u.token, { sourceUrl: url, lastKnownChapter: '5' });
  await run({ [url]: page(6) });
  await api('DELETE', `/api/library/${entry.id}`, undefined, u.token);
  assert.deepEqual((await newsOf(u.token)).body, []);
});

test('the news endpoints are behind a login', async () => {
  assert.equal((await api('GET', '/api/news', undefined, null)).status, 401);
  assert.equal((await api('POST', '/api/news/seen', {}, null)).status, 401);
});

// --- the client half --------------------------------------------------------

test('the worker turns the server news into the alerts it would have raised itself', async () => {
  const entry = entryFixture({
    remoteId: 'remote-1', lastKnownChapter: '109',
    sourceUrl: 'https://old-scan.test/manga/ao-no-hako',
  });
  const seen = [];
  const w = bootWorker({
    storage: { library: [entry], authToken: 't' },
    fetch: async (url, init) => {
      if (String(url).endsWith('/api/news/seen')) {
        seen.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ marked: 1 }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ([{
          libraryId: 'remote-1', chapter: '110', title: 'Ao no Hako',
          sourceUrl: entry.sourceUrl, sourceDomain: 'old-scan.test',
          foundAt: '2026-08-06T00:00:00Z', seen: false,
        }]),
      };
    },
  });

  const r = await w.send({ type: 'pullNews' });
  assert.equal(r.count, 1);
  assert.equal(w.notifications.length, 1);
  assert.match(w.notifications[0].message, /Ao no Hako.*110/);
  assert.deepEqual(seen, [{ items: [{ libraryId: 'remote-1', chapter: '110' }] }]);

  // The local copy has to learn what the server saw, or the on-device check
  // rediscovers chapter 110 an hour later and announces it a second time.
  assert.equal(w.storage().library[0].lastKnownChapter, '110');
});

test('news for a series this device has never pulled still reaches the reader', async () => {
  const w = bootWorker({
    storage: { library: [], authToken: 't' },
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (String(url).endsWith('/seen') ? { marked: 1 } : [{
        libraryId: 'remote-9', chapter: '4', title: 'Blue Lock',
        sourceUrl: 'https://other.test/manga/blue-lock', sourceDomain: 'other.test',
      }]),
    }),
  });
  await w.send({ type: 'pullNews' });
  assert.equal(w.notifications.length, 1);
  await w.clickNotification(w.notifications[0].id);
  assert.deepEqual(w.opened, ['https://other.test/manga/blue-lock']);
});

test('a signed-out client asks for nothing', async () => {
  const w = bootWorker({ storage: { library: [entryFixture()] } });
  const r = await w.send({ type: 'pullNews' });
  assert.equal(r.count, 0);
  assert.equal(w.calls.length, 0, 'the server was called without a token');
});
