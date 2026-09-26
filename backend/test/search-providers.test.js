// One search, wherever it is asked from and whoever answers it.
//
// The audit's finding: search was not the same on every surface, because the
// only searcher was a server route that DuckDuckGo refuses from a datacenter.
// Three things fix that, and each has a test here:
//   * the parser is shared (shared/search.js), so a result is one shape;
//   * the server has a second provider, Brave, behind a key;
//   * the phone asks the engine itself, through `searchFetch`, and the hub
//     falls back to the server when that fails.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBrave, parseDuckDuckGo, scanQuery } from '../src/search.js';
import { braveResults } from '../src/routes/search.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// --- the shared parser ----------------------------------------------------------

test('Brave and DuckDuckGo come out as the same shape', () => {
  const ddg = parseDuckDuckGo(
    '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fscan.test%2Fblue-box%2F">Blue Box - Scan VF</a>',
  );
  const brave = parseBrave({ web: { results: [{ title: 'Blue Box - Scan VF', url: 'https://scan.test/blue-box/' }] } });
  assert.deepEqual(ddg, brave);
  assert.deepEqual(Object.keys(ddg[0]).sort(), ['domain', 'title', 'url']);
  assert.equal(ddg[0].domain, 'scan.test');
});

test('Brave results are deduped, capped, and only http(s)', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ title: `T${i}`, url: `https://s.test/${i}` }));
  assert.equal(parseBrave({ web: { results: many } }).length, 20);
  const r = parseBrave({ web: { results: [
    { title: 'A', url: 'https://s.test/a' }, { title: 'A again', url: 'https://s.test/a' },
    { title: 'Bad', url: 'javascript:alert(1)' }, { title: '', url: 'https://s.test/untitled' },
  ] } });
  assert.deepEqual(r.map((x) => x.url), ['https://s.test/a']);
  assert.deepEqual(parseBrave(null), []);
  assert.deepEqual(parseBrave({ web: {} }), []);
});

test('the server asks Brave with the key, and reports its refusal as 502', async () => {
  process.env.PANELFLOW_BRAVE_KEY = 'k-test';
  try {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ web: { results: [{ title: 'X', url: 'https://s.test/x' }] } }) };
    };
    const r = await braveResults('blue box', undefined, fetchImpl);
    assert.equal(r[0].url, 'https://s.test/x');
    assert.match(calls[0].url, /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=blue%20box/);
    assert.equal(calls[0].init.headers['X-Subscription-Token'], 'k-test');

    await assert.rejects(
      () => braveResults('x', undefined, async () => ({ ok: false, status: 429 })),
      (e) => e.status === 502,
    );
  } finally {
    delete process.env.PANELFLOW_BRAVE_KEY;
  }
});

// --- the phone's direct path, through the hub ----------------------------------

/** A core with the shared scripts loaded and a stand-in for the phone's fetch. */
function coreWith({ searchFetch, apiFetch }) {
  const box = { console: { ...console, warn() {} }, crypto: globalThis.crypto, URL, URLSearchParams };
  box.globalThis = box;
  for (const f of ['series-match.js', 'search.js', 'panelflow-core.js']) {
    new Function('globalThis', 'self', readFileSync(join(root, 'shared', f), 'utf8')).call(box, box, box);
  }
  const local = { settings: { backendUrl: 'https://api.test' }, rulesCache: null };
  const core = box.PanelFlowCore.createCore({
    storage: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in local).map((k) => [k, local[k]])),
      set: async (o) => Object.assign(local, o),
    },
    // Every server call the core makes goes through this.
    fetch: async (url, init) => apiFetch(url, init),
    searchFetch,
  });
  const hub = box.PanelFlowCore.createHub(core, {});
  return { core, hub };
}

const page = (hits) => hits.map(([u, t]) => `<a class="result__a" href="${u}">${t}</a>`).join('\n');
const json = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) });

test('the phone searches from its own address and never asks the server for results', async () => {
  const served = [];
  const { hub } = coreWith({
    searchFetch: async (url) => {
      served.push(url);
      return page([['https://scan.test/blue-box/', 'Blue Box']]);
    },
    apiFetch: async (url) => {
      // The rules the parser cleans titles with; nothing else may be asked.
      if (/\/api\/rules/.test(url)) return json({ domains: {} });
      throw new Error(`the server was asked: ${url}`);
    },
  });
  const r = await hub({ type: 'search', q: 'blue box', scans: true });
  assert.equal(r.provider, 'device');
  assert.equal(r.query, scanQuery('blue box'));
  assert.deepEqual(r.results.map((x) => x.url), ['https://scan.test/blue-box/']);
  assert.match(served[0], /^https:\/\/html\.duckduckgo\.com\/html\/\?q=blue%20box%20scan/);
});

test('when the engine refuses the phone, the server is asked instead', async () => {
  const asked = [];
  const { hub } = coreWith({
    searchFetch: async () => { throw new Error('search engine answered 403'); },
    apiFetch: async (url) => {
      asked.push(url);
      if (/\/api\/rules/.test(url)) return json({ domains: {} });
      return json({ query: 'blue box', results: [{ title: 'Blue Box', url: 'https://scan.test/b/', domain: 'scan.test' }], provider: 'duckduckgo' });
    },
  });
  const r = await hub({ type: 'search', q: 'blue box' });
  assert.equal(r.provider, 'duckduckgo');
  assert.ok(asked.some((u) => /\/api\/search\?q=blue\+box/.test(u)), 'the server route was not the fallback');
});

test('a shell with no way to fetch the engine goes straight to the server', async () => {
  const asked = [];
  const { hub } = coreWith({
    searchFetch: undefined,
    apiFetch: async (url) => { asked.push(url); return json({ query: 'x', results: [], provider: 'duckduckgo' }); },
  });
  await hub({ type: 'search', q: 'x' });
  assert.ok(asked.some((u) => /\/api\/search/.test(u)));
});

test('the phone hands the hub a fetch with a browser\'s headers, and the shared file is on its list', () => {
  const core = readFileSync(join(root, 'native', 'src', 'core.js'), 'utf8');
  assert.match(core, /searchFetch: async \(url\)/);
  assert.match(core, /'User-Agent': 'Mozilla\/5\.0 \(iPhone/);
  assert.match(core, /generated\/shared\/search\.js/);
  assert.match(readFileSync(join(root, 'scripts', 'sync-shared.mjs'), 'utf8'), /'compat\.js', 'search\.js',\s*'report\.js'\]/);
});
