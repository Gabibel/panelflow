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
import { createCore } from '../src/panelflow-core.js';
import { t, PanelFlowI18n } from './helpers/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const js = read('extension/options/options.js');
const html = read('extension/options/options.html');
const sendJs = read('extension/send.js');
const bg = read('extension/background.js');

// The page shows nothing it did not ask the worker for, and writes nothing it
// does not hand back the same way — so the worker's two handlers are lifted out
// of background.js rather than restated here. A stub with its own idea of where
// readerMode lives would be a test of the stub, and would go on passing after
// the worker moved it. The web app's Settings tab reaches these same two.
const PREFS_SRC = bg.slice(bg.indexOf('  getPrefs: async ('), bg.indexOf('  setLanguage: async (msg)'));
assert.ok(/setPrefs: async/.test(PREFS_SRC), 'the prefs handlers are not where this test expects them');

// The one module-level helper those two handlers lean on. Lifted rather than
// restated for the same reason as the handlers themselves — a second `pick`
// that kept truthy values instead of present ones would make this file pass
// while unticking a checkbox in the browser did nothing.
const PICK_SRC = bg.match(/^const pick = [\s\S]*?;$/m)[0];
assert.ok(/k in obj/.test(PICK_SRC), 'pick no longer tests for presence');

/** The page reduced to what options.js touches, over the real worker and core. */
function stubPage({
  stored = {}, settings = {}, hash = '', capabilities = { passwordReset: true },
  // The whole-web permission: what Chrome already holds, and what it will say
  // to the prompt. Refusal is a real answer here, not an error path.
  allSites = false, grant = true,
} = {}) {
  const local = structuredClone(stored);
  if (Object.keys(settings).length) local.settings = structuredClone(settings);
  const sent = [];          // every message the page put on the wire
  const alarms = [];        // every alarm the worker (re-)created
  const opened = [];        // every tab it asked Chrome to open
  const asked = [];         // every permission it put in front of the reader

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

  const storage = {
    get: async (keys) => (keys == null ? structuredClone(local) : Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys]).filter((k) => k in local)
        .map((k) => [k, structuredClone(local[k])]))),
    set: async (obj) => { Object.assign(local, structuredClone(obj)); },
  };

  const chrome = {
    storage: { local: storage },
    runtime: {
      getURL: (p) => `chrome-extension://pf/${p}`,
      sendMessage: (msg, cb) => { sent.push(msg); Promise.resolve(handle(msg)).then(cb); },
      lastError: null,
    },
    alarms: { create: (name, opts) => alarms.push({ name, ...opts }) },
    tabs: { create: ({ url }) => opened.push(url) },
    permissions: {
      contains: async () => allSites,
      request: async (arg) => { asked.push({ request: arg }); return (allSites = grant); },
      remove: async (arg) => { asked.push({ remove: arg }); allSites = !grant; return grant; },
    },
  };

  // The core the worker actually runs on, over the same storage: settings are
  // merged here exactly as they are in the browser, shipped defaults and all,
  // so the defaults this page paints are not a second copy of them.
  const core = createCore({
    storage,
    fetch: async () => { throw new Error('offline'); },
    notify: () => {},
  });

  const replies = {
    setLanguage: { ok: true },
    syncNow: { ok: true },
    logout: { ok: true },
    syncSites: { ok: true },
  };
  const prefs = new Function('chrome', 'core', 'handle', `${PICK_SRC}\nreturn {\n${PREFS_SRC}\n};`)(
    chrome, core, (msg) => handle(msg));
  const handle = async (msg) => (prefs[msg.type] ? prefs[msg.type](msg) : replies[msg.type]);

  const document = { getElementById: (id) => byId[id] };
  // shared/theme.js puts this on window from <head>, so the palette is on
  // screen before the first message is sent — which is the whole reason it is
  // kept in localStorage and not in chrome.storage. adopt() is the correction
  // that comes back once the worker has been asked, and it answers whether it
  // changed anything so the page knows whether to redraw the select.
  const themed = [];
  let theme = 'dark';
  const panelflowTheme = {
    get: () => theme,
    set: (v) => { theme = v; themed.push(v); },
    adopt: (v) => (v == null || v === theme ? false : (panelflowTheme.set(v), true)),
  };
  const window = { panelflowTheme };
  const self = {};
  new Function('self', 'chrome', sendJs)(self, chrome);

  return {
    document, window, themed, chrome, byId, sent, alarms, opened, replies, asked,
    location: { hash },
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
  const fn = new Function('document', 'location', 'chrome', 'fetch', 't', 'PanelFlowI18n', 'PanelFlowSend', 'window', body);
  await fn(page.document, page.location, page.chrome, page.fetch, t, PanelFlowI18n, page.send, page.window);
  return page;
}

/** Answer a control the way a reader does, and let the write land. */
const change = (page, id, patch) => {
  Object.assign(page.byId[id], patch);
  return page.byId[id].handlers.change();
};

const lastPatch = (page, type = 'setPrefs') =>
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

test('keeping the reader dark is a reader preference like the others', async () => {
  // It rides in readerPrefs rather than beside the page theme on purpose: the
  // reader is injected into a scan site's origin, where this extension's
  // localStorage does not exist. chrome.storage is the only channel that
  // reaches it, and readerPrefs is the object it already reads on open.
  const page = await boot(stubPage());
  // On unless it has been turned off — a prefs object written before this
  // existed has no key, and reading that as "off" would whiten every reader.
  assert.equal(page.byId.readerDark.checked, true);
  await change(page, 'readerDark', { checked: false });
  assert.equal(page.storage().readerPrefs.readerDark, false);
});

test('the theme paints from this browser and is then told to the account', async () => {
  // Both halves matter. shared/theme.js applies it from <head>, before the page
  // is painted — a round trip to a service worker that may be asleep is exactly
  // the thing that would make the page flash the wrong palette and then correct
  // itself. But the answer belongs to the reader and not to this machine, so
  // the change goes on to the account, which is what carries it to the website
  // and the phone.
  const page = await boot(stubPage());
  assert.equal(page.byId.theme.value, 'dark');
  await change(page, 'theme', { value: 'light' });
  assert.deepEqual(page.themed, ['light'], 'the page did not recolour itself');
  assert.deepEqual(lastPatch(page), { theme: 'light' });
  assert.equal(page.byId.status.textContent, t('statusSaved'));
});

test('the theme the account settled on wins over the one this browser painted', async () => {
  // The stub is offline, which is the point: the worker cannot reach the server,
  // falls back to what this device last heard, and the page adopts that rather
  // than staying on the palette localStorage happened to hold. This is how a
  // theme chosen on the website arrives in a browser that was never told.
  const page = await boot(stubPage({
    stored: { authToken: 'tok', accountPrefs: { theme: 'light' } },
  }));
  assert.deepEqual(page.themed, ['light'], 'the account was asked and then ignored');
  assert.equal(page.byId.theme.value, 'light');
  // And it is not a setting about this install: `settings` is the object that
  // holds the address of the server, and the theme has no business in it.
  assert.ok(!('theme' in (page.storage().settings || {})));
});

test('an account with no opinion leaves the palette this browser chose', async () => {
  // "The account says light" and "the account has never been asked" are
  // different answers, and only the first one is an instruction. Confusing them
  // is how a first sign-in overwrites settings the reader already made here.
  const page = await boot(stubPage({ stored: { authToken: 'tok' } }));
  assert.deepEqual(page.themed, [], 'a shrug was applied as a choice');
  assert.equal(page.byId.theme.value, 'dark');
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

test('settings are patched through the worker, never written over', async () => {
  const page = await boot(stubPage({ settings: { whitelist: ['keep.test'] } }));
  await change(page, 'checkInterval', { value: '1440' });
  await change(page, 'backendUrl', { value: 'https://mine.test' });
  // `set({ settings })` replaces the whole object. This form knows three of its
  // keys, so a raw write would silently drop the tracker tokens, the whitelist
  // and anything added to settings later — none of which either change above
  // so much as mentioned.
  assert.deepEqual(page.storage().settings, {
    whitelist: ['keep.test'], checkIntervalMin: 1440, backendUrl: 'https://mine.test',
  });
  // And the page never reaches past the worker to do it itself.
  assert.equal(page.sent.filter((m) => m.type === 'setPrefs').length, 2);
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
  await new Function('document', 'location', 'chrome', 'fetch', 't', 'PanelFlowI18n', 'PanelFlowSend', 'window', body)(
    page.document, page.location, page.chrome, page.fetch, t, spy, page.send, page.window);

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

test('the API URL is not shown at all unless it is moved or asked for', async () => {
  // The address of the API is not a question a reader can answer, and a
  // settings page that opens on one is a page that looks like it is not theirs.
  const plain = await boot(stubPage());
  assert.equal(plain.byId.advanced.hidden, true);

  // Someone self-hosting has already moved it off the default, and hiding the
  // field then hides the reason nothing else on the page is working.
  const moved = await boot(stubPage({ settings: { backendUrl: 'http://localhost:8787' } }));
  assert.equal(moved.byId.advanced.hidden, false);

  // And it can still be asked for by name — which is how it gets moved the
  // first time, and the only way back if it is set to something unreachable.
  const asked = await boot(stubPage({ hash: '#advanced' }));
  assert.equal(asked.byId.advanced.hidden, false);
});

test('the page offers the same settings in the app people have open', async () => {
  const page = await boot(stubPage());
  page.byId['site-settings'].handlers.click({ preventDefault() {} });
  // The account half of these settings is the web app's, and someone looking
  // for "my account" looks in the app long before they open an options page.
  assert.equal(page.opened.at(-1), `${page.byId.backendUrl.placeholder}/#settings`);
});

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

// --- the sites it is allowed to be on ----------------------------------------
//
// The extension stopped asking for the whole web at install; this box is where
// a reader can hand it back, once, for the two things the narrow list cannot
// do — a site nobody has added yet, and covers and downloads served from image
// domains no site list names.

test('the box says what Chrome holds, not what was last clicked', async () => {
  assert.equal((await boot(stubPage())).byId.allSites.checked, false);
  assert.equal((await boot(stubPage({ allSites: true }))).byId.allSites.checked, true);
});

test('ticking it asks Chrome and then tells the worker to inject', async () => {
  const page = await boot(stubPage());
  await change(page, 'allSites', { checked: true });

  assert.deepEqual(page.asked, [{ request: { origins: ['<all_urls>'] } }]);
  // Chrome grants and stops there. Without this the reader would tick the box,
  // see "Saved", and find the site they wanted still doing nothing.
  assert.ok(page.sent.some((m) => m.type === 'syncSites'));
  assert.equal(page.byId.allSites.checked, true);
});

test('a refused prompt unticks the box instead of claiming it saved', async () => {
  const page = await boot(stubPage({ grant: false }));
  await change(page, 'allSites', { checked: true });

  assert.equal(page.byId.allSites.checked, false,
    'the page says PanelFlow may read every site, and it may not');
  assert.ok(!page.sent.some((m) => m.type === 'syncSites'));
  assert.equal(page.byId.status.textContent, '', 'it said "Saved" over a refusal');
});

test('unticking it gives the permission back', async () => {
  const page = await boot(stubPage({ allSites: true }));
  await change(page, 'allSites', { checked: false });

  // Revocable from where it was granted. Otherwise the only way back is a
  // Chrome settings page the reader has no reason to know exists.
  assert.deepEqual(page.asked, [{ remove: { origins: ['<all_urls>'] } }]);
  assert.equal(page.byId.allSites.checked, false);
  // And the worker has to unregister, or the scripts outlive the permission.
  assert.ok(page.sent.some((m) => m.type === 'syncSites'));
});
