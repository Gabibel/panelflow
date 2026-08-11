// Ad blocking, from the one list to the three engines that enforce it.
//
// The failure this file is written against is not "an ad got through". It is
// the quiet one: a list that silently stops blocking. Every path below that
// could end in an empty rule set is pinned to fall back to the previous one
// instead, because a user whose backend is down should notice nothing at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { flatten, toDnr, allowRules } from '../src/adblock.js';
import { loadFilterList } from '../src/routes/rules.js';
import { toSafari, generated, listPath } from '../../scripts/build-adblock.mjs';
import { api, shutdown } from '../test-support/harness.js';
import { bootWorker } from '../test-support/worker.js';

const repo = join(import.meta.dirname, '..', '..');
const read = (...p) => readFileSync(join(repo, ...p), 'utf8');
const SHIPPED = JSON.parse(readFileSync(listPath, 'utf8'));

test.after(shutdown);

// --- the list itself -------------------------------------------------------

test('the shipped list flattens to hosts nobody has to look at twice', () => {
  const { version, entries } = flatten(SHIPPED);
  assert.ok(version >= 2, 'the version is what a client compares against');
  assert.ok(entries.length >= 40, `a filter list of ${entries.length} hosts is a placeholder`);
  const hosts = entries.map((e) => e.host);
  assert.equal(new Set(hosts).size, hosts.length, 'a host is listed twice');
  for (const host of hosts) {
    assert.match(host, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/,
      `${host} is not a bare hostname — a pattern here becomes a rule Android cannot read`);
  }
});

test('nothing a manga site needs is on the list', () => {
  // The list is written by hand and the cost of a wrong entry is a site that
  // will not load its own pages, reported as "the reader is broken".
  const hosts = flatten(SHIPPED).entries.map((e) => e.host);
  for (const safe of ['cloudflare.com', 'jsdelivr.net', 'googleapis.com', 'gstatic.com',
    'cloudfront.net', 'akamaized.net', 'imgur.com', 'blogspot.com', 'wp.com']) {
    assert.ok(!hosts.includes(safe), `${safe} serves site assets and must not be blocked`);
  }
});

test('a flat list survives a round trip, so a client can hand back what it got', () => {
  const once = flatten(SHIPPED);
  assert.deepEqual(flatten(once), once);
});

test('junk flattens to an empty list rather than throwing', () => {
  for (const junk of [null, {}, { groups: null }, { entries: 'no' }, { groups: { a: {} } }]) {
    assert.deepEqual(flatten(junk).entries, []);
  }
});

// --- the rules the engines get ---------------------------------------------

test('every host becomes a block rule, and image types only where the group says so', () => {
  const list = flatten(SHIPPED);
  const rules = toDnr(list);
  assert.equal(rules.length, list.entries.length);
  const byHost = new Map(rules.map((r) => [r.condition.urlFilter, r]));
  for (const e of list.entries) {
    const rule = byHost.get(`||${e.host}^`);
    assert.ok(rule, `${e.host} has no rule`);
    assert.equal(rule.action.type, 'block');
    assert.equal(rule.condition.resourceTypes.includes('image'), e.images,
      `${e.host} blocks images when its group does not say to, or the other way round`);
    for (const t of ['script', 'sub_frame', 'xmlhttprequest']) {
      assert.ok(rule.condition.resourceTypes.includes(t), `${e.host} lets ${t} through`);
    }
  }
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length, 'two rules share an id');
});

test('block ids and whitelist ids cannot collide', () => {
  // They are installed in one call, and Chrome rejects the whole call — not
  // the offending rule — if an id repeats. That would take the blocking down.
  const blocks = toDnr(flatten(SHIPPED)).map((r) => r.id);
  const allows = allowRules(Array.from({ length: 200 }, (_, i) => `site${i}.test`)).map((r) => r.id);
  assert.equal(blocks.filter((id) => allows.includes(id)).length, 0);
});

test('the whitelist exempts what the site loads, not what the site is', () => {
  const [rule] = allowRules(['example.com']);
  assert.equal(rule.action.type, 'allowAllRequests');
  assert.deepEqual(rule.condition.requestDomains, ['example.com']);
  assert.deepEqual(rule.condition.resourceTypes, ['main_frame', 'sub_frame']);
  // Beating a block rule is the entire point: a tie would leave the user's
  // own setting losing to the list they were trying to overrule.
  assert.ok(rule.priority > toDnr(flatten(SHIPPED))[0].priority);
});

test('a whitelist entry is taken as the user meant it, not as they typed it', () => {
  const rules = allowRules([' https://WWW.Example.com/manga/x ', 'other.test:8080', '', '  ']);
  assert.deepEqual(rules.map((r) => r.condition.requestDomains[0]), ['example.com', 'other.test']);
});

test('an empty whitelist installs nothing', () => {
  for (const empty of [undefined, null, [], ['']]) assert.deepEqual(allowRules(empty), []);
});

// --- the generated files ---------------------------------------------------

test('the generated lists are in sync with the source', () => {
  // The same guard `shared sources are in sync` gives the copied files. These
  // are translations rather than copies, which is exactly why hand-editing one
  // is tempting and why it has to fail here.
  for (const { path, content } of generated()) {
    const rel = path.slice(repo.length + 1).replace(/\\/g, '/');
    assert.equal(readFileSync(path, 'utf8'), content,
      `${rel} is stale or was edited by hand — run \`npm run sync:shared\``);
  }
});

test('Safari gets the same hosts, anchored', () => {
  const rules = toSafari(SHIPPED);
  assert.equal(rules.length, flatten(SHIPPED).entries.length,
    'the Safari list drifted from the Chrome one, which is how it was written by hand');
  const filters = rules.map((r) => r.trigger['url-filter']);
  const adsterra = filters.find((f) => f.includes('adsterra'));
  const re = new RegExp(adsterra);
  assert.ok(re.test('https://cdn.adsterra.com/x.js'), 'a subdomain of a blocked host');
  assert.ok(re.test('https://adsterra.com/x.js'), 'the host itself');
  assert.ok(!re.test('https://example.com/?ref=adsterra.com/x'),
    'an unanchored filter blocks any URL that merely mentions the host');
  for (const f of filters) {
    assert.ok(!f.includes('(?:'), 'WebKit does not implement non-capturing groups');
    assert.ok(!f.includes('[^'), 'WebKit does not implement negated character classes');
  }
});

test("Android can still read every rule out of Chrome's file", () => {
  // AdBlockList.kt takes `||host^` and skips anything else, on the grounds that
  // half-applying a pattern blocks more than the rule meant. A generator that
  // emitted patterns would therefore silently shrink the Android list.
  const dnr = JSON.parse(read('extension', 'rules', 'adblock.json'));
  const kotlin = read('android', 'app', 'src', 'main', 'java', 'dev', 'panelflow', 'AdBlockList.kt');
  assert.ok(kotlin.includes('rules/adblock.json'), 'Android reads a different file now');
  for (const rule of dnr) {
    const f = rule.condition.urlFilter;
    assert.match(f, /^\|\|[a-z0-9.-]+\^$/, `Android would skip ${f}`);
  }
});

// --- the endpoint ----------------------------------------------------------

test('the list is served to anyone, signed in or not', async () => {
  const r = await api('GET', '/api/adblock', undefined, null);
  assert.equal(r.status, 200);
  assert.equal(r.body.version, flatten(SHIPPED).version);
  assert.ok(r.body.entries.length > 0);
  assert.deepEqual(r.body.entries[0], flatten(SHIPPED).entries[0]);
});

test('the served list is cacheable, because it changes about never', async () => {
  const r = await api('GET', '/api/adblock');
  assert.match(r.headers.get('cache-control') || '', /max-age=\d+/);
});

test('the detection rules advertise the filter list version that actually exists', async () => {
  // The number used to be typed into detection-rules.json by hand, where it sat
  // at 1 through every change to the list.
  const r = await api('GET', '/api/rules');
  assert.equal(r.status, 200);
  assert.equal(r.body.filterListVersion, loadFilterList().version);
});

test('the source list is not shipped raw — clients get it flat', async () => {
  // The grouping exists for whoever maintains the file. A client reading
  // `groups` would be a second flattener, in a language with no tests here.
  const r = await api('GET', '/api/adblock');
  assert.equal(r.body.groups, undefined);
  assert.ok(Array.isArray(r.body.entries));
});

// --- what the extension does with it ---------------------------------------

/** A newer list than the one bundled, small enough to assert on rule by rule. */
const REMOTE = {
  version: 99,
  entries: [{ host: 'ads.test', images: true }, { host: 'track.test', images: false }],
};

/** A backend that serves `list` at /api/adblock and is offline for everything else. */
const serving = (list) => async (url) => {
  if (!String(url).includes('/api/adblock')) throw new Error('offline');
  return { ok: true, status: 200, json: async () => list };
};

/** Boot a worker with these settings and run the install listeners it registers. */
async function installed(settings, fetchImpl) {
  const w = bootWorker({
    storage: { settings: { backendUrl: 'https://api.test', ...settings } },
    fetch: fetchImpl,
  });
  for (const f of w.listeners.installed) await f();
  return w;
}

const hostsBlocked = (w) => w.dnr().dynamic
  .filter((r) => r.action.type === 'block')
  .map((r) => r.condition.urlFilter);

test('the fetched list replaces the bundled one rather than piling on top of it', async () => {
  const w = await installed({}, serving(REMOTE));
  assert.deepEqual(hostsBlocked(w), ['||ads.test^', '||track.test^']);
  // Not disabling the bundled ruleset would leave a host removed upstream
  // blocked forever, which is the whole reason the list is remote.
  assert.equal(w.dnr().staticEnabled, false);
});

test('a backend that is down leaves the user blocking exactly what they blocked before', async () => {
  const w = await installed({});                   // no fetch at all
  assert.deepEqual(hostsBlocked(w), []);
  assert.equal(w.dnr().staticEnabled, true, 'the bundled list has to stay in force');
});

test('a reply with no hosts in it is not a list that blocks nothing', async () => {
  // The dangerous shape: a 200 with an empty body reads as "block nothing" and
  // would turn ad blocking off silently for everyone.
  for (const bad of [{ version: 99, entries: [] }, {}, null]) {
    const w = await installed({}, serving(bad));
    assert.equal(w.dnr().staticEnabled, true);
    assert.deepEqual(hostsBlocked(w), []);
  }
});

test('the whitelist is honoured whether or not the fetched list arrived', async () => {
  for (const fetchImpl of [serving(REMOTE), undefined]) {
    const w = await installed({ whitelist: ['example.com'] }, fetchImpl);
    const allow = w.dnr().dynamic.find((r) => r.action.type === 'allowAllRequests');
    assert.ok(allow, 'the exemption the user asked for was never installed');
    assert.deepEqual(allow.condition.requestDomains, ['example.com']);
  }
});

test('saving the options page takes effect without restarting the browser', async () => {
  // The bug this is written against: the whitelist was stored by the options
  // page and read by nobody in Chrome, so a user could exempt a site and watch
  // it keep being blocked until they reinstalled the extension.
  const w = await installed({}, serving(REMOTE));
  assert.equal(w.dnr().dynamic.some((r) => r.action.type === 'allowAllRequests'), false);

  await w.send({ type: 'setSettings', patch: { whitelist: ['late.test'] } });
  const allow = w.dnr().dynamic.find((r) => r.action.type === 'allowAllRequests');
  assert.ok(allow, 'the settings change never reached the rules');
  assert.deepEqual(allow.condition.requestDomains, ['late.test']);
});

test('removing a site from the whitelist starts blocking it again', async () => {
  const w = await installed({ whitelist: ['gone.test'] }, serving(REMOTE));
  await w.send({ type: 'setSettings', patch: { whitelist: [] } });
  assert.equal(w.dnr().dynamic.some((r) => r.action.type === 'allowAllRequests'), false);
  // and the blocking that was there all along is still there
  assert.deepEqual(hostsBlocked(w), ['||ads.test^', '||track.test^']);
});

test('re-applying does not accumulate rules', async () => {
  // Every trigger — install, browser start, the alarm, a settings save — runs
  // the same code, and Chrome caps dynamic rules. Rules that were added rather
  // than replaced would climb until the cap refused the lot.
  const w = await installed({ whitelist: ['a.test'] }, serving(REMOTE));
  const first = w.dnr().dynamic.length;
  for (let i = 0; i < 5; i++) await w.send({ type: 'setSettings', patch: { note: i } });
  assert.equal(w.dnr().dynamic.length, first);
});

test('the list is fetched once, not on every settings save', async () => {
  const w = await installed({}, serving(REMOTE));
  const fetches = () => w.calls.filter((c) => c.url.includes('/api/adblock')).length;
  assert.equal(fetches(), 1);
  for (let i = 0; i < 3; i++) await w.send({ type: 'setSettings', patch: { note: i } });
  assert.equal(fetches(), 1, 'the cached list has a TTL for a reason');
});

test('the bundled ruleset is registered under the id the worker disables', () => {
  // A rename in the manifest would leave the worker disabling nothing and both
  // lists blocking at once — which looks fine until a host is removed.
  const manifest = JSON.parse(read('extension', 'manifest.json'));
  const ruleset = manifest.declarative_net_request.rule_resources
    .find((r) => r.path === 'rules/adblock.json');
  assert.ok(ruleset, 'the bundled list is no longer registered');
  assert.equal(ruleset.id, 'adblock_base');
  assert.ok(read('extension', 'background.js').includes("'adblock_base'"));
});
