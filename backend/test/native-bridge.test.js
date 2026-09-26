// The phone's in-app browser, and what a page in it can reach.
//
// A WebView has no isolated world: the extension's content scripts, injected
// into a site, share their JavaScript world with the site's own scripts and
// adverts. The QA pass of September 2026 showed what that meant with a shim on
// `window`: a hostile page read the account's e-mail and every bookmark, and
// wrote a series into the synced library, in a few lines.
//
// Three layers now, each tested on its own below:
//   1. the shim is private — no `window.chrome` — and signs every request with
//      a key only the injection knows (mobile/inject/chrome-shim.js);
//   2. the shell refuses anything unsigned (native/src/screens/BrowserScreen.js);
//   3. what a signed request is answered is narrowed to the site being read,
//      and a write has to be about that site (native/src/core.js).
//
// The shell modules import React Native, so, as native-shell.test.js does, the
// code under test is lifted out of the shipped files and run against stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const KEY = 'k3y-0f-th1s-br0ws3r';

/** chrome-shim.js in a fake page, with or without a key in scope. */
function shimIn({ key } = {}) {
  const posted = [];
  const window = {
    PanelFlowNative: { post: (s) => posted.push(JSON.parse(s)) },
  };
  const src = read('mobile', 'inject', 'chrome-shim.js');
  const run = key === undefined
    ? new Function('window', 'location', 'document', 'globalThis', src)
    : new Function('window', 'location', 'document', 'globalThis', '__pfKey', src);
  run(window, { href: 'https://scan.test/manga/x/chapter-1' }, { title: 'x' }, window, key);
  return { window, posted };
}

test('with a key, the shim is not on window and answers only that key', () => {
  const { window, posted } = shimIn({ key: KEY });
  assert.equal(window.chrome, undefined, 'a page can call whatever sits on window.chrome');
  assert.equal(typeof window.__pfPrivateChrome, 'function');
  assert.equal(window.__pfPrivateChrome('a guess'), null);
  const chrome = window.__pfPrivateChrome(KEY);
  assert.ok(chrome?.runtime?.sendMessage, 'the injected scripts get their shim');

  chrome.runtime.sendMessage({ type: 'getAccount' });
  assert.equal(posted.at(-1).k, KEY, 'every request carries the key');
  assert.equal(posted.at(-1).msg.type, 'getAccount');
});

test('with a key, the page cannot replace the handles or answer for the shell', async () => {
  const { window } = shimIn({ key: KEY });
  assert.throws(() => { 'use strict'; window.__pfPrivateChrome = () => ({}); });
  assert.throws(() => { 'use strict'; window.PanelFlowPage = {}; });

  const chrome = window.__pfPrivateChrome(KEY);
  const asked = chrome.runtime.sendMessage({ type: 'getProgressFor', chapterUrl: 'x' });
  // A page calling deliver without the key is ignored...
  window.PanelFlowPage.deliver(1, JSON.stringify({ progress: 'forged' }));
  // ...and the shell's own answer, with it, is taken.
  window.PanelFlowPage.deliver(1, JSON.stringify({ progress: 'real' }), KEY);
  assert.deepEqual(await asked, { progress: 'real' });
});

test('without a key the Kotlin and Swift shells get the shim they always had', () => {
  const { window, posted } = shimIn();
  assert.ok(window.chrome?.runtime?.__panelflowShim);
  window.chrome.runtime.sendMessage({ type: 'getRules' });
  assert.equal(posted.at(-1).k, undefined);
});

test('the transport is taken once, so swapping it later reads nothing', () => {
  const { window, posted } = shimIn({ key: KEY });
  const stolen = [];
  window.PanelFlowNative = { post: (s) => stolen.push(s) };
  window.__pfPrivateChrome(KEY).runtime.sendMessage({ type: 'getRules' });
  assert.equal(stolen.length, 0);
  assert.equal(posted.at(-1).msg.type, 'getRules');
});

test('the browser signs its injections and refuses what is unsigned', () => {
  const screen = read('native', 'src', 'screens', 'BrowserScreen.js');
  assert.match(screen, /if \(payload\.k !== secret\)/, 'unsigned requests are answered');
  assert.match(screen, /injectedJavaScriptBeforeContentLoaded=\{`[^`]*\$\{keyed\(early, secret\)\}`\}/s);
  assert.match(screen, /keyed\(`window\.PanelFlowLang=[\s\S]*?\$\{late\}`, secret, \{ late: true \}\)/);
  assert.match(screen, /injectJavaScript\(keyed\(late, secret, \{ late: true \}\)\)/,
    'the re-injection on an in-page navigation is unsigned');
  assert.doesNotMatch(screen, /injectJavaScript\(`\$\{late\}/, 'a late bundle goes in without its key');
  // The late set takes its `chrome` from the key, or does not run.
  assert.match(screen, /var chrome=window\.__pfPrivateChrome&&window\.__pfPrivateChrome\(__pfKey\);if\(!chrome\)return;/);
  // And the bridge itself is fixed at document start.
  const bridge = read('native', 'inject', 'rn-bridge.js');
  assert.match(bridge, /Object\.defineProperty\(window, 'PanelFlowNative'/);
  assert.match(bridge, /native = window\.ReactNativeWebView\.postMessage\.bind/);
});

// --- layer 3, lifted out of native/src/core.js --------------------------------

function pageDoor(answers) {
  const core = read('native', 'src', 'core.js');
  const from = core.indexOf('const PAGE_TYPES = new Set([');
  const to = core.indexOf('export { PAGE_TYPES, PAGE_READS, PAGE_WRITES };');
  assert.ok(from !== -1 && to > from, 'the page door is not where this test expects it');
  const body = core.slice(from, to).replace(/^export /gm, '');
  const sent = [];
  const send = async (msg) => {
    sent.push(msg);
    const a = answers[msg.type];
    return typeof a === 'function' ? a(msg) : a;
  };
  const make = new Function('send', 'console', `${body}; return { sendFromPage, siteOf, MAX_READ_SECONDS };`);
  return { ...make(send, { warn() {} }), sent };
}

const PAGE = { pageUrl: 'https://www.scan.test/manga/blue-box/chapter-9/' };

test('a page is told somebody is signed in, and not who', async () => {
  const { sendFromPage } = pageDoor({ getAccount: { authUser: { id: 'u1', email: 'reader@example.test' } } });
  const r = await sendFromPage({ type: 'getAccount' }, PAGE);
  assert.deepEqual(r, { authUser: { signedIn: true } });
  assert.doesNotMatch(JSON.stringify(r), /reader@example\.test/);
});

test('a page sees the bookmarks of its own site and no other', async () => {
  const { sendFromPage } = pageDoor({
    getProgressAll: {
      progress: {
        'https://scan.test/manga/blue-box/': { chapterLabel: 'Ch. 9' },
        'https://elsewhere.test/manga/secret/': { chapterLabel: 'Ch. 300' },
      },
    },
    getReadChapters: { chapters: ['a'] },
  });
  const r = await sendFromPage({ type: 'getProgressAll' }, PAGE);
  assert.deepEqual(Object.keys(r.progress), ['https://scan.test/manga/blue-box/']);
  const other = await sendFromPage({ type: 'getReadChapters', sourceUrl: 'https://elsewhere.test/manga/secret/' }, PAGE);
  assert.deepEqual(other, { chapters: [] });
});

test('a duplicate on another site comes back as what it is, without the reader\'s notes', async () => {
  const { sendFromPage } = pageDoor({
    findSimilar: {
      matches: [{ confidence: 'high', entry: {
        id: 'e1', title: 'Blue Box', sourceUrl: 'https://elsewhere.test/manga/blue-box/',
        sourceDomain: 'elsewhere.test', note: 'private thoughts', score: 9, tags: ['mine'],
      } }],
    },
  });
  const r = await sendFromPage({ type: 'findSimilar', meta: { title: 'Blue Box' } }, PAGE);
  assert.equal(r.matches[0].entry.title, 'Blue Box');
  assert.equal(r.matches[0].entry.note, undefined);
  assert.equal(r.matches[0].entry.score, undefined);
});

test('a write has to be about the page being read', async () => {
  const { sendFromPage, sent } = pageDoor({ addToLibrary: { ok: true }, saveProgress: { ok: true } });
  const refused = [
    { type: 'addToLibrary', entry: { title: 'SPAM', sourceUrl: 'https://ads.test/buy-now/' } },
    { type: 'addToLibrary', entry: { title: 'x', sourceUrl: 'javascript:alert(1)' } },
    { type: 'addToLibrary', entry: { title: 'x', sourceUrl: 'https://scan.test/m/', chapterUrl: 'https://ads.test/c' } },
    { type: 'saveProgress', progress: { sourceUrl: 'https://ads.test/m/', chapterUrl: 'https://ads.test/c/1' } },
    { type: 'recordRead', read: { chapterUrl: 'https://ads.test/c/1', seconds: 14400 } },
    { type: 'migrateEntry', id: 'e1', target: { sourceUrl: 'https://ads.test/m/' } },
  ];
  for (const msg of refused) {
    assert.ok((await sendFromPage(msg, PAGE)).error, `${msg.type} was let through`);
  }
  assert.equal(sent.length, 0, 'a refused write still reached the hub');

  assert.deepEqual(await sendFromPage({
    type: 'addToLibrary', entry: { title: 'Blue Box', sourceUrl: 'https://scan.test/manga/blue-box/' },
  }, PAGE), { ok: true });
});

test('a reading record cannot pad the statistics', async () => {
  const { sendFromPage, sent, MAX_READ_SECONDS } = pageDoor({ recordRead: { ok: true } });
  await sendFromPage({ type: 'recordRead', read: { chapterUrl: 'https://scan.test/manga/blue-box/chapter-9/', seconds: 14400 } }, PAGE);
  assert.equal(sent[0].read.seconds, MAX_READ_SECONDS);
});

test('with no page address, nothing personal is answered and nothing is written', async () => {
  const { sendFromPage } = pageDoor({ getProgressAll: { progress: { 'https://scan.test/m/': {} } } });
  assert.deepEqual((await sendFromPage({ type: 'getProgressAll' }, {})).progress, {});
  assert.ok((await sendFromPage({ type: 'addToLibrary', entry: { sourceUrl: 'https://scan.test/m/' } }, {})).error);
});

// --- the reserves of the re-test (QA, September 2026) --------------------------

test('a frame of somebody else\'s page gets no shim and no key', () => {
  // The WebView injects into every frame; an advert's iframe holding the key
  // could sign requests of its own, and two were accepted from a player frame.
  const { window, posted } = shimIn({ key: false });
  assert.equal(window.chrome, undefined);
  assert.equal(window.__pfPrivateChrome, undefined);
  assert.equal(window.PanelFlowPage, undefined);
  assert.equal(posted.length, 0);
  const screen = read('native', 'src', 'screens', 'BrowserScreen.js');
  assert.match(screen, /\}\)\(window\.top===window\?\$\{JSON\.stringify\(key\)\}:false\);true;`;/,
    'the key is handed to frames as well as to the page');
});

test('a site is its registrable domain, not its last two labels', () => {
  const { siteOf } = pageDoor({});
  assert.notEqual(siteOf('https://a.github.io/x'), siteOf('https://b.github.io/y'));
  assert.notEqual(siteOf('https://scan.co.uk/m'), siteOf('https://other.co.uk/m'));
  assert.notEqual(siteOf('http://10.0.0.1/a'), siteOf('http://192.168.0.1/a'));
  // What stays one site: the apex and its subdomains, which is what a reading
  // site moving from `www.` to `ww6.` needs.
  assert.equal(siteOf('https://www.scan.test/m'), siteOf('https://ww6.scan.test/c/1'));
  assert.equal(siteOf('https://cdn.maid.my.id/x'), 'maid.my.id');
});

test('a duplicate on another site says what it is, not where it is filed', async () => {
  const { sendFromPage } = pageDoor({
    findSimilar: { matches: [{ confidence: 'high', entry: {
      id: 'e1', title: 'Blue Box', sourceUrl: 'https://elsewhere.test/manga/blue-box/',
      sourceDomain: 'elsewhere.test', folder: 'cat:secret-shelf', lastKnownChapter: '300',
    } }] },
  });
  const r = await sendFromPage({ type: 'findSimilar', meta: { title: 'Blue Box' } }, PAGE);
  assert.equal(r.matches[0].entry.folder, undefined);
  assert.equal(r.matches[0].entry.lastKnownChapter, '300', 'the duplicate sheet compares chapters');
});

test('the sheet\'s writes take a real press', () => {
  const sheet = read('extension', 'content', 'library-modal.js');
  assert.match(sheet, /migrate\.addEventListener\('click', async \(e\) => \{\n\s*\/\/[^\n]*\n[^\n]*\n\s*if \(!e\.isTrusted\) return;/);
  assert.match(sheet, /save\.addEventListener\('click', async \(e\) => \{\n\s*if \(!e\.isTrusted\) return;/);
  assert.match(sheet, /\(e\) => \{ if \(e\.isTrusted\) addToTracker\(service\); \}/);
  assert.doesNotMatch(sheet, /`Migrate to /, 'the button speaks English in every language');
});
