// Where a setting lives on a device, and which answer wins.
//
// `project` and `split` in shared/prefs.js are the one place that rule is
// written, since the extension's worker and the phone's client both used to
// carry a copy and the phone's drifted. Every case below is a question one of
// the two surfaces once answered on its own — and the one that mattered most,
// "a first sign-in must not overwrite a device's settings with a shrug", is
// the first test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { project, split, READER_KEYS, KEYS } from '../src/prefs.js';

test('the account wins where it has an answer, and only there', () => {
  const p = project({
    account: { theme: 'dark', tapZones: 'edges' },
    local: { readerMode: 'ltr', readerPrefs: { tapZones: 'off', autoNext: true } },
    install: { checkIntervalMin: 180 },
  });
  assert.equal(p.theme, 'dark');
  assert.equal(p.tapZones, 'edges', 'the account answered and lost');
  assert.equal(p.autoNext, true, 'the device answered, the account did not, and the device lost');
  assert.equal(p.readerMode, 'ltr');
  assert.equal(p.checkIntervalMin, 180);
});

test('an account with no opinion leaves the device alone', () => {
  // The difference between "the account says light" and "the account has not
  // been asked": the key is absent, and absent is not a value.
  const p = project({ account: {}, local: { readerMode: 'spread', readerPrefs: { hideRead: true } } });
  assert.equal(p.readerMode, 'spread');
  assert.equal(p.hideRead, true);
  assert.equal(p.theme, null, 'no opinion is null, so the page keeps its own choice');
});

test('the surface\'s own defaults sit between the fallbacks and the device', () => {
  // A phone chains chapters by default; a desktop does not. Both are below
  // anything the device or the account has actually said.
  const phone = project({ readerDefaults: { autoNext: true, hideRead: true } });
  assert.equal(phone.autoNext, true);
  const desktop = project({});
  assert.equal(desktop.autoNext, false);
  const told = project({ readerDefaults: { autoNext: true }, local: { readerPrefs: { autoNext: false } } });
  assert.equal(told.autoNext, false, 'a device that said no was overruled by a default');
});

test('a surface that does not offer auto-show forces its answer', () => {
  const p = project({ account: { autoShow: false }, local: { autoShowDefault: false }, autoShow: true });
  assert.equal(p.autoShow, true);
  // And one that does offer it reads the three homes in order, down to the
  // old single flag in settings.
  assert.equal(project({ install: { autoOpenReader: true } }).autoShow, true);
  assert.equal(project({ local: { autoShowDefault: true }, install: { autoOpenReader: false } }).autoShow, true);
  assert.equal(project({ account: { autoShow: false }, local: { autoShowDefault: true } }).autoShow, false);
});

test('the whitelist and the interval fall from the account to the install', () => {
  assert.deepEqual(project({ install: { whitelist: ['a.example'] } }).whitelist, ['a.example']);
  assert.deepEqual(project({ account: { whitelist: [] }, install: { whitelist: ['a.example'] } }).whitelist, [],
    'an account that answered "none" was overruled by the install');
  assert.equal(project({}).checkIntervalMin, 360, 'the fallback is the one prefs.js declares');
});

test('the answer is flat, and it has every key a settings page can read', () => {
  const p = project({});
  for (const key of ['uiLang', 'theme', 'readerMode', 'autoShow', ...READER_KEYS, 'checkIntervalMin', 'whitelist']) {
    assert.ok(key in p, `${key} is missing`);
  }
  assert.ok(!('reader' in p) && !('prefs' in p), 'the reader\'s four are nested again');
});

// --- split -----------------------------------------------------------------

test('one patch becomes the three writes, each with only what is its own', () => {
  const { account, local, settings } = split(
    { theme: 'dark', tapZones: 'edges', checkIntervalMin: '60', whitelist: ['b.example'], backendUrl: 'https://x' },
    { readerPrefs: { brightness: 0.8, tapZones: 'sides' } },
  );
  assert.deepEqual(account, { theme: 'dark', tapZones: 'edges', checkIntervalMin: '60', whitelist: ['b.example'] });
  // Merged into the reader's object, never replacing it: brightness survives.
  assert.deepEqual(local, { readerPrefs: { brightness: 0.8, tapZones: 'edges' } });
  assert.deepEqual(settings, { checkIntervalMin: 60, whitelist: ['b.example'], backendUrl: 'https://x' });
});

test('the backend URL never reaches the account', () => {
  const { account } = split({ backendUrl: 'https://evil.example' });
  assert.ok(!('backendUrl' in account));
});

test('a surface without the auto-show choice pushes none', () => {
  const pushed = split({ autoShow: true });
  assert.equal(pushed.account.autoShow, true);
  assert.equal(pushed.local.autoShowDefault, true);
  const kept = split({ autoShow: true }, { pushAutoShow: false });
  assert.ok(!('autoShow' in kept.account), 'the phone pushed its forced answer onto the account');
  assert.ok(!('autoShowDefault' in kept.local));
});

test('an empty patch is three empty writes, not three writes', () => {
  const { account, local, settings } = split({});
  assert.deepEqual([account, local, settings], [{}, {}, {}]);
  assert.deepEqual(split(undefined).account, {});
});

test('every account key is one split knows to route', () => {
  // A key added to ACCOUNT_PREFS and not routed here would be accepted by the
  // server and never sent by a client.
  const patch = Object.fromEntries(KEYS.map((k) => [k, 'x']));
  const { account } = split(patch);
  assert.deepEqual(Object.keys(account).sort(), [...KEYS].sort());
});
