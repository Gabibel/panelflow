// Without an account, nothing leaves the device that needs one.
//
// "Without an account, PanelFlow works entirely on this device" is on the
// sign-in page of every surface. The QA re-test of It.5 (N-A15) found the phone
// sending each series' address and title to the server at every launch — to
// fill in missing covers — and being refused, since the routes need an
// account. The core now keeps those requests on the device when there is no
// token; this file keeps its list of such routes the same as the server's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootCore, json } from '../test-support/core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

test('the core knows every route the server keeps for an account', () => {
  const server = read('backend', 'src', 'index.js');
  const guarded = [...server.matchAll(/app\.(?:use|get|post)\('(\/api\/[\w-]+)[^']*', requireAuth/g)].map((m) => m[1]);
  assert.ok(guarded.length >= 10, 'the server has no guarded routes where this test looks');
  const core = read('shared', 'panelflow-core.js');
  const list = core.slice(core.indexOf('const ACCOUNT_ONLY = ['), core.indexOf('];', core.indexOf('const ACCOUNT_ONLY = [')));
  const client = [...list.matchAll(/'(\/api\/[\w-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(client)].sort(), [...new Set(guarded)].sort());
});

test('signed out, a scrape, a cover search and a search stay on the device', async () => {
  const asked = [];
  const { hub } = bootCore({ fetch: async (url) => { asked.push(String(url)); return json({}); } });
  const scrape = await hub({ type: 'scrape', url: 'https://scan.test/manga/blue-box/' });
  const cover = await hub({ type: 'coverSearch', title: 'Blue Box', medium: 'manga' });
  assert.ok(scrape.error && cover.error, 'a refusal is still an answer the caller can read');
  assert.equal(scrape.offline, undefined, 'signed out is not offline');
  assert.deepEqual(asked.filter((u) => /\/api\/(meta|search)/.test(u)), []);
  // The rules, which every surface needs signed in or not, still go.
  await hub({ type: 'getRules' });
  assert.ok(asked.some((u) => u.endsWith('/api/rules')));
});

test('signed in, the same requests go to the server', async () => {
  const asked = [];
  const { hub } = bootCore({
    storage: { authToken: 'tok', authUser: { id: 'u', email: 'r@example.test' }, dataOwner: 'u' },
    fetch: async (url) => { asked.push(String(url)); return json({ coverUrl: null }); },
  });
  await hub({ type: 'scrape', url: 'https://scan.test/manga/blue-box/' });
  assert.ok(asked.some((u) => u.includes('/api/meta/scrape?url=')));
});
