// The settings page, as a reader uses it.
//
// It used to be a developer's page: an API URL, an ad-block whitelist and a Save
// button. Everything a reader would actually want to change — the language, the
// reading direction, how often new chapters are looked for — lived somewhere
// else or nowhere. This file covers the page it became, and the two ways that
// kind of page fails quietly:
//
//   1. A control that paints but does not write. Nothing errors; the answer is
//      simply gone the next time the page opens.
//   2. A control that writes to the wrong place — over the whole `settings`
//      object, or past the worker that owns it — and takes the neighbouring
//      settings with it.
//
// The behaviour is lifted out of the shipping options.js with `new Function`
// rather than restated, so a test cannot pass against a page that does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, PanelFlowI18n } from './helpers/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const js = read('extension/options/options.js');
const html = read('extension/options/options.html');
const sendJs = read('extension/send.js');

/** The page reduced to what options.js touches. */
function stubPage({ stored = {}, settings = {}, capabilities = { passwordReset: true } } = {}) {
  const local = structuredClone(stored);
  const sent = [];          // every message the page put on the wire
  const alarms = [];        // every alarm it (re-)created
  const opened = [];        // every tab it asked Chrome to open

  const el = () => ({
    value: '', checked: false, textContent: '', placeholder: '', hidden: false,
    handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
  });
  // Every id the markup ships, plus `replay` — that one is inside a translated
  // sentence and is placed by apply() from the locale file, so it exists on the
  // real page only after the first paint.
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]).concat('replay');
  const byId = Object.fromEntries(ids.map((id) => [id, el()]));
  // The one attribute the page reads back off the markup: the shipped default
  // URL, which is what "Advanced, left alone" resolves to.
  byId.backendUrl.placeholder = html.match(/id="backendUrl"[^>]*placeholder="([^"]+)"/)[1];

  const replies = {
    getSettings: { settings: { checkIntervalMin: 360, ...settings } },
    setSettings: { ok: true },
    setLanguage: { ok: true },
    syncNow: { ok: true },
    logout: { ok: true },
  };

  const chrome = {
    storage: { local: {
      get: async (keys) => Object.fromEntries(
        keys.filter((k) => k in local).map((k) => [k, structuredClone(local[k])])),
      set: async (obj) => Object.assign(local, structuredClone(obj)),
    } },
    runtime: {
      getURL: (p) => `chrome-extension://pf/${p}`,
      sendMessage: (msg, cb) => { sent.push(msg); cb(replies[msg.type]); },
      lastError: null,
    },
    alarms: { create: (name, opts) => alarms.push({ name, ...opts }) },
    tabs: { create: ({ url }) => opened.push(url) },
  };

  const document = { getElementById: (id) => byId[id] };
  const self = {};
  new Function('self', 'chrome', sendJs)(self, chrome);

  return {
    document, chrome, byId, sent, alarms, opened, replies,
    storage: () => structuredClone(local),
    send: self.PanelFlowSend,
    fetch: async () => ({ json: async () => capabilities }),
  };
}

/** options.js over the stub page. Resolves once the first paint is done. */
async function boot(page) {
  // Handed back so the test can await it: the page paints after two awaits, and
  // a test that only assumed it had is a test that asserts an empty stub.
  const body = js
    .replace(/^'use strict';$/m, '')
    .replace('PanelFlowI18n.ready.then(', 'return PanelFlowI18n.ready.then(')
    .replace(/^ {2}load\(\);$/m, '  return load();');
  assert.ok(body.includes('return load()'), 'the boot block is not where this test expects it');
  const fn = new Function('document', 'chrome', 'fetch', 't', 'PanelFlowI18n', 'PanelFlowSend', body);
  await fn(page.document, page.chrome, page.fetch, t, PanelFlowI18n, page.send);
  return page;
}

/** Answer a control the way a reader does, and let the write land. */
const change = (page, id, patch) => {
  Object.assign(page.byId[id], patch);
  return page.byId[id].handlers.change();
};

const lastPatch = (page, type = 'setSettings') =>
  page.sent.filter((m) => m.type === type).at(-1)?.patch;

// --- 1. what the page shows --------------------------------------------------

test('every setting the page offers is painted from where it is stored', async () => {
  const page = await boot(stubPage({
    stored: {
      uiLang: 'fr', readerMode: 'spread-rtl', autoShowDefault: true,
      readerPrefs: { autoNext: true, hideRead: false, tapZones: 'edges' },
      authUser: { email: 'reader@example.com' },
    },
    settings: { backendUrl: 'https://mine.test', whitelist: ['a.test', 'b.test'], checkIntervalMin: 720 },
  }));

  assert.equal(page.byId.uiLang.value, 'fr');
  assert.equal(page.byId.readerMode.value, 'spread-rtl');
  assert.equal(page.byId.autoShow.checked, true);
  assert.equal(page.byId.autoNext.checked, true);
  assert.equal(page.byId.hideRead.checked, false);
  assert.equal(page.byId.tapZones.value, 'edges');
  assert.equal(page.byId.checkInterval.value, '720');
  assert.equal(page.byId.whitelist.value, 'a.test\nb.test');
  assert.equal(page.byId.backendUrl.value, 'https://mine.test');
  // Signed in: the form is put away and the account block takes its place.
  assert.equal(page.byId['signed-out'].hidden, true);
  assert.equal(page.byId['signed-in'].hidden, false);
  assert.equal(page.byId.who.textContent, 'reader@example.com');
});

test('an untouched install shows the defaults, not blanks', async () => {
  const page = await boot(stubPage());
  assert.equal(page.byId.uiLang.value, 'auto');
  assert.equal(page.byId.readerMode.value, 'vertical');
  assert.equal(page.byId.tapZones.value, 'sides');
  // Straight from the core through the worker, so the page never carries a
  // second copy of the default interval to go stale.
  assert.equal(page.byId.checkInterval.value, '360');
  assert.equal(page.byId['signed-in'].hidden, true);
});

test('the old single auto-open flag still answers for the checkbox', async () => {
  // Written before the per-site override existed. The popup reads it the same
  // way, and disagreeing with the popup about whether the reader opens on its
  // own is worse than either answer.
  const page = await boot(stubPage({ settings: { autoOpenReader: true } }));
  assert.equal(page.byId.autoShow.checked, true);
});

// --- 2. what answering a control writes --------------------------------------

test('each reader setting is written as it is answered, with no Save to press', async () => {
  const page = await boot(stubPage({ stored: { readerPrefs: { brightness: 0.4 } } }));

  await change(page, 'readerMode', { value: 'rtl' });
  assert.equal(page.storage().readerMode, 'rtl');

  await change(page, 'autoShow', { checked: true });
  assert.equal(page.storage().autoShowDefault, true);

  await change(page, 'autoNext', { checked: true });
  await change(page, 'tapZones', { value: 'off' });
  // Merged into the prefs, not written over them: brightness lives in the same
  // object and is set from inside the reader, where this page cannot see it.
  assert.deepEqual(page.storage().readerPrefs, { brightness: 0.4, autoNext: true, tapZones: 'off' });

  // And the page says so each time, rather than leaving the reader guessing.
  assert.equal(page.byId.status.textContent, t('statusSaved'));
});

test('changing how often chapters are checked re-creates the alarm', async () => {
  const page = await boot(stubPage());
  await change(page, 'checkInterval', { value: '60' });
  assert.deepEqual(lastPatch(page), { checkIntervalMin: 60 });
  // The alarm is created with this period on install and never touched again,
  // so without this the choice is decoration: the page would say "saved" and
  // keep checking every six hours.
  assert.deepEqual(page.alarms.at(-1), { name: 'pf-check-chapters', periodInMinutes: 60 });
});

test('the whitelist is written as a list, blank lines and stray spaces dropped', async () => {
  const page = await boot(stubPage());
  await change(page, 'whitelist', { value: '  a.test \n\n b.test\n' });
  assert.deepEqual(lastPatch(page), { whitelist: ['a.test', 'b.test'] });
});

test('the API URL loses its trailing slash and asks the new server what it can do', async () => {
  const page = await boot(stubPage());
  await change(page, 'backendUrl', { value: '  https://mine.test/  ' });
  assert.deepEqual(lastPatch(page), { backendUrl: 'https://mine.test' });
});

test('settings go through the worker, never straight into storage', async () => {
  const page = await boot(stubPage({ settings: { whitelist: ['keep.test'] } }));
  await change(page, 'checkInterval', { value: '1440' });
  await change(page, 'backendUrl', { value: 'https://mine.test' });
  // `set({ settings })` replaces the whole object. This form knows four of its
  // keys, so a raw write would silently drop the tracker tokens, the whitelist
  // and anything added to settings later.
  assert.equal(page.storage().settings, undefined);
  assert.ok(page.sent.filter((m) => m.type === 'setSettings').length >= 2);
});

// --- 3. the language picker ---------------------------------------------------

test('choosing a language asks the worker for it and repaints the page', async () => {
  const page = await boot(stubPage());
  let applied = 0;
  const spy = { ...PanelFlowI18n, apply: () => { applied++; } };
  // Rebooted with a spy in place of the shared stub, so the repaint is observed
  // rather than assumed: the map is fetched by the worker, and a page that does
  // not re-apply after it lands stays in the language it opened in.
  const body = js.replace(/^'use strict';$/m, '').replace(/^ {2}load\(\);$/m, '  return load();')
    .replace('PanelFlowI18n.ready.then(', 'return PanelFlowI18n.ready.then(');
  await new Function('document', 'chrome', 'fetch', 't', 'PanelFlowI18n', 'PanelFlowSend', body)(
    page.document, page.chrome, page.fetch, t, spy, page.send);

  const before = applied;
  await change(page, 'uiLang', { value: 'fr' });
  assert.deepEqual(page.sent.at(-1), { type: 'setLanguage', lang: 'fr' });
  assert.ok(applied > before, 'the page kept the language it opened in');
});

test('a language the worker refuses is said out loud, not swallowed', async () => {
  const page = stubPage();
  page.replies.setLanguage = { error: 'unknown language' };
  await boot(page);
  await change(page, 'uiLang', { value: 'jp' });
  assert.equal(page.byId.status.textContent, 'unknown language');

  // And a worker that never woke saves nothing either — "Saved ✓" here would
  // leave the page in the old language insisting it was in the new one.
  page.chrome.runtime.sendMessage = (_msg, cb) => cb(undefined);
  await change(page, 'uiLang', { value: 'fr' });
  assert.equal(page.byId.status.textContent, t('authNoAnswer'));
});

test('the picker offers exactly the languages the extension ships', () => {
  const block = html.slice(html.indexOf('id="uiLang"'));
  const offered = [...block.slice(0, block.indexOf('</select>')).matchAll(/value="([^"]+)"/g)]
    .map((m) => m[1]);
  // "Follow the browser" first, then one entry per directory under _locales/.
  assert.deepEqual(offered, ['auto', ...readdirSync(join(root, 'extension', '_locales'))]);
  // Each named in itself rather than through data-i18n: a picker that says
  // "French" to someone who cannot read English has not helped them.
  assert.match(block, /<option value="fr">Français<\/option>/);
});

// --- 4. the account -----------------------------------------------------------

test('a refused password and a silent server read differently', async () => {
  const page = stubPage();
  page.replies.auth = { error: 'wrong password' };
  await boot(page);
  await page.byId.login.handlers.click();
  assert.equal(page.byId['auth-msg'].hidden, false);
  assert.equal(page.byId['auth-msg'].textContent, 'wrong password');

  page.chrome.runtime.sendMessage = (_msg, cb) => cb(undefined);
  await page.byId.register.handlers.click();
  // Telling someone their password was refused when the server never answered
  // sends them off to change a password that was fine.
  assert.equal(page.byId['auth-msg'].textContent, t('authNoAnswer'));
});

test('signing in swaps the form for the account and forgets the password', async () => {
  const page = stubPage();
  page.replies.auth = { user: { email: 'reader@example.com' } };
  await boot(page);
  page.byId.password.value = 'hunter2';
  await page.byId.login.handlers.click();
  assert.equal(page.byId['signed-in'].hidden, false);
  assert.equal(page.byId.who.textContent, 'reader@example.com');
  assert.equal(page.byId.password.value, '');
});

test('syncing says it is working before it says it worked', async () => {
  const page = await boot(stubPage());
  const said = [];
  page.byId.status.textContent = '';
  const watch = setInterval(() => said.push(page.byId.status.textContent), 0);
  await page.byId.sync.handlers.click();
  clearInterval(watch);
  assert.equal(page.byId.status.textContent, t('statusSynced'));
  assert.ok(page.sent.some((m) => m.type === 'syncNow'));
});

test('signing out puts the form back', async () => {
  const page = stubPage({ stored: { authUser: { email: 'reader@example.com' } } });
  await boot(page);
  await page.byId.logout.handlers.click();
  assert.equal(page.byId['signed-out'].hidden, false);
  assert.equal(page.byId['signed-in'].hidden, true);
});

test('the forgotten-password link appears only where it can work', async () => {
  const on = await boot(stubPage());
  assert.equal(on.byId['forgot-line'].hidden, false);
  on.byId.forgot.handlers.click({ preventDefault() {} });
  // The web app already has the flow; one flow means one set of rate limits.
  assert.equal(on.opened.at(-1), `${on.byId.backendUrl.placeholder}/#forgot`);

  // A deployment with no mail configured would take the address, wait, and then
  // announce it cannot send — so the door is not offered at all.
  const off = await boot(stubPage({ capabilities: { passwordReset: false } }));
  assert.equal(off.byId['forgot-line'].hidden, true);

  const down = stubPage();
  down.fetch = async () => { throw new Error('offline'); };
  await boot(down);
  assert.equal(down.byId['forgot-line'].hidden, true);
});

test('there is still a way back to the setup tour', async () => {
  const page = await boot(stubPage());
  page.byId.replay.handlers.click({ preventDefault() {} });
  assert.equal(page.opened.at(-1), 'chrome-extension://pf/welcome/welcome.html');
});

// --- 5. what the page is no longer about --------------------------------------

test('the API URL is filed under Advanced, behind everything a reader wants', () => {
  const advanced = html.slice(html.indexOf('<details'));
  assert.ok(advanced.includes('id="backendUrl"'),
    'the API URL is back in the open — it is the one setting a reader cannot answer');
  // And it is genuinely last: every reader-facing group is above it.
  for (const id of ['uiLang', 'readerMode', 'checkInterval', 'whitelist']) {
    assert.ok(html.indexOf(`id="${id}"`) < html.indexOf('<details'), `${id} is buried in Advanced`);
  }
});

test('nothing is drawn before the chosen language is in hand', () => {
  // Both the paint and the load are inside `ready.then`. Outside it, the page
  // would write its labels in the browser's language and correct itself a tick
  // later — the flash this whole arrangement exists to avoid.
  const boot = js.slice(js.indexOf('PanelFlowI18n.ready.then('));
  for (const call of ['PanelFlowI18n.apply()', 'PanelFlowI18n.markLanguage()', 'load()']) {
    assert.ok(boot.includes(call), `${call} runs before the language is known`);
  }
});
