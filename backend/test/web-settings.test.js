// The Settings tab in the web app.
//
// The same settings as the extension's own options page, in the app people
// actually have open — and that is the whole risk. Two pages offering the same
// choices drift: one grows a reading mode the other never heard of, one writes
// `autoShow` where the other writes `autoShowDefault`, and the reader gets a
// control that saves nothing or a list missing the answer they wanted.
//
// So this file checks two things. That the page does what it looks like it
// does — painted from the extension's answer, written back as it is answered,
// honest when nothing answered. And that it and the options page are still
// offering the same set of answers.
//
// The behaviour is lifted out of the shipping web/app.js with `new Function`,
// the way web-reset.test.js does it, so a test cannot pass against a page that
// does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, webI18n } from './helpers/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const src = read('web', 'app.js');
const html = read('web', 'index.html');
const optionsHtml = read('extension', 'options', 'options.html');

const SETTINGS = (() => {
  const a = src.indexOf('let setStatusTimer = 0;');
  const b = src.indexOf('/* ---------- Statistics ---------- */', a);
  assert.ok(a !== -1 && b > a, 'web/app.js no longer keeps its settings block where this test looks');
  return src.slice(a, b);
})();

/** What the extension answers `getPrefs` with, as the worker builds it. */
const prefs = (over = {}) => ({
  ok: true,
  uiLang: 'fr',
  readerMode: 'spread-rtl',
  autoShow: true,
  prefs: { autoNext: true, hideRead: false, tapZones: 'edges', readerDark: false },
  checkIntervalMin: 720,
  whitelist: ['a.test', 'b.test'],
  backendUrl: 'https://mine.test',
  user: { email: 'reader@example.com' },
  ...over,
});

/** The settings block over stub globals. */
function build({ answer = prefs(), user = { email: 'reader@example.com' }, apiImpl,
                 token = 'a-token', lang = 'auto' } = {}) {
  const els = {};
  const $ = (id) => (els[id] ??= {
    value: '', checked: false, textContent: '', hidden: false, disabled: false,
    handlers: {},
    addEventListener(type, fn) { this.handlers[type] = fn; },
  });

  // The theme is the one setting on the page the extension knows nothing about:
  // shared/theme.js puts it on window from <head>, before this file has run.
  // The real object writes to localStorage; adopt() is the correction that
  // arrives after the page has already been painted, and it answers whether it
  // changed anything so the caller knows whether the select needs redrawing.
  const themed = [];
  let theme = 'dark';
  const panelflowTheme = {
    get: () => theme,
    set: (v) => { theme = v; themed.push(v); },
    adopt: (v) => (v == null || v === theme ? false : (panelflowTheme.set(v), true)),
  };
  const window = { panelflowTheme };

  // The language is the theme's twin: shared/i18n.js puts it on window from
  // <head> too, and this page has to be able to change it with no extension in
  // the browser at all. The stub answers the three questions the block asks.
  const { api: PanelFlowI18n, state: langState } = webI18n(lang);

  // Everything redrawEverything() reaches for lives outside the slice — it is
  // the whole rest of the page. Counted rather than run: what this file is
  // checking is that a language change asks for a repaint, not what a repaint
  // draws.
  const drew = [];
  const redraw = (name) => () => drew.push(name);

  const asked = [];       // every question put to the extension
  const calls = [];       // every backend call
  const ext = async (type, body = {}) => {
    asked.push({ type, ...body });
    return typeof answer === 'function' ? answer(type, body) : answer;
  };
  const api = apiImpl || (async (path, init) => { calls.push({ path, ...init }); return { message: 'sent' }; });
  let signedOut = 0;

  const built = new Function(
    '$', 'ext', 'api', 'user', 'signOut', 'window', 'token', 't', 'PanelFlowI18n',
    'buildSortOptions', 'renderContinue', 'renderTabs', 'renderLibrary', 'renderUpdates',
    'loadStats', 'loadHistory', 'loadTrackers', 'activeView', `
    ${SETTINGS}
    return { loadSettings, setStatus, adoptAccountPrefs, redrawEverything };
  `)($, ext, api, user, () => { signedOut++; }, window, token, t, PanelFlowI18n,
    redraw('sort'), redraw('continue'), redraw('tabs'), redraw('library'), redraw('updates'),
    redraw('stats'), redraw('history'), redraw('trackers'), 'library');

  return { ...built, $, els, asked, calls, themed, drew, langState,
    signedOut: () => signedOut };
}

/** Answer a control the way a reader does, and let the write land. */
const change = (page, id, patch) => {
  Object.assign(page.$(id), patch);
  return page.$(id).handlers.change();
};

// --- what the page shows ------------------------------------------------------

test('every element the settings block reaches for is on the page', () => {
  const ids = new Set([...SETTINGS.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  assert.ok(ids.size >= 10, 'the block stopped reaching for anything — check the slice');
  for (const id of ids) {
    assert.ok(html.includes(`id="${id}"`), `web/app.js reaches for #${id}, which index.html has not got`);
  }
});

test('the settings are painted from the extension answer, not from defaults', async () => {
  const page = build();
  await page.loadSettings();

  assert.equal(page.$('set-email').textContent, 'reader@example.com');
  assert.equal(page.$('set-mode').value, 'spread-rtl');
  assert.equal(page.$('set-autoshow').checked, true);
  assert.equal(page.$('set-autonext').checked, true);
  assert.equal(page.$('set-hideread').checked, false);
  assert.equal(page.$('set-tapzones').value, 'edges');
  assert.equal(page.$('set-readerdark').checked, false);
  assert.equal(page.$('set-interval').value, '720');
  assert.equal(page.$('set-whitelist').value, 'a.test\nb.test');

  assert.equal(page.$('set-extension').hidden, false);
  assert.equal(page.$('set-no-extension').hidden, true);
});

test('with no extension in this browser the controls are not offered at all', async () => {
  const page = build({ answer: null, lang: 'fr' });
  await page.loadSettings();
  // These settings live in chrome.storage on the machine. Drawn here without an
  // extension they would be controls with nowhere to write — they would take an
  // answer, say nothing, and lose it.
  assert.equal(page.$('set-extension').hidden, true);
  assert.equal(page.$('set-no-extension').hidden, false);
  assert.equal(page.$('set-mode').value, '');
  // Except the theme and the language, which are this page's own and are the
  // reason the section they sit in is drawn above the extension's half rather
  // than inside it.
  assert.equal(page.$('set-theme').value, 'dark');
  assert.equal(page.$('set-lang').value, 'fr');
});

test('the language shown is the one this page is in, not the extension answer', async () => {
  // It used to be read out of the getPrefs answer — which is why the control
  // was blank, and inert, in a browser with no extension, while the page it sat
  // on was perfectly capable of speaking French.
  const page = build({ lang: 'fr', answer: prefs({ uiLang: 'en' }) });
  await page.loadSettings();
  assert.equal(page.$('set-lang').value, 'fr');
});

test('a reader whose prefs predate the setting still gets a dark reader', async () => {
  // Absent is not false. The prefs object is merged over defaults in the worker
  // and written back whole from inside the reader, so it long outlives any one
  // release — and reading `undefined` as "off" would turn the reader white for
  // everyone who had used it before this shipped.
  const page = build({ answer: prefs({ prefs: { tapZones: 'sides' } }) });
  await page.loadSettings();
  assert.equal(page.$('set-readerdark').checked, true);
});

// --- what answering a control writes -----------------------------------------

test('each setting is written as it is answered, with no Save to press', async () => {
  const page = build();
  await page.loadSettings();

  await change(page, 'set-mode', { value: 'rtl' });
  assert.deepEqual(page.asked.at(-1), { type: 'setPrefs', patch: { readerMode: 'rtl' } });

  await change(page, 'set-autoshow', { checked: false });
  assert.deepEqual(page.asked.at(-1).patch, { autoShow: false });

  await change(page, 'set-autonext', { checked: true });
  assert.deepEqual(page.asked.at(-1).patch, { prefs: { autoNext: true } });

  await change(page, 'set-hideread', { checked: true });
  assert.deepEqual(page.asked.at(-1).patch, { prefs: { hideRead: true } });

  await change(page, 'set-tapzones', { value: 'off' });
  assert.deepEqual(page.asked.at(-1).patch, { prefs: { tapZones: 'off' } });

  await change(page, 'set-readerdark', { checked: true });
  assert.deepEqual(page.asked.at(-1).patch, { prefs: { readerDark: true } });

  // A number, not the string the select hands over: the worker puts this
  // straight into an alarm period.
  await change(page, 'set-interval', { value: '1440' });
  assert.deepEqual(page.asked.at(-1).patch, { checkIntervalMin: 1440 });

  await change(page, 'set-whitelist', { value: '  a.test \n\n b.test\n' });
  assert.deepEqual(page.asked.at(-1).patch, { whitelist: ['a.test', 'b.test'] });

  // The language is its own message — it makes the extension fetch a locale
  // file, which no amount of patching settings would do.
  await change(page, 'set-lang', { value: 'en' });
  assert.deepEqual(page.asked.at(-1), { type: 'setLanguage', lang: 'en' });

  assert.equal(page.$('set-status').textContent, 'Saved ✓');
});

test('the theme is written to this browser first, and the account second', async () => {
  // It is applied from <head> before anything here runs, and it is what the
  // page looks like with no extension installed. Routing it through the bridge
  // would make the one setting that always works depend on the one thing that
  // may not be there. But the answer belongs to the reader rather than to this
  // browser, so once the page has changed itself it tells the account — which
  // is what carries it to the extension and to the phone.
  const page = build();
  await page.loadSettings();
  const before = page.asked.length;
  await change(page, 'set-theme', { value: 'light' });
  assert.deepEqual(page.themed, ['light']);
  assert.equal(page.asked.length, before, 'the extension was asked about the theme');
  assert.deepEqual(page.calls.at(-1), { path: '/prefs', method: 'PUT', body: { prefs: { theme: 'light' } } });
});

test('signed out, the theme still changes and nothing is sent', async () => {
  // The PUT is the half that needs an account, and it is deliberately the
  // second half. A reader with no account still gets a dark page.
  const page = build({ token: null });
  await change(page, 'set-theme', { value: 'light' });
  assert.deepEqual(page.themed, ['light']);
  assert.deepEqual(page.calls, []);
});

test('a theme the account settled on elsewhere is adopted after the paint', async () => {
  // The page cannot wait for this — shared/theme.js paints from localStorage in
  // <head>, and a page that waited for the network would flash. So the account
  // answer arrives late and corrects both the page and the select.
  const page = build({ apiImpl: async () => ({ prefs: { theme: 'light' } }) });
  await page.adoptAccountPrefs();
  assert.deepEqual(page.themed, ['light']);
  assert.equal(page.$('set-theme').value, 'light');
});

test('an account with no opinion about the theme leaves this browser alone', async () => {
  // The difference between "the account says light" and "the account has never
  // been asked" is the whole of what makes signing in on a device that already
  // has settings safe.
  const page = build({ apiImpl: async () => ({ prefs: {} }) });
  await page.adoptAccountPrefs();
  assert.deepEqual(page.themed, [], 'a shrug was read as an instruction');
});

test('the language is written to this page first, and the account second', async () => {
  // The disagreement this whole family of tests grew out of: the control used
  // to send one `setLanguage` message to the extension and nothing else, so
  // choosing "Français" here switched the popup and left this page — the page
  // the reader was looking at — in English.
  const page = build({ lang: 'en' });
  await change(page, 'set-lang', { value: 'fr' });

  assert.deepEqual(page.langState.asked, ['fr'], 'the page did not change its own language');
  assert.equal(page.langState.lang, 'fr');
  // apply() fills the annotated markup; everything else on the page is built in
  // JS and has to be built again, or the shelf stays in the old language until
  // something happens to redraw it.
  assert.ok(page.langState.applied > 0, 'the markup was never re-filled');
  assert.deepEqual(page.drew, ['sort', 'continue', 'tabs', 'library', 'updates']);

  // Then the account, which is what carries the choice to the phone.
  assert.deepEqual(page.calls.at(-1),
    { path: '/prefs', method: 'PUT', body: { prefs: { uiLang: 'fr' } } });
  // Then the extension, last and best effort: it fetches a locale file, which
  // no amount of patching settings would do.
  assert.deepEqual(page.asked.at(-1), { type: 'setLanguage', lang: 'fr' });
});

test('choosing the language the page is already in redraws nothing', async () => {
  // "Same as the browser" on a French browser is already French. A repaint here
  // would be free of consequences and full of flicker.
  const page = build({ lang: 'fr' });
  await change(page, 'set-lang', { value: 'fr' });
  assert.deepEqual(page.drew, []);
  assert.deepEqual(page.asked.at(-1), { type: 'setLanguage', lang: 'fr' },
    'the extension was not told, and it is the one that has to fetch a locale');
});

test('signed out, the language still changes and nothing is sent', async () => {
  const page = build({ token: null, lang: 'en' });
  await change(page, 'set-lang', { value: 'fr' });
  assert.equal(page.langState.lang, 'fr');
  assert.deepEqual(page.calls, []);
});

test('a language the account settled on elsewhere is adopted after the paint', async () => {
  // Chosen in the extension's options page on another machine, or on the phone
  // — which has no settings screen at all and can only be told. Same shape as
  // the theme above, and one request for both, because they are one row.
  const page = build({ lang: 'en', apiImpl: async () => ({ prefs: { uiLang: 'fr' } }) });
  await page.adoptAccountPrefs();
  assert.equal(page.langState.lang, 'fr');
  assert.equal(page.$('set-lang').value, 'fr');
  assert.ok(page.drew.length > 0, 'the page adopted the language without redrawing itself');
});

test('an account with no opinion about the language leaves this browser alone', async () => {
  const page = build({ lang: 'fr', apiImpl: async () => ({ prefs: {} }) });
  await page.adoptAccountPrefs();
  assert.equal(page.langState.lang, 'fr');
  assert.deepEqual(page.drew, [], 'a shrug was read as an instruction');
});

test('a silent extension is said out loud instead of confirmed', async () => {
  const page = build({ answer: null });
  await change(page, 'set-mode', { value: 'ltr' });
  // "Saved ✓" here would leave the control showing an answer over a setting
  // that never changed, and the reader would find it back on the old one.
  assert.match(page.$('set-status').textContent, /did not answer/);
});

// --- the account --------------------------------------------------------------

test('signing out goes through the app, not through the extension', async () => {
  const page = build();
  await page.$('set-signout').handlers.click();
  assert.equal(page.signedOut(), 1);
});

test('a new password is asked for by mail, at the same route as the signed-out screen', async () => {
  const page = build();
  await page.$('set-password').handlers.click();
  // Changing a password takes a link in an inbox, not a form in a tab somebody
  // else may have left open — and the same route means one rate limit.
  assert.deepEqual(page.calls.at(-1), {
    path: '/auth/forgot', method: 'POST', body: { email: 'reader@example.com' },
  });
  assert.equal(page.$('set-account-msg').textContent, 'sent');
  assert.equal(page.$('set-account-msg').hidden, false);
  // Or it would stay disabled after the one failure it is most likely to see.
  assert.equal(page.$('set-password').disabled, false);
});

test('a server that refuses says why, and the button comes back', async () => {
  const page = build({ apiImpl: async () => { throw new Error('too many requests'); } });
  await page.$('set-password').handlers.click();
  assert.equal(page.$('set-account-msg').textContent, 'too many requests');
  assert.equal(page.$('set-password').disabled, false);
});

// --- the two settings pages, side by side --------------------------------------

/** The values a <select id="…"> offers, in order. */
const options = (markup, id) => {
  const block = markup.slice(markup.indexOf(`id="${id}"`));
  return [...block.slice(0, block.indexOf('</select>')).matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
};

test('both settings pages offer the same answers to the same questions', () => {
  // The reader who sets "double page, right to left" in the app and finds the
  // extension's own page showing a blank select is looking at this drifting.
  for (const [here, there] of [
    ['set-mode', 'readerMode'],
    ['set-tapzones', 'tapZones'],
    ['set-interval', 'checkInterval'],
    ['set-lang', 'uiLang'],
    ['set-theme', 'theme'],
  ]) {
    assert.deepEqual(options(html, here), options(optionsHtml, there), here);
  }
});

test('the language picker offers exactly the languages the extension ships', () => {
  assert.deepEqual(options(html, 'set-lang'),
    ['auto', ...readdirSync(join(root, 'extension', '_locales'))]);
});

test('Settings is a view of its own, and the extension can point straight at it', () => {
  assert.match(src, /const VIEWS = \[[^\]]*'settings'/);
  assert.match(html, /data-view="settings"/);
  // The extension's options page links here with `#settings`. The fragment is
  // read once and dropped, so Back and reload behave like the rest of the app.
  const boot = src.slice(src.indexOf("location.hash === '#settings'"));
  assert.ok(boot, 'nothing handles the #settings fragment the extension links to');
  assert.match(boot.slice(0, 200), /history\.replaceState[\s\S]*showView\('settings'\)/);
});
