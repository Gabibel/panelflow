// Two devices, one account, and the place in the book that must survive both.
//
// The QA pass of September 2026 read chapter 12 on a phone, opened the popup on
// a PC that was still at chapter 10, and watched the phone go back to chapter
// 10. Three faults lined up: the PC never pulled what the phone wrote (it only
// pulled at sign-in), every sync re-sent every bookmark, and the server took
// whatever arrived last. A fourth made the pull lose even when it ran: the
// server spells a moment "2026-09-24 19:17:41" and the clients
// "2026-09-24T18:52:47.248Z", and compared as text the server lost every time
// on the same day.
//
// Then the session: an account closed from the phone left the PC "signed in",
// its Synchronise button saying ✓ while every request bounced; and on a shared
// browser the next account to sign in inherited the previous one's shelf.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, addEntry, newUser, shutdown } from '../test-support/harness.js';
import { bootCore, json, entryFixture } from '../test-support/core.js';

after(shutdown);

const chapter = (n) => `https://example-manga-site.test/manga/x/ch-${n}`;

// --- the server keeps the bookmark read last --------------------------------

test('an older bookmark does not overwrite a newer one, and is told so', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  const phone = await api('PUT', `/api/progress/${e.id}`, {
    chapterUrl: chapter(12), chapterLabel: 'Ch. 12', page: 4, updatedAt: '2026-09-24T19:17:40.000Z',
  }, u.token);
  assert.equal(phone.status, 200);
  assert.equal(phone.body.stale, undefined);

  // The PC's chapter 10, read half an hour earlier, arrives afterwards.
  const pc = await api('PUT', `/api/progress/${e.id}`, {
    chapterUrl: chapter(10), chapterLabel: 'Ch. 10', page: 5, updatedAt: '2026-09-24T18:52:47.248Z',
  }, u.token);
  assert.equal(pc.status, 200, 'a stale bookmark is not an error');
  assert.equal(pc.body.stale, true);
  assert.equal(pc.body.chapterLabel, 'Ch. 12', 'the answer is what the account has');

  const rows = (await api('GET', '/api/progress', undefined, u.token)).body;
  assert.equal(rows[0].chapterLabel, 'Ch. 12');
  assert.equal(rows[0].page, 4);
});

test('a newer bookmark replaces an older one', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  await api('PUT', `/api/progress/${e.id}`, {
    chapterUrl: chapter(3), updatedAt: '2026-09-20T10:00:00.000Z',
  }, u.token);
  const r = await api('PUT', `/api/progress/${e.id}`, {
    chapterUrl: chapter(4), updatedAt: '2026-09-21T10:00:00.000Z',
  }, u.token);
  assert.equal(r.body.stale, undefined);
  assert.equal(r.body.chapterUrl, chapter(4));
  assert.equal(r.body.updatedAt, '2026-09-21 10:00:00', 'stored in the spelling datetime() writes');
});

test('a clock running ahead does not win for ever, and no moment means now', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  const ahead = await api('PUT', `/api/progress/${e.id}`, {
    chapterUrl: chapter(1), updatedAt: '2099-01-01T00:00:00.000Z',
  }, u.token);
  assert.ok(ahead.body.updatedAt < '2099', `stored ${ahead.body.updatedAt}`);
  // A client from before this change sends no moment at all: stamped now,
  // which is what it always got.
  const legacy = await api('PUT', `/api/progress/${e.id}`, { chapterUrl: chapter(2) }, u.token);
  assert.equal(legacy.body.stale, undefined);
  assert.equal(legacy.body.chapterUrl, chapter(2));
});

test('a stale bookmark on somebody else\'s entry is still a 404', async () => {
  const a = await newUser();
  const b = await newUser();
  const ea = await addEntry(a.token);
  await api('PUT', `/api/progress/${ea.id}`, { chapterUrl: chapter(9) }, a.token);
  const r = await api('PUT', `/api/progress/${ea.id}`, {
    chapterUrl: chapter(1), updatedAt: '2000-01-01T00:00:00.000Z',
  }, b.token);
  assert.equal(r.status, 404, 'the stale branch must not read another account\'s row');
});

// --- the client pulls first, and compares moments, not spellings -------------

test('a server row written the same day wins over an older local one', async () => {
  const local = entryFixture({ remoteId: 'r1', folder: 'reading', updatedAt: '2026-09-24T18:52:47.248Z' });
  const { core, storage } = bootCore({
    storage: { library: [local], authToken: 't' },
    fetch: async (url) => {
      const path = String(url).replace('https://api.test', '');
      if (path === '/api/library') {
        return json([{ ...local, id: 'r1', folder: 'paused', score: 6, updatedAt: '2026-09-24 19:17:41' }]);
      }
      if (path === '/api/progress') return json([]);
      return json({});
    },
  });
  await core.pullLibrary();
  assert.equal(storage().library[0].folder, 'paused', 'the later edit, from the other device');
  assert.equal(storage().library[0].score, 6);
});

test('a sync takes the other device\'s bookmark and sends back nothing it already has', async () => {
  const entry = entryFixture({ remoteId: 'r1' });
  const puts = [];
  const { core, storage } = bootCore({
    storage: {
      library: [entry],
      authToken: 't',
      progress: {
        [entry.sourceUrl]: {
          sourceUrl: entry.sourceUrl, chapterUrl: chapter(10), chapterLabel: 'Ch. 10', page: 5,
          updatedAt: '2026-09-24T18:52:47.248Z', syncedAt: '2026-09-24T18:52:47.248Z',
        },
      },
    },
    fetch: async (url, init) => {
      const path = String(url).replace('https://api.test', '');
      if (path === '/api/library' && !init?.method) return json([{ ...entry, id: 'r1' }]);
      if (path === '/api/progress' && !init?.method) {
        return json([{
          libraryId: 'r1', chapterUrl: chapter(12), chapterLabel: 'Ch. 12', page: 4,
          pageCount: 20, scrollPos: 0, updatedAt: '2026-09-24 19:17:40',
        }]);
      }
      if (init?.method === 'PUT' && path.startsWith('/api/progress/')) puts.push(JSON.parse(init.body));
      if (path.startsWith('/api/categories')) return json([]);
      if (path.startsWith('/api/history')) return json({ ok: true });
      return json({});
    },
  });
  const report = await core.syncAll();
  assert.equal(report.ok, true);
  assert.equal(storage().progress[entry.sourceUrl].chapterLabel, 'Ch. 12', 'the phone\'s chapter reached the PC');
  assert.deepEqual(puts, [], 'nothing the server already had was sent back to it');
});

test('a bookmark the server calls stale is replaced by the server\'s', async () => {
  const entry = entryFixture({ remoteId: 'r1' });
  const { core, storage } = bootCore({
    storage: { library: [entry], authToken: 't' },
    fetch: async (url, init) => {
      const path = String(url).replace('https://api.test', '');
      if (init?.method === 'PUT' && path === '/api/progress/r1') {
        return json({
          libraryId: 'r1', chapterUrl: chapter(12), chapterLabel: 'Ch. 12', page: 4,
          updatedAt: '2099-01-01 00:00:00', stale: true,
        });
      }
      return json({});
    },
  });
  await core.saveProgress({ sourceUrl: entry.sourceUrl, chapterUrl: chapter(10), chapterLabel: 'Ch. 10', page: 1 });
  const p = storage().progress[entry.sourceUrl];
  assert.equal(p.chapterLabel, 'Ch. 12');
  assert.equal(p.syncedAt, p.updatedAt, 'what came from the server is not sent to it again');
});

test('the moment a bookmark was written travels with it', async () => {
  const entry = entryFixture({ remoteId: 'r1' });
  let body = null;
  const { core } = bootCore({
    storage: { library: [entry], authToken: 't' },
    fetch: async (url, init) => {
      if (init?.method === 'PUT') body = JSON.parse(init.body);
      return json({ libraryId: 'r1', chapterUrl: chapter(3), updatedAt: '2025-01-01 00:00:01' });
    },
  });
  await core.saveProgress({ sourceUrl: entry.sourceUrl, chapterUrl: chapter(3), chapterLabel: 'Ch. 3' });
  assert.match(String(body?.updatedAt), /^\d{4}-\d{2}-\d{2}T/, 'the server cannot compare what it is not told');
});

test('a sync with the server down says so instead of "synced"', async () => {
  const { hub } = bootCore({ storage: { authToken: 't' } }); // no fetch: offline
  const r = await hub({ type: 'syncNow' });
  assert.equal(r.ok, false);
  assert.equal(r.offline, true);
});

test('a server answering 503 or 429 is unreachable to the reader, not a partial sync', async () => {
  for (const status of [503, 500, 429]) {
    const { hub } = bootCore({ storage: { authToken: 't' }, fetch: async () => json({ error: 'busy' }, status) });
    const r = await hub({ type: 'syncNow' });
    assert.equal(r.ok, false);
    assert.equal(r.offline, true, `${status} read as "incomplete"`);
    assert.equal(r.status, status);
  }
});

// --- when the server ends the session ----------------------------------------

test('an account closed from another device signs this one out and empties it', async () => {
  const entry = entryFixture({ remoteId: 'r1' });
  const { core, storage } = bootCore({
    storage: { library: [entry], authToken: 't', authUser: { id: 'u1', email: 'a@b.c' }, dataOwner: 'u1' },
    fetch: async () => json({ error: 'unknown user' }, 401),
  });
  const r = await core.syncAll();
  assert.equal(r.ok, false);
  assert.equal(r.signedOut, true);
  const s = storage();
  assert.equal(s.authToken, null);
  assert.deepEqual(s.library, [], 'a shelf outliving its account says the opposite of the privacy page');
  assert.equal(s.sessionEnded.reason, 'deleted');
  assert.equal((await core.getAccount()).sessionEnded.reason, 'deleted');
});

test('a retired token signs out and keeps the library', async () => {
  const entry = entryFixture({ remoteId: 'r1' });
  const { core, storage } = bootCore({
    storage: { library: [entry], authToken: 't', authUser: { id: 'u1' }, dataOwner: 'u1' },
    fetch: async () => json({ error: 'password changed — sign in again' }, 401),
  });
  await core.syncAll();
  const s = storage();
  assert.equal(s.authToken, null);
  assert.equal(s.library.length, 1, 'still the reader\'s; signing back in resumes it');
  assert.equal(s.sessionEnded.reason, 'expired');
});

test('a wrong password at sign-in is not a session ending', async () => {
  const { hub, storage } = bootCore({
    storage: { library: [entryFixture()] },
    fetch: async () => json({ error: 'invalid credentials' }, 401),
  });
  const r = await hub({ type: 'auth', kind: 'login', email: 'a@b.c', password: 'nope-nope', local: 'merge' });
  assert.ok(r.error);
  assert.equal(storage().sessionEnded, undefined);
  assert.equal(storage().library.length, 1);
});

// --- one device, two accounts --------------------------------------------------

const signIn = (id) => async (url) => {
  const path = String(url).replace('https://api.test', '');
  if (path.startsWith('/api/auth/')) return json({ token: `tok-${id}`, user: { id, email: `${id}@x.test` } });
  return json({});
};

test('another account signing in does not inherit the previous one\'s shelf', async () => {
  const { core, storage } = bootCore({
    storage: { library: [entryFixture({ remoteId: 'a1' })], history: { x: 1 }, dataOwner: 'user-a' },
    fetch: signIn('user-b'),
  });
  await core.authenticate('login', 'b@x.test', 'password-b');
  const s = storage();
  assert.deepEqual(s.library, []);
  assert.deepEqual(s.history, {});
  assert.equal(s.dataOwner, 'user-b');
});

test('the same account signing back in finds its shelf where it left it', async () => {
  const { core, storage } = bootCore({
    storage: { library: [entryFixture({ remoteId: 'a1' })], dataOwner: 'user-a' },
    fetch: signIn('user-a'),
  });
  await core.authenticate('login', 'a@x.test', 'password-a');
  assert.equal(storage().library.length, 1);
});

test('what was added signed out, by nobody, is adopted by whoever signs in', async () => {
  const { core, storage } = bootCore({
    storage: { library: [entryFixture()] },
    fetch: signIn('user-b'),
  });
  await core.authenticate('login', 'b@x.test', 'password-b');
  assert.equal(storage().library.length, 1);
});

// --- what was already here, asked about (report, arbitrage d) -----------------

/** A server that signs `id` in and answers every sync with an empty account. */
const account = (id) => async (url) => {
  const path = String(url).replace('https://api.test', '');
  if (path.startsWith('/api/auth/')) return json({ token: `tok-${id}`, user: { id, email: `${id}@x.test` } });
  if (path === '/api/library' || path === '/api/progress') return json([]);
  return json({});
};

test('a library made without an account is asked about before anyone signs in', async () => {
  const asked = [];
  const { hub, storage } = bootCore({
    storage: { library: [entryFixture()] },
    fetch: async (url) => { asked.push(String(url)); return json({}); },
  });
  const r = await hub({ type: 'auth', kind: 'login', email: 'b@x.test', password: 'password-b' });
  assert.equal(r.needsChoice, 'ownerless');
  assert.equal(r.series, 1);
  assert.equal(asked.length, 0, 'the server was asked before the reader was');
  assert.equal(storage().authToken, undefined);
});

test('"add it to this account" keeps the library and makes it the account\'s', async () => {
  const { hub, storage } = bootCore({ storage: { library: [entryFixture()] }, fetch: account('user-b') });
  const r = await hub({ type: 'auth', kind: 'login', email: 'b@x.test', password: 'pw', local: 'merge' });
  assert.equal(r.ok, true);
  assert.equal(storage().library.length, 1);
  assert.equal(storage().dataOwner, 'user-b');
});

test('"keep it separate" puts it aside, and signing out brings it back', async () => {
  const guest = entryFixture({ title: 'Guest Series' });
  const { hub, core, storage } = bootCore({ storage: { library: [guest], history: { h: 1 } }, fetch: account('user-b') });
  await hub({ type: 'auth', kind: 'login', email: 'b@x.test', password: 'pw', local: 'separate' });
  assert.deepEqual(storage().library, [], 'the guest library was mixed into the account');
  assert.equal(storage().guestShelf.library[0].title, 'Guest Series');

  const out = await core.logout();
  assert.equal(out.erased, true);
  assert.equal(out.restored, true);
  const s = storage();
  assert.deepEqual(s.library.map((e) => e.title), ['Guest Series']);
  assert.deepEqual(s.history, { h: 1 });
  assert.equal(s.dataOwner, null, 'it is nobody\'s again, as it was');
  assert.equal(s.guestShelf, null);
});

test('"erase it" signs in on an empty device', async () => {
  const { hub, storage } = bootCore({ storage: { library: [entryFixture()] }, fetch: account('user-b') });
  await hub({ type: 'auth', kind: 'login', email: 'b@x.test', password: 'pw', local: 'erase' });
  assert.deepEqual(storage().library, []);
  assert.equal(storage().guestShelf, undefined);
});

test('another account\'s unsent changes are named before they are erased', async () => {
  // QA, September 2026: B signed out with the server down, A signed in on the
  // same browser, and B's unsent changes were erased without a word.
  const kept = { library: [entryFixture()], dataOwner: 'user-b', dataOwnerEmail: 'b@x.test' };
  const { hub, storage } = bootCore({ storage: kept, fetch: account('user-a') });
  const r = await hub({ type: 'auth', kind: 'login', email: 'a@x.test', password: 'pw' });
  assert.equal(r.needsChoice, 'otherOwner');
  assert.equal(r.owner, 'b@x.test');
  assert.equal(storage().library.length, 1, 'erased before anyone said so');
  // "Separate" is not an answer here: they are somebody else's to send.
  assert.equal((await hub({ type: 'auth', kind: 'login', email: 'a@x.test', password: 'pw', local: 'separate' })).needsChoice, 'otherOwner');
  const ok = await hub({ type: 'auth', kind: 'login', email: 'a@x.test', password: 'pw', local: 'erase' });
  assert.equal(ok.ok, true);
  assert.deepEqual(storage().library, []);
  assert.equal(storage().dataOwner, 'user-a');
});

test('the same account signing back in is not asked anything', async () => {
  const kept = { library: [entryFixture()], dataOwner: 'user-b', dataOwnerEmail: 'b@x.test' };
  const { hub, storage } = bootCore({ storage: kept, fetch: account('user-b') });
  const r = await hub({ type: 'auth', kind: 'login', email: ' B@x.test ', password: 'pw' });
  assert.equal(r.ok, true);
  assert.equal(storage().library.length, 1);
});

test('signing out erases the device once the server has everything', async () => {
  const { core, storage } = bootCore({
    storage: { library: [entryFixture({ remoteId: 'r1' })], authToken: 't', authUser: { id: 'u1' }, dataOwner: 'u1' },
    fetch: async (url) => {
      const path = String(url).replace('https://api.test', '');
      if (path === '/api/library') return json([]);
      if (path === '/api/progress') return json([]);
      return json({});
    },
  });
  const r = await core.logout();
  assert.equal(r.synced, true);
  assert.equal(r.erased, true);
  assert.deepEqual(storage().library, []);
  assert.equal(storage().authToken, null);
});

test('signing out with the server down keeps what it could not send', async () => {
  const { core, storage } = bootCore({
    storage: { library: [entryFixture()], authToken: 't', authUser: { id: 'u1' }, dataOwner: 'u1' },
  });
  const r = await core.logout();
  assert.equal(r.synced, false);
  assert.equal(r.erased, false);
  assert.equal(storage().library.length, 1, 'nothing unsent is thrown away');
  assert.equal(storage().authToken, null);
  assert.equal(storage().dataOwner, 'u1', 'still marked as this account\'s, so nobody else takes it in');
});

test('a series page the server cannot read does not make signing out keep everything', async () => {
  // QA, September 2026: one entry with no cover, on a site that refuses the
  // server, turned every sync into "failed" — and logout keeps the device's
  // copy when the sync failed, so nothing was ever erased.
  const { core, storage } = bootCore({
    storage: {
      library: [entryFixture({ remoteId: 'r1', coverUrl: null, lastKnownChapter: null })],
      authToken: 't', authUser: { id: 'u1' }, dataOwner: 'u1',
    },
    fetch: async (url) => {
      const path = String(url).replace('https://api.test', '');
      if (path.startsWith('/api/meta/scrape')) return json({ error: 'could not fetch the page' }, 502);
      if (path === '/api/library' || path === '/api/progress') return json([]);
      return json({});
    },
  });
  const r = await core.logout();
  assert.equal(r.synced, true);
  assert.deepEqual(storage().library, []);
});

test('a series page that gave nothing is not asked again on every sync', async () => {
  const scrapes = [];
  const { core } = bootCore({
    storage: { library: [entryFixture({ remoteId: 'r1', coverUrl: null })], authToken: 't' },
    fetch: async (url) => {
      const path = String(url).replace('https://api.test', '');
      if (path.startsWith('/api/meta/scrape')) { scrapes.push(path); return json({ coverUrl: null, latestChapter: null }); }
      if (path === '/api/library' || path === '/api/progress') return json([{ ...entryFixture({ coverUrl: null }), id: 'r1' }].slice(0, 0));
      return json({});
    },
  });
  await core.syncAll();
  await core.syncAll();
  await core.syncAll();
  assert.equal(scrapes.length, 1, 'the same page was scraped on every sync');
});
