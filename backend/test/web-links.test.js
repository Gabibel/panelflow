// No client turns a stored address that is not http(s) into a link, a tab or a
// picture.
//
// The server refuses anything but http(s) now (src/http-url.js), but it
// stored whatever a client sent until it did, and those rows are still in
// people's libraries: a series, a bookmark or a history row whose address is
// javascript:alert(1). Put in an href, that is a script run by whoever clicks
// the series; handed to the phone's browser, a script run in whatever page it
// holds; put in a src, a picture nobody chose. So each client asks one small
// rule first, the server's rule written again because none of them can import
// it: `webAddress` in the extension popup, in its library sheet and in the
// older phone shells' web layer, `webUrl` in native/src/web-url.js. The web app
// has its own, `safeHref`, which sends a link that is not one nowhere ('#').
// They are held here to one table, as
// continue-target.test.js holds two copies of another rule, and then each
// place that draws a stored address is run, or read, to show it asks.
//
// Everything is lifted out of the shipping files with `new Function` or
// imported as it ships, never copied, so a test cannot pass against a page
// that does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isHttpUrl } from '../src/http-url.js';
import { webUrl as phoneUrl, firstWebUrl } from '../../native/src/web-url.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Line endings normalised: on a Windows checkout the markers below would
// otherwise miss the newlines they are matched against.
const read = (...p) => readFileSync(join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

const APP = read('web', 'app.js');
const SW = read('web', 'sw.js');
const POPUP = read('extension', 'popup', 'popup.js');
const MODAL = read('extension', 'content', 'library-modal.js');
const SHELL_WEB = read('mobile', 'www', 'app.js');

/** The source of `file` from one marker to the next, which must both be there. */
function between(src, file, from, to) {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a);
  assert.ok(a !== -1 && b > a, `${file}: "${from}" is not where this test expects it`);
  return src.slice(a, b);
}

/** Evaluate `code` with `deps` in scope, and hand back the functions it defines. */
function lift(code, deps, names) {
  const keys = Object.keys(deps);
  return new Function(...keys, `${code}\nreturn { ${names.join(', ')} };`)(...keys.map((k) => deps[k]));
}

const API = 'https://panelflow.test';

// The server's rule answers yes or no; the address it keeps is the one sent.
const webUrl = (url) => (isHttpUrl(url) ? url.trim() : null);

const web = lift(
  between(APP, 'web/app.js', 'function safeHref(url) {', '// The folders, from the one file'),
  { location: { href: `${API}/` } }, ['safeHref'],
);
const popup = lift(
  between(POPUP, 'extension/popup/popup.js', '// --- addresses ---', '// --- lists ---'),
  {}, ['webAddress', 'firstAddress'],
);
const modal = lift(
  between(MODAL, 'extension/content/library-modal.js', '  // --- addresses ---', '  // --- end of addresses ---'),
  {}, ['webAddress'],
);
const shellWeb = lift(
  between(SHELL_WEB, 'mobile/www/app.js', '  // --- addresses ---', '  // --- end of addresses ---'),
  {}, ['webAddress'],
);

/**
 * One element, with the handful of DOM the code under test touches: what it
 * was given is kept as plain properties, so a test reads what is on the page
 * rather than what the code meant to put there.
 */
function element(tag) {
  const el = {
    tag, className: '', textContent: '', hidden: false, children: [], handlers: {},
    style: { props: {}, setProperty(name, value) { this.props[name] = value; } },
    classList: { names: [], add(name) { this.names.push(name); } },
    addEventListener(type, fn) { el.handlers[type] = fn; },
    appendChild(kid) { el.children.push(kid); return kid; },
    append(...kids) { el.children.push(...kids); },
    removeAttribute(name) { delete el[name]; },
    replaceWith(other) { el.replacedBy = other; },
  };
  Object.defineProperty(el, 'innerHTML', { set() { el.children.length = 0; } });
  return el;
}
const document = { createElement: (tag) => element(tag) };

// --- one rule, six copies ------------------------------------------------------

// What every copy keeps, and keeps as written apart from the spaces around it.
const KEPT = [
  ['https://scans.test/manga/blue-box/', 'https://scans.test/manga/blue-box/'],
  ['http://old-scan.test/manga/blue-box/chapter-12', 'http://old-scan.test/manga/blue-box/chapter-12'],
  ['  https://cdn.test/cover.jpg \n', 'https://cdn.test/cover.jpg'],
  ['HTTPS://SCANS.TEST/A', 'HTTPS://SCANS.TEST/A'],
];

// What every copy refuses. The first group runs a script or draws something of
// somebody else's choosing; the second names no page at all (a path, a
// protocol-relative cover, a scheme with no host); the last is not text, and a
// list holding an address is the case String() would have let through.
const REFUSED = [
  'javascript:alert(document.cookie)', ' JavaScript:alert(1)', 'JAVASCRIPT:alert(1)', 'java\tscript:alert(1)',
  'data:text/html,<script>alert(1)</script>', 'data:image/svg+xml,<svg onload=alert(1)>',
  'vbscript:msgbox(1)', 'file:///etc/passwd', 'blob:https://scans.test/0b1c', 'about:blank',
  '//cdn.test/cover.jpg', '/manga/blue-box', 'chapter-12', 'https://', '', '   ',
  null, undefined, 42, {}, ['https://scans.test/a'],
];

const COPIES = [
  ['the server', webUrl],
  ['the extension popup', popup.webAddress],
  ['the phone', phoneUrl],
  ['the library sheet of the extension', modal.webAddress],
  ['the web layer of the older phone shells', shellWeb.webAddress],
];

test('every copy of the rule keeps an http(s) address and refuses everything else', () => {
  for (const [who, rule] of COPIES) {
    for (const [url, want] of KEPT) assert.equal(rule(url), want, `${who} refused ${JSON.stringify(url)}`);
    for (const url of REFUSED) assert.equal(rule(url), null, `${who} kept ${JSON.stringify(url)}`);
  }
});

test('the first address that is one is the one used, by every client that has a fallback', () => {
  const bad = 'javascript:alert(1)';
  for (const [who, first] of [['the popup', popup.firstAddress], ['the phone', firstWebUrl]]) {
    assert.equal(first(bad, 'https://scans.test/s/'), 'https://scans.test/s/', who);
    assert.equal(first(undefined, bad, 'data:text/html,x'), null, who);
  }
});

// --- the web app ---------------------------------------------------------------

test('the web app links an http(s) address, and sends anything else nowhere', () => {
  for (const [url, want] of KEPT) assert.equal(web.safeHref(url), new URL(want).href, JSON.stringify(url));
  // Everything that would run a script or draw somebody else's choice.
  for (const url of REFUSED.slice(0, 10)) assert.equal(web.safeHref(url), '#', JSON.stringify(url));
  // A path is a page of this site, which runs nothing either.
  assert.equal(web.safeHref('/manga/blue-box'), `${API}/manga/blue-box`);
});

/** coverEl, with the function it draws a missing cover with. */
const covers = lift(
  between(APP, 'web/app.js', 'function coverEl(entry) {', 'function renderContinue() {'),
  { document, API },
  ['coverEl'],
);

test('a cover reaches the page only through the proxy, and fails to its title', () => {
  // The proxy fetches http(s) only and refuses the rest (bad_url): whatever a
  // stored cover holds, the image is asked of this server, never of it.
  for (const coverUrl of ['https://cdn.test/tide.jpg', 'javascript:alert(document.cookie)', 'data:image/svg+xml,<svg onload=alert(1)>']) {
    const img = covers.coverEl({ title: 'Silent Tide', coverUrl, sourceUrl: 'https://scans.test/s/' });
    assert.equal(img.tag, 'img');
    assert.equal(img.src, `${API}/api/cover?url=${encodeURIComponent(coverUrl)}`
      + `&ref=${encodeURIComponent('https://scans.test/s/')}`);
    // A cover the proxy could not fetch is the title's letter, not the address
    // asked directly (which would hand the site the reader's address).
    img.handlers.error();
    assert.equal(img.src.startsWith(`${API}/api/cover?`), true);
    assert.equal(img.replacedBy?.className, 'cover-fallback');
    assert.equal(img.replacedBy?.textContent, 'S');
  }
  const none = covers.coverEl({ title: 'Silent Tide', coverUrl: '' });
  assert.equal(none.className, 'cover-fallback');
});

test('a history row whose chapter is not an address is still listed, linking nowhere', async () => {
  const els = {};
  const rows = [
    { day: '2026-10-16', chapterUrl: 'https://scans.test/tide/chapter-3', title: 'Silent Tide', chapterLabel: 'Chapter 3' },
    { day: '2026-10-16', chapterUrl: 'javascript:alert(document.cookie)', title: 'Old Row', chapterLabel: 'Chapter 1' },
    { day: '2026-10-15', chapterUrl: 'data:text/html,<script>alert(1)</script>', title: 'Older Row' },
  ];
  const { loadHistory } = lift(
    between(APP, 'web/app.js', 'async function loadHistory() {', "$('history-clear')"),
    {
      $: (id) => (els[id] ??= element('div')),
      t: (key) => key,
      tu: (key) => key,
      api: async () => rows,
      document,
      localDay: () => '2026-10-16',
      coverEl: () => element('div'),
      fmtDuration: (sec) => `${sec}s`,
      safeHref: web.safeHref,
      renderMediumChips: () => {},
      PanelFlowView: { statWords: () => ({ history: 'webHistory' }) },
      mediumView: { history: 'all' },
      mediumQuery: () => '',
    },
    ['loadHistory'],
  );
  await loadHistory();

  const links = els['history-list'].children.filter((el) => el.tag === 'a');
  assert.equal(links.length, 3, 'a row was dropped rather than shown');
  assert.deepEqual(links.map((el) => el.href), ['https://scans.test/tide/chapter-3', '#', '#']);
  // Still the row it was: its title is on it.
  const titleOf = (el) => el.children[1].children[0].textContent;
  assert.deepEqual(links.map(titleOf), ['Silent Tide', 'Old Row', 'Older Row']);
});

test('every link the web app makes from an address goes through safeHref', () => {
  // Each href and src this page sets without it, and why each one is safe. A
  // new one fails here until it is written through safeHref() or added here
  // with its reason.
  const OTHER = new Map([
    ["img.src = API + '/api/cover?url=' + encodeURIComponent(entry.coverUrl) +", 'the proxy, which fetches http(s) only'],
    ["if (url) img.src = API + '/api/cover?url=' + encodeURIComponent(url);", 'the form preview, through the proxy'],
    ["link.href = 'https://' + host + '/';", 'a site of the rules list, as https'],
    ['a.href = url;', 'the blob of a download this page just fetched'],
  ]);
  const set = [...APP.matchAll(/^.*\.(?:href|src)\s*=(?!=).*$/gm)].map((m) => m[0].trim());
  const others = set.filter((line) => !/\.href = safeHref\(/.test(line));
  for (const line of others) assert.ok(OTHER.has(line), `web/app.js sets an href or a src outside safeHref(): ${line}`);
  assert.equal(others.length, OTHER.size, 'a safe assignment this test names is gone; update the list');
  assert.ok(set.length > others.length + 4, 'the cards and rows no longer go through safeHref');
});

test('a notification never opens a window on an address that is not one', () => {
  const { clickTarget } = lift(
    between(SW, 'web/sw.js', 'function clickTarget(url) {', "self.addEventListener('notificationclick'"),
    { self: { location: { origin: API } } },
    ['clickTarget'],
  );
  assert.equal(clickTarget('/').href, `${API}/`);
  assert.equal(clickTarget('https://scans.test/tide/').href, 'https://scans.test/tide/');
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd']) {
    assert.equal(clickTarget(url).href, `${API}/`, `${url} was opened`);
  }
  // Another site, however it is written, is another site: its own window, not
  // the app's tab sent somewhere else.
  assert.equal(clickTarget('//elsewhere.test/x').origin, 'https://elsewhere.test');
  assert.match(SW, /if \(target\.origin === self\.location\.origin && open\.length\)/);
  assert.match(SW, /openWindow\(target\.href\)/);
});

// --- the extension popup -------------------------------------------------------

test('the popup draws only an address as a cover', () => {
  const { coverInto } = lift(
    between(POPUP, 'extension/popup/popup.js', 'function coverInto(img, entry) {', '// The popup keys progress by source URL'),
    { webAddress: popup.webAddress },
    ['coverInto'],
  );
  for (const coverUrl of REFUSED) {
    const img = element('img');
    coverInto(img, { coverUrl });
    assert.equal('src' in img, false, `${JSON.stringify(coverUrl)} was drawn`);
    assert.deepEqual(img.classList.names, ['placeholder']);
  }
  const img = element('img');
  coverInto(img, { coverUrl: ' https://cdn.test/tide.jpg ' });
  assert.equal(img.src, 'https://cdn.test/tide.jpg');
});

test('the popup opens a tab only on an address webAddress kept', () => {
  // No tab is opened on a field of an entry, a bookmark or a history row as it
  // was stored.
  assert.doesNotMatch(POPUP, /chrome\.tabs\.create\(\{\s*url:\s*[\w.?]*(?:sourceUrl|chapterUrl|coverUrl|\.url)\b/);
  // The ones that do open a tab are given what the rule kept.
  assert.match(POPUP, /const go = webAddress\(target\?\.url\);/);
  assert.match(POPUP, /chrome\.tabs\.create\(\{ url: go \}\)/);
  assert.match(POPUP, /const series = webAddress\(entry\.sourceUrl\);/);
  // `mark` is the bookmark, the furthest chapter reached (arbitrage e).
  assert.match(POPUP, /const target = firstAddress\(next\?\.url, mark\?\.chapterUrl, entry\.sourceUrl\);/);
  assert.match(POPUP, /const rereadUrl = webAddress\(reread\?\.url\);/);
  assert.equal((POPUP.match(/const href = firstAddress\(/g) || []).length, 2, 'the recent list and the log');
  // A button with nothing to open says so rather than opening nothing.
  assert.match(POPUP, /chapters\.disabled = !series;/);
  assert.match(POPUP, /resume\.disabled = !target;/);
});

// --- the phone -----------------------------------------------------------------

test('the phone draws only an address as a cover', () => {
  const store = read('native', 'src', 'store.js');
  const a = store.indexOf('export function coverSrc(entry, settings) {');
  const b = store.indexOf('\n}\n', a) + 3;
  assert.ok(a !== -1 && b > a, 'coverSrc is not where this test expects it in native/src/store.js');
  const { coverSrc } = lift(store.slice(a, b).replace('export function', 'function'), { webUrl: phoneUrl }, ['coverSrc']);

  const settings = { backendUrl: 'https://api.test' };
  for (const coverUrl of REFUSED) {
    assert.equal(coverSrc({ coverUrl, sourceUrl: 'https://scans.test/s/' }, settings), null, JSON.stringify(coverUrl));
    assert.equal(coverSrc({ coverUrl }, {}), null, JSON.stringify(coverUrl));
  }
  assert.equal(coverSrc({ coverUrl: 'https://cdn.test/a.jpg' }, {}), 'https://cdn.test/a.jpg');
  assert.equal(coverSrc({ coverUrl: 'https://cdn.test/a.jpg', sourceUrl: 'https://scans.test/s/' }, settings),
    `https://api.test/api/cover?url=${encodeURIComponent('https://cdn.test/a.jpg')}`
    + `&ref=${encodeURIComponent('https://scans.test/s/')}`);
});

test('the phone opens its browser only on an address, and skips to the next one it knows', () => {
  // The one door into the in-app browser asks first, whoever calls it.
  const shell = read('native', 'src', 'Shell.js');
  assert.match(shell, /const address = webUrl\(url\);\n\s*if \(address\) \{ setBrowsing\(address\); return; \}/);
  assert.doesNotMatch(shell, /setBrowsing\(url\)/);

  // And the screens fall back to the next address before they get there.
  for (const file of ['LibraryScreen.js', 'RecentScreen.js']) {
    const src = read('native', 'src', 'screens', file);
    assert.match(src, /firstWebUrl\(targets\[entry\.id\]\?\.url,\s*progress\[entry\.sourceUrl\]\?\.chapterUrl,\s*entry\.sourceUrl\)/,
      `${file} opens a stored address without asking`);
  }
  const sheet = read('native', 'src', 'EntrySheet.js');
  assert.match(sheet, /const targetUrl = webUrl\(target\?\.url\);/);
  assert.match(sheet, /const rereadUrl = webUrl\(target\?\.reread\?\.url\);/);
  assert.match(sheet, /const seriesUrl = webUrl\(entry\.sourceUrl\);/);
  assert.doesNotMatch(sheet, /onOpen\((?:entry\.sourceUrl|target\.url|target\.reread\.url)/);
});

// --- the library sheet and the older phone shells ------------------------------

test('the library sheet of the extension draws only an address as a cover', () => {
  // The page chose its og:image, and an old entry may carry anything: the sheet
  // draws what webAddress kept, and nothing else of the meta.
  assert.match(MODAL, /const cover = webAddress\(state\.meta\.coverUrl\);\n\s*if \(cover\) \{\n\s*img\.src = cover;/);
  assert.doesNotMatch(MODAL, /\.src = state\.meta\./);
});

test('the older phone shells draw only an address as a cover', () => {
  const { coverSrc } = lift(
    between(SHELL_WEB, 'mobile/www/app.js', '  function coverSrc(entry) {', '  // --- library'),
    { webAddress: shellWeb.webAddress, state: { backendUrl: 'https://api.test' } },
    ['coverSrc'],
  );
  for (const coverUrl of REFUSED) {
    assert.equal(coverSrc({ coverUrl, sourceUrl: 'https://scans.test/s/' }), null, JSON.stringify(coverUrl));
  }
  assert.equal(coverSrc({ coverUrl: ' https://cdn.test/a.jpg ', sourceUrl: 'https://scans.test/s/' }),
    `https://api.test/api/cover?url=${encodeURIComponent('https://cdn.test/a.jpg')}`
    + `&ref=${encodeURIComponent('https://scans.test/s/')}`);
  // Opening a page has no copy of the rule there: both shells refuse any other
  // scheme on their side of the bridge, and this holds them to it.
  assert.match(read('android', 'app', 'src', 'main', 'java', 'dev', 'panelflow', 'NativeMessages.kt'),
    /private fun openUrl[\s\S]{0,300}if \(scheme != "http" && scheme != "https"\)/);
  assert.match(read('ios', 'Sources', 'NativeMessages.swift'),
    /private static func openURL[\s\S]{0,300}scheme == "http" \|\| scheme == "https"/);
});
