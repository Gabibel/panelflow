// The remote rules and ad-block list: one request at a time, and never an
// empty list.
//
// How long a cold start waits, and what a stale copy answers, is
// rules-fallback.test.js. Here: a browser restoring ten tabs with an expired
// copy asked the server ten times at once (QA, October 2026), and an ad-block
// list that came back empty must never replace the one every client ships
// (TEST-1 in qa-sim/BUGS.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootCore, json } from '../test-support/core.js';

const RULES = { version: 12, domains: { '*.scan.test': {} } };
const LIST = { version: 6, entries: [{ host: 'ads.test', images: true }] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A backend that takes `ms` to answer, and counts how often it is asked. */
function slowBackend(ms) {
  const asked = [];
  const fetch = async (url) => {
    asked.push(String(url));
    await sleep(ms);
    if (String(url).endsWith('/api/rules')) return json(RULES);
    if (String(url).endsWith('/api/adblock')) return json(LIST);
    return json({}, 404);
  };
  return { fetch, asked };
}

test('a backend that answers in time is waited for', async () => {
  const backend = slowBackend(10);
  const { core } = bootCore({ fetch: backend.fetch });
  assert.deepEqual(await core.getRules(), RULES);
  assert.deepEqual(await core.getFilterList(), LIST);
});

test('ten questions at once are one request, and the next one after it is another', async () => {
  const backend = slowBackend(100);
  const { core, storage } = bootCore({ fetch: backend.fetch });
  const answers = await Promise.all(Array.from({ length: 10 }, () => core.getRules()));
  assert.ok(answers.every((r) => r?.version === 12));
  assert.equal(backend.asked.filter((u) => u.endsWith('/api/rules')).length, 1);
  await Promise.all(Array.from({ length: 10 }, () => core.getFilterList()));
  assert.equal(backend.asked.filter((u) => u.endsWith('/api/adblock')).length, 1);

  // Once it has answered, an expired copy is asked for again: the request in
  // flight is forgotten when it settles, not kept as the answer forever.
  const s = storage();
  const expired = bootCore({
    fetch: backend.fetch,
    storage: { rulesCache: { ...s.rulesCache, fetchedAt: 0 } },
  });
  await expired.core.getRules();
  await sleep(150);
  await expired.core.getRules();
  assert.equal(backend.asked.filter((u) => u.endsWith('/api/rules')).length, 2);
});

test('the ad-block list keeps its promise: never an empty list, null when there is none', async () => {
  const { core } = bootCore({ fetch: async () => json({ version: 7, entries: [] }) });
  assert.equal(await core.getFilterList(), null, 'an empty list must never replace the shipped one');
  // A server that never answers: null within the wait, the shipped list blocks.
  const silent = bootCore({ fetch: () => new Promise(() => {}) });
  const started = Date.now();
  assert.equal(await silent.core.getFilterList(), null);
  assert.ok(Date.now() - started < 2500, `waited ${Date.now() - started} ms`);
});
