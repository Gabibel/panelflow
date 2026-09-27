// The detection rules, when the server is slow or away.
//
// A page asks for the rules before it looks for a chapter, so the time this
// takes is the time before the pill appears. The QA pass of September 2026
// measured seventeen seconds on a first visit with a slow server (B-19), and
// a fresh install with the server out of reach never showed the bookmark in a
// video player at all (B-17): nothing answered, and nothing fell back.
//
// So: a stale copy is answered at once and refreshed behind it; with nothing
// cached, the server gets a moment and then the copy the client ships answers
// instead; and a client that ships none (the store build of the phone app,
// which carries no list of sites) waits for the server as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootCore, json } from '../test-support/core.js';

const SERVER = { heuristics: { scoreThreshold: 50 }, domains: { 'from.server': {} } };
const SHIPPED = { heuristics: { scoreThreshold: 50 }, domains: { 'shipped.copy': {} } };

const rulesFetch = (answer) => async (url) => {
  if (!String(url).endsWith('/api/rules')) return json({});
  return answer();
};
const never = () => new Promise(() => {});

test('a stale copy is answered at once, and refreshed behind it', async () => {
  let served = 0;
  const { hub, storage } = bootCore({
    storage: { rulesCache: { rules: { domains: { 'old.copy': {} } }, fetchedAt: 0 } },
    fetch: rulesFetch(async () => { served++; return json(SERVER); }),
  });
  const r = await hub({ type: 'getRules' });
  assert.deepEqual(Object.keys(r.rules.domains), ['old.copy']);
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(served, 1, 'the stale copy was not refreshed');
  assert.deepEqual(Object.keys(storage().rulesCache.rules.domains), ['from.server']);
});

test('with nothing cached, a server that answers in time is the answer', async () => {
  const { hub } = bootCore({ fetch: rulesFetch(async () => json(SERVER)), bundledRules: async () => SHIPPED });
  const r = await hub({ type: 'getRules' });
  assert.deepEqual(Object.keys(r.rules.domains), ['from.server']);
});

test('with nothing cached and a slow server, the shipped copy answers within two seconds', async () => {
  const { hub } = bootCore({ fetch: rulesFetch(never), bundledRules: async () => SHIPPED });
  const started = Date.now();
  const r = await hub({ type: 'getRules' });
  assert.deepEqual(Object.keys(r.rules.domains), ['shipped.copy']);
  assert.ok(Date.now() - started < 2000, `answered after ${Date.now() - started} ms`);
});

test('with nothing cached and no server at all, the shipped copy answers', async () => {
  const { hub } = bootCore({ bundledRules: async () => SHIPPED });
  const r = await hub({ type: 'getRules' });
  assert.deepEqual(Object.keys(r.rules.domains), ['shipped.copy']);
});

test('a client that ships no copy waits for the server, and says null when there is none', async () => {
  const slow = bootCore({
    fetch: rulesFetch(() => new Promise((done) => setTimeout(() => done(json(SERVER)), 1700))),
  });
  assert.deepEqual(Object.keys((await slow.hub({ type: 'getRules' })).rules.domains), ['from.server']);
  const offline = bootCore({});
  assert.equal((await offline.hub({ type: 'getRules' })).rules, null);
});

test('the extension ships the rules file, and its worker reads it from the package', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const copy = readFileSync(join(root, 'extension', 'shared', 'detection-rules.json'), 'utf8');
  assert.equal(copy, readFileSync(join(root, 'shared', 'detection-rules.json'), 'utf8'));
  const worker = readFileSync(join(root, 'extension', 'background.js'), 'utf8');
  assert.match(worker, /bundledRules: \(\) => fetch\(chrome\.runtime\.getURL\('shared\/detection-rules\.json'\)\)/);
});
