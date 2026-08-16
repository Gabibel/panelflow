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
//   3. The domain list has to be openable — the rules are keyed by *pattern*,
//      and `https://*.mangadex.org/` is a search query, not a site.
//
// The behaviour is lifted out of the shipping welcome.js with `new Function`
// rather than restated, so a test cannot pass against a rule that only exists
// in this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const js = read('extension/welcome/welcome.js');
const html = read('extension/welcome/welcome.html');
const background = read('extension/background.js');
const popup = read('extension/popup/popup.js');

/** One slice of welcome.js, run as written, with its free names passed in. */
const lift = (startMark, endMark, params, exported) => {
  const from = js.indexOf(startMark);
  const to = js.indexOf(endMark);
  assert.ok(from !== -1 && to > from, `${startMark.trim()} is not where this test expects it`);
  return new Function(...params, `${js.slice(from, to)}\nreturn ${exported};`);
};

const hostHelpers = lift(
  '/**\n * A rules key as a hostname', '// --- navigation',
  [], '{ bareHost, tunedHosts }')();

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
  assert.match(read('extension/options/options.html'), /id="replay"/);
});

// --- 2. answering a step writes the setting ----------------------------------

/** The page reduced to what welcome.js touches. */
function stubPage() {
  const written = {};
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
    click() { return this.handlers.click && this.handlers.click({ target: this }); },
  });
  const el = (attrs) => { const e = make(attrs); e.classList.owner = e; return e; };

  const choiceOn = el({ dataset: { auto: 'on' } });
  const choiceOff = el({ dataset: { auto: 'off' } });
  const dots = [0, 1, 2, 3].map((n) => el({ dataset: { step: String(n) } }));
  const steps = [0, 1, 2, 3].map((n) => el({ dataset: { step: String(n) } }));

  const byId = {
    '#readerMode': el(), '#auth-form': el(), '#auth-done': el(), '#who': el(),
    '#auth-msg': el(), '#register': el(), '#login': el(), '#account-next': el(),
    '#email': el(), '#password': el(),
    '#finish': el(), '#skip': el(), '#sites': el(), '#sites-msg': el(),
  };
  // As the markup ships them: the account block and the fallback line start
  // hidden, and a test that started them visible could not tell "never shown"
  // from "shown and then hidden".
  byId['#auth-done'].hidden = true;
  byId['#sites-msg'].hidden = true;

  const bySelector = {
    '.choice': [choiceOn, choiceOff],
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
      sendMessage: (msg, cb) => cb(chrome.replies[msg.type] ?? {}),
    },
    tabs: { getCurrent: (cb) => cb({ id: 42 }), remove: (id) => { written.removedTab = id; } },
    replies: {},
  };
  return {
    document, chrome, written, byId, choiceOn, choiceOff, dots, steps,
    window: { scrollTo() {}, close() { written.closedWindow = true; } },
    location: { href: '' },
  };
}

/** welcome.js, whole, over the stub page. Returns the internals it declares. */
function boot(page) {
  const body = js
    .replace(/^'use strict';$/m, '')
    // The IIFE at the end reads storage and paints; the tests drive the parts
    // they are about directly, and a floating promise would race them.
    .replace(/\(async function boot\(\)[\s\S]*$/, '');
  const fn = new Function('document', 'chrome', 'window', 'location',
    `${body}\nreturn { show, finish, loadSites, paintAuto, tunedHosts, bareHost, signedIn };`);
  return fn(page.document, page.chrome, page.window, page.location);
}

/** The same file WITH its boot(), over a storage that already holds `stored`. */
async function bootFull(page, stored) {
  page.chrome.storage.local.get = async () => stored;
  const body = js
    .replace(/^'use strict';$/m, '')
    // Handed back so the test can await it: the paint happens after two awaits,
    // and a test that only assumed it had run would pass on a page that never
    // painted at all.
    .replace(/\(async function boot\(\)/, 'return (async function boot()');
  const fn = new Function('document', 'chrome', 'window', 'location', body);
  await fn(page.document, page.chrome, page.window, page.location);
}

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

test('signing in swaps the form for the account, and Skip stops being a skip', async () => {
  const page = stubPage();
  page.chrome.replies.auth = { user: { email: 'reader@example.com' } };
  boot(page);
  await page.byId['#register'].handlers.click();
  assert.equal(page.byId['#auth-form'].hidden, true);
  assert.equal(page.byId['#auth-done'].hidden, false);
  assert.equal(page.byId['#who'].textContent, 'reader@example.com');
  assert.equal(page.byId['#account-next'].textContent, 'Next');
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

// --- 3. the list has to be openable ------------------------------------------

test('a rules pattern becomes a hostname you can actually open', () => {
  assert.equal(hostHelpers.bareHost('*.mangadex.org'), 'mangadex.org');
  assert.equal(hostHelpers.bareHost('sushiscan.fr'), 'sushiscan.fr');
  assert.equal(hostHelpers.bareHost(undefined), '');
});

test('the tuned list is the real rules file, deduped and sorted', () => {
  const rules = JSON.parse(read('shared/detection-rules.json'));
  const hosts = hostHelpers.tunedHosts(rules);
  assert.ok(hosts.length >= 40, `only ${hosts.length} tuned domains — did the rules move?`);
  assert.ok(hosts.includes('mangadex.org'));
  // The French sites are the ones the nearest competitor is asked for and does
  // not have; a new user landing here should see them.
  assert.ok(hosts.includes('sushiscan.fr'));
  assert.deepEqual(hosts, [...hosts].sort((a, b) => a.localeCompare(b)));
  assert.equal(hosts.filter((h) => h.includes('*')).length, 0);
  assert.equal(new Set(hosts).size, hosts.length);
});

test('the list still draws when the rules server is down', async () => {
  const page = stubPage();
  page.chrome.replies.getRules = { rules: null };
  const api = boot(page);
  await api.loadSites();
  assert.equal(page.byId['#sites-msg'].hidden, false);
  assert.match(page.byId['#sites-msg'].textContent, /Alt\+R/);
  assert.equal(page.byId['#sites'].children.length, 0);
});

test('picking a site leaves for it, tour marked done', async () => {
  const page = stubPage();
  page.chrome.replies.getRules = { rules: { domains: { '*.mangadex.org': {} } } };
  const api = boot(page);
  await api.loadSites();
  assert.equal(page.byId['#sites'].children.length, 1);
  await page.byId['#sites'].children[0].handlers.click();
  assert.equal(page.written.welcomeSeen, true);
  assert.equal(page.location.href, 'https://mangadex.org/');
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
