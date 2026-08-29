// The first two minutes, pinned.
//
// A fresh install of PanelFlow is invisible on purpose: the toolbar button is
// behind Chrome's puzzle piece, and on any page that is not a chapter the
// extension is correctly silent. Someone handed the folder by a friend cannot
// tell that apart from a broken install — which is what the setup page is for.
//
// Three classes of thing are checked here, because three different mistakes
// would each turn the page back into decoration:
//
//   1. It has to open, once, on install and not on update.
//   2. Answering a step has to write the real setting, so that closing the tab
//      halfway does not throw the answers away.
//   3. The last step must not read as a list of the sites that work. It used
//      to be one, and PanelFlow recognises most sites it was never told about
//      — so a reader whose site was missing from it was told the opposite of
//      the truth.
//
// The behaviour is lifted out of the shipping welcome.js with `new Function`
// rather than restated, so a test cannot pass against a rule that only exists
// in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, PanelFlowI18n } from './helpers/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const js = read('extension/welcome/welcome.js');
/** The last step's markup, on its own. */
const s4 = (markup) => markup.slice(markup.indexOf('data-step="3" hidden'), markup.indexOf('</main>'));
const html = read('extension/welcome/welcome.html');
const background = read('extension/background.js');
const popup = read('extension/popup/popup.js');

// The real send.js, not a stub of it: the page's messaging is what these tests
// drive, and a stub here would go on passing the day the retry it wraps breaks.
// One per page, because it closes over that page's `chrome`.
const sendJs = read('extension/send.js');
const sendFor = (chrome) => {
  const self = {};
  new Function('self', 'chrome', sendJs)(self, chrome);
  return self.PanelFlowSend;
};

/** One slice of welcome.js, run as written, with its free names passed in. */
const lift = (startMark, endMark, params, exported) => {
  const from = js.indexOf(startMark);
  const to = js.indexOf(endMark);
  assert.ok(from !== -1 && to > from, `${startMark.trim()} is not where this test expects it`);
  return new Function(...params, `${js.slice(from, to)}\nreturn ${exported};`);
};

// --- 1. it opens once ---------------------------------------------------------

test('the setup page ships as a real page', () => {
  for (const file of ['welcome.html', 'welcome.js', 'welcome.css']) {
    assert.ok(existsSync(join(root, 'extension', 'welcome', file)), `welcome/${file} is missing`);
  }
  // The stylesheet and the script are the two things a page cannot inline under
  // MV3's content security policy, so a wrong path here is a blank page.
  assert.match(html, /<link rel="stylesheet" href="welcome\.css">/);
  assert.match(html, /<script src="welcome\.js"><\/script>/);
});

test('install opens it, update does not', () => {
  const listener = background.slice(
    background.indexOf('chrome.runtime.onInstalled.addListener'),
    background.indexOf('chrome.alarms.onAlarm.addListener'),
  );
  assert.ok(listener.includes('welcome/welcome.html'), 'onInstalled never opens the setup page');
  assert.match(listener, /reason === 'install'/,
    'the setup page would reopen on every update, mid-chapter');

  // Regression guard on the listener this edit went into: it is also the only
  // place the chapter alarm is created and the ad-block rules first applied.
  assert.match(listener, /chrome\.alarms\.create\('pf-check-chapters'/);
  assert.match(listener, /applyAdblock\(\)/);
  // And the tab is created before the first await, so a backend that is down
  // cannot swallow the one signal that the extension installed.
  assert.ok(listener.indexOf('chrome.tabs.create') < listener.indexOf('await core.getSettings'),
    'an unreachable backend would cost the user the setup page');
});

test('there is a way back to it', () => {
  assert.match(read('extension/options/options.js'), /welcome\/welcome\.html/);
  // The link lives inside a translated sentence, so the markup only says where
  // the sentence goes and the locale file carries the anchor. A translator who
  // drops the <a> takes the only route back to the tour with it — which is what
  // this checks, in every language shipped and not just the default one.
  assert.match(read('extension/options/options.html'), /data-i18n-html="optionsReplayHint"/);
  for (const lang of readdirSync(join(root, 'extension', '_locales'))) {
    const msg = JSON.parse(read(`extension/_locales/${lang}/messages.json`)).optionsReplayHint;
    assert.match(msg.message, /id="replay"/, `${lang} lost the replay link`);
  }
});

// --- 2. answering a step writes the setting ----------------------------------

/** The page reduced to what welcome.js touches. */
function stubPage(theme = stubTheme()) {
  const written = {};
  /** Every tab the page asked Chrome to open, in order. */
  const opened = [];
  const make = (attrs = {}) => ({
    ...attrs,
    hidden: false,
    value: '',
    textContent: '',
    className: '',
    dataset: attrs.dataset || {},
    classes: new Set(),
    handlers: {},
    children: [],
    addEventListener(type, fn) { this.handlers[type] = fn; },
    append(...kids) { this.children.push(...kids); },
    appendChild(kid) { this.children.push(kid); },
    classList: {
      toggle(name, on) { if (on) this.owner.classes.add(name); else this.owner.classes.delete(name); },
    },
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    click() { return this.handlers.click && this.handlers.click({ target: this }); },
  });
  const el = (attrs) => { const e = make(attrs); e.classList.owner = e; return e; };

  const choiceOn = el({ dataset: { auto: 'on' } });
  const choiceOff = el({ dataset: { auto: 'off' } });
  const themes = Object.fromEntries(['system', 'light', 'dark'].map(
    (name) => [name, el({ dataset: { themeChoice: name } })]));
  const dots = [0, 1, 2, 3].map((n) => el({ dataset: { step: String(n) } }));
  const steps = [0, 1, 2, 3].map((n) => el({ dataset: { step: String(n) } }));

  const byId = {
    '#readerMode': el(), '#auth-form': el(), '#auth-done': el(), '#who': el(),
    '#auth-msg': el(), '#register': el(), '#login': el(), '#account-next': el(),
    '#email': el(), '#password': el(),
    '#finish': el(), '#skip': el(),
  };
  // As the markup ships them: the account block and the fallback line start
  // hidden, and a test that started them visible could not tell "never shown"
  // from "shown and then hidden".
  byId['#auth-done'].hidden = true;
  // And the way out of the account step, which the markup ships hidden because
  // there is no longer supposed to be one.
  byId['#skip'].hidden = true;

  const bySelector = {
    // `[data-auto]` and not `.choice`: the theme cards on step one wear that
    // class too, and a handler that answered to both would write "only when I
    // ask" every time somebody picked a colour.
    '[data-auto]': [choiceOn, choiceOff],
    '[data-theme-choice]': Object.values(themes),
    '.step': steps,
    '.dots li': dots,
    '[data-go]': [],
  };

  const document = {
    querySelector: (sel) => byId[sel],
    querySelectorAll: (sel) => bySelector[sel] || [],
    createElement: () => el(),
  };
  const chrome = {
    storage: { local: {
      get: async () => ({}),
      set: async (obj) => Object.assign(written, obj),
    } },
    runtime: {
      getURL: (p) => `chrome-extension://pf${p}`,
      sendMessage: (msg, cb) => { chrome.sent.push(msg); cb(chrome.replies[msg.type] ?? {}); },
    },
    tabs: {
      getCurrent: (cb) => cb({ id: 42 }),
      remove: (id) => { written.removedTab = id; },
      create: (opts) => { opened.push(opts); },
    },
    replies: {},
    sent: [],
  };
  return {
    document, chrome, written, byId, choiceOn, choiceOff, themes, dots, steps, opened,
    window: { scrollTo() {}, close() { written.closedWindow = true; }, panelflowTheme: theme },
    location: { href: '' },
  };
}

/**
 * shared/theme.js as the page finds it.
 *
 * The real one runs from <head>, before welcome.js is even fetched, and keeps
 * its answer in this origin's localStorage rather than in chrome.storage — so
 * "what theme is showing" is a question welcome.js can only ask through this
 * object, and a stub of it is the only way to see what the page did.
 */
function stubTheme(initial = 'system') {
  let value = initial;
  return {
    get: () => value,
    set: (v) => { value = v; },
    /** Returns whether anything changed, exactly as the shipping one does. */
    adopt: (v) => {
      if (v == null || v === value) return false;
      value = v;
      return true;
    },
  };
}

/** welcome.js, whole, over the stub page. Returns the internals it declares. */
function boot(page) {
  const body = js
    .replace(/^'use strict';$/m, '')
    // The IIFE at the end reads storage and paints; the tests drive the parts
    // they are about directly, and a floating promise would race them.
    .replace(/\(async function boot\(\)[\s\S]*$/, '');
  const fn = new Function('document', 'chrome', 'window', 'location', 't', 'PanelFlowI18n', 'PanelFlowSend',
    `${body}\nreturn { show, finish, paintAuto, signedIn };`);
  return fn(page.document, page.chrome, page.window, page.location, t, PanelFlowI18n, sendFor(page.chrome));
}

/** The same file WITH its boot(), over a storage that already holds `stored`. */
async function bootFull(page, stored) {
  page.chrome.storage.local.get = async () => stored;
  const body = js
    .replace(/^'use strict';$/m, '')
    // Handed back so the test can await it: the paint happens after two awaits,
    // and a test that only assumed it had run would pass on a page that never
    // painted at all.
    .replace(/\(async function boot\(\)/, 'const booted = (async function boot()');
  const fn = new Function('document', 'chrome', 'window', 'location', 't', 'PanelFlowI18n', 'PanelFlowSend',
    `${body}\nreturn booted.then(() => ({ show, finish, signedIn }));`);
  return fn(page.document, page.chrome, page.window, page.location, t, PanelFlowI18n, sendFor(page.chrome));
}

test('picking a theme applies it, lights the card and puts it on the account', async () => {
  const page = stubPage();
  boot(page);

  await page.themes.dark.click();
  assert.equal(page.window.panelflowTheme.get(), 'dark');
  assert.ok(page.themes.dark.classes.has('on'));
  assert.equal(page.themes.dark.attrs['aria-pressed'], 'true');
  assert.equal(page.themes.system.attrs['aria-pressed'], 'false');
  // Sideways *and* out. localStorage is what makes the popup and the saved
  // chapters agree without waking anything; the account is what makes the
  // website and the phone agree, and a reader who sets it here and opens the
  // site expects to find it there.
  assert.deepEqual(
    page.chrome.sent.filter((m) => m.type === 'setPrefs').map((m) => m.patch),
    [{ theme: 'dark' }]);

  await page.themes.light.click();
  assert.equal(page.window.panelflowTheme.get(), 'light');
  assert.ok(!page.themes.dark.classes.has('on'));
  assert.equal(page.themes.dark.attrs['aria-pressed'], 'false');
});

test('a theme card is not an answer about when the reader opens', async () => {
  // The two sets of cards wear `.choice` for the same look. A handler keyed on
  // the class rather than on `[data-auto]` would have picking a colour also
  // answer "only when I ask" — silently, one step before that is even asked.
  const page = stubPage();
  boot(page);
  await page.themes.light.click();
  assert.equal(page.written.autoShowDefault, undefined);
});

test('an account that already has a theme wins over this browser', async () => {
  const page = stubPage(stubTheme('dark'));
  page.chrome.replies.auth = { user: { email: 'r@example.com' }, prefs: { theme: 'light' } };
  boot(page);
  await page.byId['#login'].handlers.click();
  // Someone signing in answered this question somewhere else already; what is
  // on this install is the default it shipped with.
  assert.equal(page.window.panelflowTheme.get(), 'light');
  assert.ok(page.themes.light.classes.has('on'));
  // Adopted, not echoed back — the account is where it came from.
  assert.equal(page.chrome.sent.filter((m) => m.type === 'setPrefs').length, 0);
});

test('a new account is handed the theme just chosen', async () => {
  const page = stubPage();
  page.chrome.replies.auth = { user: { email: 'r@example.com' }, prefs: {} };
  boot(page);
  await page.themes.dark.click();
  await page.byId['#register'].handlers.click();
  // Twice, and both are needed: the first write happened while there was no
  // account to put it on, and signing in replaces the cached settings with
  // whatever the server holds — which, for an account made thirty seconds ago,
  // is nothing.
  assert.deepEqual(
    page.chrome.sent.filter((m) => m.type === 'setPrefs').map((m) => m.patch),
    [{ theme: 'dark' }, { theme: 'dark' }]);
});

test('an account with no theme is not given one nobody chose', async () => {
  const page = stubPage();
  page.chrome.replies.auth = { user: { email: 'r@example.com' }, prefs: {} };
  boot(page);
  await page.byId['#register'].handlers.click();
  // 'system' from someone who walked past the control is not an opinion, and
  // writing it would be this page inventing one for every other device.
  assert.equal(page.chrome.sent.filter((m) => m.type === 'setPrefs').length, 0);
});

test('replaying the tour shows the theme that is actually in force', async () => {
  const page = stubPage(stubTheme('light'));
  await bootFull(page, { accountPrefs: { theme: 'dark' } });
  assert.equal(page.window.panelflowTheme.get(), 'dark');
  assert.ok(page.themes.dark.classes.has('on'));
  // Shown, not re-saved: looking at a settings screen may not change it.
  assert.equal(page.chrome.sent.filter((m) => m.type === 'setPrefs').length, 0);
});

test('choosing when the reader opens writes it immediately', async () => {
  const page = stubPage();
  boot(page);

  await page.choiceOn.click();
  assert.equal(page.written.autoShowDefault, true);
  assert.ok(page.choiceOn.classes.has('on'));
  assert.ok(!page.choiceOff.classes.has('on'));

  await page.choiceOff.click();
  assert.equal(page.written.autoShowDefault, false);
  assert.ok(page.choiceOff.classes.has('on'));
});

test('the reading direction is written on change, not on Next', async () => {
  const page = stubPage();
  boot(page);
  const select = page.byId['#readerMode'];
  await select.handlers.change({ target: { value: 'spread-rtl' } });
  assert.equal(page.written.readerMode, 'spread-rtl');
});

test('every mode the tour offers is a mode the options page can show', () => {
  const modes = (src, id) => {
    const block = src.slice(src.indexOf(`id="${id}"`));
    return [...block.slice(0, block.indexOf('</select>')).matchAll(/value="([^"]+)"/g)]
      .map((m) => m[1]);
  };
  // Otherwise picking one here leaves the options page showing a blank select,
  // and saving there silently reverts the choice.
  assert.deepEqual(modes(html, 'readerMode'),
    modes(read('extension/options/options.html'), 'readerMode'));
});

test('a failed sign-in says so instead of pretending', async () => {
  const page = stubPage();
  page.chrome.replies.auth = { error: 'wrong password' };
  boot(page);
  await page.byId['#login'].handlers.click();
  assert.equal(page.byId['#auth-msg'].textContent, 'wrong password');
  assert.match(page.byId['#auth-msg'].className, /err/);
  assert.equal(page.byId['#auth-done'].hidden, true);
});

test('no answer at all is a different message from a rejected password', async () => {
  const page = stubPage();
  page.chrome.runtime.sendMessage = (_msg, cb) => cb(undefined);
  boot(page);
  await page.byId['#register'].handlers.click();
  assert.match(page.byId['#auth-msg'].textContent, /No answer from the server/);
});

test('signing in swaps the form for the account and opens the way on', async () => {
  const page = stubPage();
  page.chrome.replies.auth = { user: { email: 'reader@example.com' } };
  const api = boot(page);
  api.signedIn(null);
  assert.equal(page.byId['#account-next'].disabled, true);

  await page.byId['#register'].handlers.click();
  assert.equal(page.byId['#auth-form'].hidden, true);
  assert.equal(page.byId['#auth-done'].hidden, false);
  assert.equal(page.byId['#who'].textContent, 'reader@example.com');
  assert.equal(page.byId['#account-next'].disabled, false);
});

test('there is no way past the account step without one', async () => {
  // The wall, at the three places it has to hold at once.
  //
  // In the markup, because a button that only becomes disabled once a script
  // has run is a button that is clickable on a slow morning.
  assert.match(html, /id="account-next"[^>]*\sdisabled/,
    'the way on ships enabled and is only closed later');
  // In the offer, because the tour used to have a second button on this step
  // that walked straight past it.
  assert.ok(!/welcomeKeepLocal/.test(html) && !/welcomeKeepLocal/.test(js),
    'the tour still offers to keep everything on this computer');
  for (const lang of readdirSync(join(root, 'extension', '_locales'))) {
    assert.ok(!('welcomeKeepLocal' in JSON.parse(read(`extension/_locales/${lang}/messages.json`))),
      `${lang} still carries the offer`);
  }
  // And on the page a returning reader sees, where the answer comes out of
  // storage rather than out of a click.
  const out = stubPage();
  await bootFull(out, {});
  assert.equal(out.byId['#account-next'].disabled, true);

  const inn = stubPage();
  await bootFull(inn, { authUser: { email: 'reader@example.com' } });
  assert.equal(inn.byId['#account-next'].disabled, false);
});

test('a server that never answered leaves a door; a wrong password does not', async () => {
  // A required step nobody can finish is a tab with no way out of it. So the
  // exit exists — but only for the failure the reader cannot do anything
  // about, and only once they have hit it.
  const rejected = stubPage();
  rejected.chrome.replies.auth = { error: 'That password does not match.' };
  boot(rejected);
  await rejected.byId['#register'].handlers.click();
  assert.equal(rejected.byId['#skip'].hidden, true);

  const silent = stubPage();
  silent.chrome.runtime.sendMessage = (_msg, cb) => cb(undefined);
  boot(silent);
  assert.equal(silent.byId['#skip'].hidden, true, 'the door was open before it was needed');
  await silent.byId['#register'].handlers.click();
  assert.equal(silent.byId['#skip'].hidden, false);
});

test('a first run starts on the answer the page recommends, and means it', async () => {
  const page = stubPage();
  await bootFull(page, {});
  assert.ok(page.choiceOn.classes.has('on'));
  // Painted and written, not painted only: someone who clicks Next without
  // touching a card has still agreed to the card that is lit.
  assert.equal(page.written.autoShowDefault, true);
});

test('replaying the tour shows what is set and changes nothing', async () => {
  const off = stubPage();
  await bootFull(off, { autoShowDefault: false, readerMode: 'rtl' });
  assert.ok(off.choiceOff.classes.has('on'));
  assert.equal(off.written.autoShowDefault, undefined);
  assert.equal(off.byId['#readerMode'].value, 'rtl');

  // The old key, from before the per-site override existed. Still an answer,
  // so the first-run write must not fire over it either.
  const legacy = stubPage();
  await bootFull(legacy, { settings: { autoOpenReader: true } });
  assert.ok(legacy.choiceOn.classes.has('on'));
  assert.equal(legacy.written.autoShowDefault, undefined);
});

test('leaving marks the tour done — by either door', async () => {
  for (const door of ['#finish', '#skip']) {
    const page = stubPage();
    boot(page);
    await page.byId[door].handlers.click();
    assert.equal(page.written.welcomeSeen, true, `${door} did not mark it seen`);
    // The tab was opened by the service worker, so window.close() is not
    // allowed on it and chrome.tabs has to do the closing.
    assert.equal(page.written.removedTab, 42);
  }
});

// --- 3. the last step promises nothing it cannot keep -------------------------

test('the last step names no site, on the page or in either locale', () => {
  const step = s4(html);
  // No list, no cards, no container for either. The step used to draw the
  // domains shipping tuned rules, which reads as the set that works — and the
  // reader whose site was not among them was told the opposite of the truth,
  // because PanelFlow recognises most sites it has never been told about.
  assert.ok(!/id="sites"|data-host|sites-msg/.test(step), 'the site picker is back in the markup');
  assert.ok(!js.includes('loadSites'), 'welcome.js still builds a site list');
  for (const key of ['welcomeStep4Title', 'welcomeStep4Lede', 'welcomeStep4Lede2', 'welcomeStep4Hint']) {
    assert.ok(step.includes(key), `step four no longer shows ${key}`);
  }

  // And not in the words either, which is the half a deleted <ul> does not
  // cover: naming three sites in a sentence makes the same promise the list
  // did. What the step says instead is checkable in a second — open a chapter
  // and see — which is the only promise this page is in a position to make.
  const tuned = Object.keys(JSON.parse(read('shared/detection-rules.json')).domains)
    .map((pattern) => pattern.replace(/^\*\./, ''));
  assert.ok(tuned.length >= 40, `only ${tuned.length} tuned domains — did the rules move?`);
  for (const locale of ['fr', 'en']) {
    const messages = JSON.parse(read(`shared/_locales/${locale}/messages.json`));
    const copy = ['welcomeStep4Title', 'welcomeStep4Lede', 'welcomeStep4Lede2', 'welcomeStep4Hint']
      .map((key) => {
        assert.ok(messages[key], `${locale} is missing ${key}`);
        return messages[key].message;
      }).join(' ');
    for (const host of tuned) {
      assert.ok(!copy.includes(host), `the last step names ${host} in ${locale}`);
    }
  }
});

test('the last step still tells the reader where to go and how to tell', () => {
  // The list was answering a real question — "so what do I do now?" — and
  // deleting it without answering it would leave a congratulations screen.
  for (const locale of ['fr', 'en']) {
    const m = JSON.parse(read(`shared/_locales/${locale}/messages.json`));
    const copy = ['welcomeStep4Lede', 'welcomeStep4Lede2', 'welcomeStep4Hint']
      .map((key) => m[key].message).join(' ');
    // Where to go, what tells them it worked, and the shortcut that works
    // anywhere — the three things they cannot find out by looking at the page.
    assert.match(copy, /scan/i);
    assert.match(copy, /Alt/);
    assert.match(copy, /PanelFlow/);
  }
});

test('favourite sites are a setting the worker will actually forward', () => {
  // The tour no longer asks for them; the phone and the website do, and the
  // popup below reads them back. setPrefs keeps an explicit list of what may
  // reach the account and drops a patch for anything else without a word, so
  // dropping the key here would leave three screens saving nothing.
  assert.match(background, /pick\(patch, \[[^\]]*'favouriteSites'/);
  assert.match(read('shared/prefs.js'), /favouriteSites: \{ hosts: true/);
});

/**
 * The popup's site list, built as the shipping popup builds it.
 *
 * Two slices of popup.js, because the ordering constant is declared just above
 * the handler that uses it and a copy of it here would be a test agreeing with
 * itself. `sites` is the popup's own module-level variable, declared into the
 * body rather than passed, and handed back so the order can be looked at.
 */
function popupSites(chrome, state) {
  // From `bareHost` rather than from SITE_KINDS: the helper used to be lifted
  // out of welcome.js, which no longer has one, and popup.js declares its own
  // just above the constant.
  const kinds = popup.slice(popup.indexOf('const bareHost = '), popup.indexOf("$('#open-sites').addEventListener"));
  const body = popup.slice(
    popup.indexOf('const { rulesCache, accountPrefs }'), popup.indexOf("renderSites('')"));
  assert.ok(kinds.includes('favourite') && body.includes('favouriteSites'),
    'the popup no longer knows which sites are favourites');
  const fn = new Function('chrome', 'state',
    `${kinds}\nlet sites;\nreturn (async () => {\n${body}\nreturn sites;\n})();`);
  return fn(chrome, state);
}

test('the favourite sites come first in the popup, and say why', async () => {
  // Marking four sites out of forty is worth nothing if the list that shows
  // them is still alphabetical.
  const stored = {
    rulesCache: { rules: { domains: { '*.mangadex.org': {}, 'sushiscan.fr': {}, 'aaa.example': {} } } },
    accountPrefs: { favouriteSites: ['sushiscan.fr'] },
  };
  const chrome = { storage: { local: { get: async () => stored } } };
  const sites = await popupSites(chrome, { library: [{ sourceDomain: 'zzz.example' }] });

  assert.deepEqual(sites.map((s) => s.host),
    ['sushiscan.fr', 'aaa.example', 'mangadex.org', 'zzz.example']);
  assert.deepEqual(sites.map((s) => s.kind),
    ['favourite', 'tuned', 'tuned', 'library']);
});

test('a favourite whose tuned rule was retired is still a favourite', async () => {
  // The rules file is ours and changes without asking anybody. A site somebody
  // told us they read does not stop being one because a rule for it was
  // dropped — it just stops being tuned.
  const stored = {
    rulesCache: { rules: { domains: { 'mangadex.org': {} } } },
    accountPrefs: { favouriteSites: ['gone.example'] },
  };
  const chrome = { storage: { local: { get: async () => stored } } };
  const sites = await popupSites(chrome, { library: [] });
  assert.deepEqual(sites, [
    { host: 'gone.example', kind: 'favourite' },
    { host: 'mangadex.org', kind: 'tuned' },
  ]);
});

test('an account that has chosen nothing gets the list it always got', async () => {
  const chrome = { storage: { local: { get: async () => ({
    rulesCache: { rules: { domains: { 'mangadex.org': {}, 'aaa.example': {} } } },
  }) } } };
  const sites = await popupSites(chrome, { library: [] });
  assert.deepEqual(sites.map((s) => s.host), ['aaa.example', 'mangadex.org']);
  assert.ok(sites.every((s) => s.kind === 'tuned'));
});

test('the popup list was opening a search query, and no longer is', () => {
  // Same bug, same fix, one file over: the compatible-sites panel built its
  // rows straight from the pattern keys.
  assert.match(popup, /const bareHost = /);
  const panel = popup.slice(popup.indexOf("$('#open-sites')"), popup.indexOf('function faviconUrl'));
  assert.match(panel, /\.map\(bareHost\)/);
  assert.ok(!/Object\.keys\(rulesCache\?\.rules\?\.domains \|\| \{\}\);/.test(panel),
    'the panel still keys its rows on the raw pattern');
});
