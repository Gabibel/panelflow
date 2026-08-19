// Settings that belong to the reader, and the one rule that makes them safe.
//
// The rule: the account stores only the questions that have been answered. A
// device signing in has to be able to tell "this account keeps the reader
// light" from "this account has never been asked", because in the second case
// the device's own settings are the better answer. An endpoint that helpfully
// filled in defaults would make every first sign-in look like an instruction,
// and the reader would watch their own settings be overwritten by a shrug.
//
// The rest is the usual: one account cannot read another's, a patch merges
// rather than replaces, and a value that is not on the list does not get stored
// just because a client sent it — these travel from one device to another, so
// "whatever arrived" is not a shape.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, shutdown } from '../test-support/harness.js';
import { clean, withDefaults, cleanHost, KEYS, MAX_HOSTS } from '../src/prefs.js';

after(shutdown);

const get = async (token) => (await api('GET', '/api/prefs', undefined, token)).body;
const put = (token, prefs) => api('PUT', '/api/prefs', { prefs }, token);

test('an account that has never been asked answers nothing, not defaults', async () => {
  const a = await newUser();
  const body = await get(a.token);
  assert.deepEqual(body.prefs, {}, 'a first sign-in would read this as an instruction');
  assert.equal(body.updatedAt, null);
});

test('a patch merges into what is there, and only names what it changed', async () => {
  const a = await newUser();
  await put(a.token, { theme: 'dark', readerMode: 'rtl' });
  await put(a.token, { theme: 'light' });
  const { prefs } = await get(a.token);
  // The phone knows about four settings and the options page about ten. A PUT
  // that replaced would let the phone delete the six it has never heard of.
  assert.deepEqual(prefs, { theme: 'light', readerMode: 'rtl' });
});

test('the answers are the account holder’s, and nobody else can see them', async () => {
  const a = await newUser();
  const b = await newUser();
  await put(a.token, { theme: 'dark' });
  assert.deepEqual((await get(b.token)).prefs, {});
  assert.equal((await api('GET', '/api/prefs')).status, 401, 'signed out reads somebody’s settings');
});

test('a value that is not on the list is refused by name, and the rest still lands', async () => {
  const a = await newUser();
  const r = await put(a.token, { theme: 'dark', tapZones: 'everywhere' });
  assert.equal(r.status, 200);
  assert.equal(r.body.prefs.theme, 'dark', 'one bad value stopped a good one in the same request');
  assert.ok(!('tapZones' in r.body.prefs));
  assert.match(r.body.refused.join(' '), /tapZones must be one of sides, edges, off/);
});

test('a patch with nothing storable in it is an error, not a silent tick', async () => {
  const a = await newUser();
  const r = await put(a.token, { tapZones: 'everywhere' });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /tapZones/);
});

test('a key this version has never heard of is dropped, not refused', async () => {
  // An older server and a newer phone: the phone sends a setting that does not
  // exist here yet, in the same request as a theme. Refusing the body would
  // mean the theme never changes and nothing on screen says why.
  const a = await newUser();
  const r = await put(a.token, { theme: 'dark', panelGutterWidth: 12 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.prefs, { theme: 'dark' });
  assert.ok(!r.body.refused, 'an unknown key was reported as a mistake');
});

test('every setting on the list survives a round trip', async () => {
  const a = await newUser();
  const all = {
    theme: 'dark',
    uiLang: 'fr',
    readerMode: 'spread-rtl',
    tapZones: 'edges',
    autoShow: true,
    autoNext: true,
    hideRead: true,
    readerDark: false,
    checkIntervalMin: 720,
    whitelist: ['example.com'],
  };
  // If a setting is added to shared/prefs.js and not to this object, that is
  // the failure — a setting nothing has ever stored end to end.
  assert.deepEqual(Object.keys(all).sort(), [...KEYS].sort());
  const r = await put(a.token, all);
  assert.deepEqual(r.body.prefs, all);
  assert.ok(r.body.updatedAt, 'nothing recorded when this was last changed');
});

// --- the shape rules, without a server --------------------------------------

test('a hostname is taken as it was pasted, and kept as a hostname', () => {
  // People paste the address bar. Refusing that teaches nothing; it just makes
  // the box feel broken.
  assert.equal(cleanHost('HTTPS://WWW.Example.com/series/1?x=2'), 'example.com');
  assert.equal(cleanHost('example.com:8080'), 'example.com');
  for (const bad of ['', '   ', 'not a host', 'localhost', 'under_score.com', 'a'.repeat(300) + '.com']) {
    assert.equal(cleanHost(bad), null, `${JSON.stringify(bad)} was stored as a hostname`);
  }
});

test('the whitelist is deduped and capped', () => {
  const { prefs } = clean({ whitelist: ['a.com', 'www.a.com', 'https://a.com/x'] });
  assert.deepEqual(prefs.whitelist, ['a.com'], 'two devices editing from either end grow a second copy');
  const many = clean({ whitelist: Array.from({ length: 500 }, (_, i) => `s${i}.com`) });
  assert.equal(many.prefs.whitelist.length, MAX_HOSTS);
});

test('a checkbox is a boolean and not a truthy thing', () => {
  // 'false', 0 and '' all arrive from a client that built a form value by hand,
  // and every one of them means the opposite of what a truthiness test says.
  for (const value of ['true', 'false', 1, 0, '', null]) {
    assert.deepEqual(clean({ autoNext: value }).prefs, {}, `${JSON.stringify(value)} was stored as a checkbox`);
  }
  assert.deepEqual(clean({ autoNext: false }).prefs, { autoNext: false },
    'false is an answer, and dropping it is how a checkbox refuses to be unticked');
});

test('withDefaults is for drawing a control, and says so by filling every key', () => {
  const full = withDefaults({ theme: 'dark' });
  assert.equal(full.theme, 'dark');
  assert.equal(full.readerDark, true, 'the reader was dark before this setting existed');
  assert.deepEqual(Object.keys(full).sort(), [...KEYS].sort());
});

test('the address of the server is not one of these', () => {
  // It cannot be: it is the address of the server that would hold it. A client
  // that sent it must not be able to hand every other device a URL.
  assert.ok(!KEYS.includes('backendUrl'));
  assert.deepEqual(clean({ backendUrl: 'https://evil.example' }).prefs, {});
});
