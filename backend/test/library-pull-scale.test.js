// A large library, pulled by a device that has just signed in.
//
// NEW-9, measured twice: a 5000-series library took about 73 seconds to reach
// a freshly signed-in extension, whose popup then opened in half a second. The
// time was not the network. The library arrives in one response; it was the
// merge that followed, which looked every server row up in the local library
// by walking it (findEntry), against a library growing to 5000 as it went:
// twelve million comparisons, each of them parsing two URLs.
//
// The merge now files the library once (indexLibrary in shared/
// panelflow-core.js). The first test holds it to a budget against the real
// server; the two after it hold it to the answers the walk used to give, which
// is what made the swap safe to make.
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { base, newUser, shutdown } from '../test-support/harness.js';
import { db } from '../src/db.js';
import { bootCore, json, entryFixture } from '../test-support/core.js';

test.after(shutdown);

const SERIES = 5000;

// Measured where this was written: about 47 seconds before the fix, about 0.2
// after, for the same pull against this server. The budget sits far from both,
// so a slow machine passes and a merge that went quadratic again cannot.
const BUDGET_MS = 10_000;

/** `n` series on an account, written in one go, spread over forty sites. */
async function seed(userId, n) {
  const statements = [];
  for (let i = 0; i < n; i++) {
    const host = `scan-site-${i % 40}.test`;
    statements.push({
      sql: `INSERT INTO library (id, user_id, title, source_domain, source_url, cover_url,
              last_known_chapter)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [crypto.randomUUID(), userId, `Series ${i}`, host,
        `https://${host}/manga/a-series-with-a-long-title-${i}/`,
        `https://${host}/covers/${i}.jpg`, String(100 + (i % 50))],
    });
  }
  for (let i = 0; i < statements.length; i += 1000) await db.batch(statements.slice(i, i + 1000));
}

test('a 5000-series library reaches a freshly signed-in device in seconds, not minutes', async (t) => {
  const user = await newUser();
  await seed(user.id, SERIES);
  const { core, storage } = bootCore({
    storage: { settings: { backendUrl: base } },
    fetch: (url, init) => fetch(url, init),
  });
  await core.authenticate('login', user.email, 'password123');

  const started = performance.now();
  const { added } = await core.pullLibrary();
  const ms = performance.now() - started;
  t.diagnostic(`${SERIES} series pulled in ${Math.round(ms)} ms`);

  assert.equal(added, SERIES);
  const library = storage().library;
  assert.equal(library.length, SERIES);
  assert.equal(new Set(library.map((e) => e.remoteId)).size, SERIES,
    'two series were folded into one on the way in');
  assert.ok(ms < BUDGET_MS, `the pull took ${Math.round(ms)} ms; the merge has gone quadratic again`);
});

// --- the same answers as the walk --------------------------------------------

/** A backend that answers a pull with `rows`, and an empty "continue" list. */
const pullingFrom = (rows) => async (url) => {
  const path = String(url).replace('https://api.test', '');
  if (path === '/api/library') return json(rows);
  if (path === '/api/progress/continue') return json([]);
  return json({});
};

const row = (over) => ({ title: 'Ao no Hako', tags: [], ...over });

test('a series moved elsewhere does not swallow a later one at its old address', async () => {
  // Why the index refiles an entry a pull changes. The first row moves the
  // local entry to another site (it was migrated on another device); the
  // second is the old site, added back since. A walk sees the entry at its new
  // address and keeps both. An index that still had it at the old one would
  // fold the second row into it, and the series on the old site would be lost.
  const local = entryFixture({
    remoteId: 'r1',
    sourceUrl: 'https://old-scan.test/manga/ao-no-hako',
    updatedAt: '2024-01-01T00:00:00.000Z',
  });
  const { core, storage } = bootCore({
    storage: { library: [local], authToken: 't' },
    fetch: pullingFrom([
      row({ id: 'r1', sourceDomain: 'new-scan.test', sourceUrl: 'https://new-scan.test/manga/ao-no-hako',
        updatedAt: '2025-03-01T00:00:00.000Z' }),
      row({ id: 'r2', sourceDomain: 'old-scan.test', sourceUrl: 'https://old-scan.test/manga/ao-no-hako',
        updatedAt: '2025-02-01T00:00:00.000Z' }),
    ]),
  });

  assert.deepEqual(await core.pullLibrary(), { added: 1, updated: 1 });
  const library = storage().library;
  assert.equal(library.length, 2);
  assert.equal(library.find((e) => e.remoteId === 'r1').sourceUrl, 'https://new-scan.test/manga/ao-no-hako');
  assert.equal(library.find((e) => e.remoteId === 'r2').sourceUrl, 'https://old-scan.test/manga/ao-no-hako');
});

test('when two entries could take a server row, the earlier one in the library does', async () => {
  // findEntry is `library.find`, so the first entry of a series wins even when
  // a later one has the very address. Which of two duplicates a pull updates is
  // settled by dedupeLibrary afterwards, not here, and the index must not
  // quietly start choosing differently.
  const first = entryFixture({ id: 'first', sourceUrl: 'https://a.test/manga/x/chapitre-1',
    updatedAt: '2024-01-01T00:00:00.000Z' });
  const second = entryFixture({ id: 'second', sourceUrl: 'https://a.test/manga/x',
    updatedAt: '2024-01-01T00:00:00.000Z' });
  const { core, storage } = bootCore({
    storage: { library: [first, second], authToken: 't' },
    fetch: pullingFrom([row({ id: 'r1', sourceDomain: 'a.test', sourceUrl: 'https://a.test/manga/x',
      updatedAt: '2025-01-01T00:00:00.000Z' })]),
  });

  await core.pullLibrary();
  const library = storage().library;
  assert.equal(library.find((e) => e.id === 'first').remoteId, 'r1');
  assert.equal(library.find((e) => e.id === 'second').remoteId, undefined);
});
