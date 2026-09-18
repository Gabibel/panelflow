// The same settings on the desktop and on the phone.
//
// One account, three surfaces: the extension's options page, the website's
// settings tab, the phone's settings menu. A preference that can be changed on
// one and not on another is a preference the reader has to go and find a
// computer for — and the ones that were missing were exactly the kind you
// discover on a train: the ad blocker's exceptions, a forgotten password, a
// way to close the account.
//
// So the list of account preferences (shared/prefs.js is the authority) is
// walked, and every key must be offered on every surface, unless the exception
// is written down here with its reason. The same for the account actions.
// Then the phone's own plumbing: what its settings pages read has to be what
// its `readPrefs` hands back — the reader page once read `prefs.tapZones` from
// an answer that had it under `prefs.reader.tapZones`, and every switch drew
// as off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../shared/prefs.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const { KEYS } = globalThis.PanelFlowPrefs;

// Where each surface offers each preference: a string that must appear in the
// named file. The extension and the website name their controls by id; the
// phone's pages call `set('<key>', …)`.
const options = read('extension/options/options.html');
const web = read('web/index.html');
const phone = ['Appearance', 'Reader', 'Updates', 'Adblock']
  .map((p) => read(`native/src/screens/settings/${p}Page.js`)).join('\n');

/**
 * Preferences a surface deliberately does not offer, and why. Anything not
 * here has to be on all three.
 */
const EXCEPTIONS = {
  // The reader opens by itself on a chapter, always, on the phone — one tap
  // on a pill is one tap too many there (native/src/prefs.js, AUTO_SHOW_ALWAYS).
  autoShow: ['phone'],
  // Starred from the Sites screens on every surface, not from a settings
  // page: a list you build by pressing a star next to a site is not a form.
  favouriteSites: ['options', 'web', 'phone'],
};

// The control each surface names each preference by. Written out rather than
// derived: two of them are not the key (`checkInterval`, `set-mode`), and a
// table is the thing to read when adding a preference.
const IDS = {
  options: {
    theme: 'theme', uiLang: 'uiLang', readerMode: 'readerMode', tapZones: 'tapZones',
    autoShow: 'autoShow', autoNext: 'autoNext', hideRead: 'hideRead', readerDark: 'readerDark',
    checkIntervalMin: 'checkInterval', whitelist: 'whitelist',
  },
  web: {
    theme: 'set-theme', uiLang: 'set-lang', readerMode: 'set-mode', tapZones: 'set-tapzones',
    autoShow: 'set-autoshow', autoNext: 'set-autonext', hideRead: 'set-hideread',
    readerDark: 'set-readerdark', checkIntervalMin: 'set-interval', whitelist: 'set-whitelist',
  },
};
const OFFERED = {
  options: (key) => !!IDS.options[key] && new RegExp(`\\sid="${IDS.options[key]}"`).test(options),
  web: (key) => !!IDS.web[key] && new RegExp(`\\sid="${IDS.web[key]}"`).test(web),
  phone: (key) => new RegExp(`set\\('${key}'`).test(phone) || new RegExp(`\\['${key}', '`).test(phone),
};

for (const surface of ['options', 'web', 'phone']) {
  test(`every account preference is offered on the ${surface}, or excused by name`, () => {
    const missing = KEYS.filter((key) => !(EXCEPTIONS[key] || []).includes(surface) && !OFFERED[surface](key));
    assert.deepEqual(missing, [], `${surface} does not offer: ${missing.join(', ')}`);
  });
}

test('the account actions exist on every surface', () => {
  // Sign out, a password by e-mailed link, export, delete. The website is the
  // server, so "sync now" is not one of them there.
  const phoneAccount = read('native/src/screens/AccountScreen.js');
  const optionsJs = read('extension/options/options.js');
  const webJs = read('web/app.js');

  const actions = [
    ['sign out', /id="logout"/, /id="set-signout"/, /type: 'logout'/],
    ['a password-reset link', /id="forgot"/, /id="auth-forgot"/, /#forgot/],
    ['export', /id="export"/, /id="export-open"/, /type: 'exportAccount'/],
    ['delete the account', /id="delete-run"/, /id="set-delete"/, /type: 'deleteAccount'/],
  ];
  for (const [what, ext, site, ph] of actions) {
    assert.match(options, ext, `the options page cannot ${what}`);
    assert.match(web, site, `the website cannot ${what}`);
    assert.match(phoneAccount, ph, `the phone cannot ${what}`);
  }
  // And the plumbing behind two of them is the shared hub, not three copies.
  const hub = read('shared/panelflow-core.js');
  assert.match(hub, /case 'exportAccount':/);
  assert.match(hub, /case 'deleteAccount':/);
  assert.match(hub, /case 'forgotPassword':/);
  assert.match(optionsJs, /type: 'exportAccount'/);
  assert.match(optionsJs, /type: 'deleteAccount'/);
  assert.match(webJs, /'\/auth\/me', \{ method: 'DELETE'/);
});

test('the legal pages are one click away on every surface', () => {
  assert.match(options, /class="legal-links"/);
  assert.match(web, /class="legal-links"/);
  assert.match(read('native/src/screens/SettingsScreen.js'), /Page: LegalPage/);
});

// --- the phone's plumbing ----------------------------------------------------

/** `readPrefs` and `writePrefs`, lifted out of native/src/prefs.js. */
function liftPrefs(answers) {
  const src = read('native/src/prefs.js').replace(/\r\n/g, '\n');
  const body = src
    .replace(/^import .*$/gm, '')
    .replace(/^export /gm, '');
  const sent = [];
  const send = async (msg) => { sent.push(msg); return answers[msg.type] ?? {}; };
  // `Prefs` is what native/src/shared.js hands the file: the shared rule.
  const api = new Function('send', 'Prefs', `${body}\n return { readPrefs, writePrefs };`)(
    send, globalThis.PanelFlowPrefs);
  return { ...api, sent };
}

test('what the phone\'s settings pages read is what readPrefs hands back', async () => {
  const { readPrefs } = liftPrefs({
    getAccountPrefs: { prefs: { tapZones: 'edges', whitelist: ['a.example'] } },
    storageGet: { values: { readerPrefs: { autoNext: false, brightness: 0.8 } } },
    getSettings: { settings: { checkIntervalMin: 180 } },
  });
  const prefs = await readPrefs();

  // Every `prefs.<key>` a page reads, and every toggle key. Comments stripped
  // first: the pages mention `native/src/prefs.js` in theirs.
  const code = phone.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const readByPages = new Set([
    ...[...code.matchAll(/\bprefs\.(\w+)/g)].map((m) => m[1]),
    ...[...code.matchAll(/\['(\w+)', 'options\w+'\]/g)].map((m) => m[1]),
  ]);
  assert.ok(readByPages.size >= 8, 'the pages read almost nothing?');
  for (const key of readByPages) {
    assert.ok(key in prefs, `a settings page reads prefs.${key}, which readPrefs does not return`);
  }
  // Flat — the shape the pages read. The reader's four are not under a key.
  assert.equal(prefs.tapZones, 'edges', 'the account\'s answer did not reach the page');
  assert.equal(prefs.autoNext, false, 'the local reader value did not reach the page');
  assert.ok(!('reader' in prefs), 'readPrefs nests the reader settings again');
  assert.deepEqual(prefs.whitelist, ['a.example']);
});

test('the whitelist is written to both of its homes, like the extension does', async () => {
  const { writePrefs, sent } = liftPrefs({ storageGet: { values: {} } });
  await writePrefs({ whitelist: ['b.example'] });
  const account = sent.find((m) => m.type === 'setAccountPrefs');
  const install = sent.find((m) => m.type === 'setSettings');
  assert.deepEqual(account?.patch, { whitelist: ['b.example'] }, 'not written to the account');
  assert.deepEqual(install?.patch, { whitelist: ['b.example'] }, 'not written to this install');
});
