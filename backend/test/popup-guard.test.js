// The popup guard has to run in the page's own world.
//
// It replaces `window.open` so that an ad script cannot open a tab the reader
// never asked for. A content script's default isolated world has its own
// `window`, so that reassignment landed on an object no page script could
// reach: the guard reported for duty at document_start on every site and
// blocked nothing. Its second half — cancelling synthetic clicks on
// `target="_blank"` anchors — worked the whole time, because DOM events are
// shared between the worlds, which is why the file never looked broken.
//
// `"world": "MAIN"` in the manifest is the fix, and it comes with a rule: no
// `chrome.*` in this file, because the main world has no extension APIs and the
// reference would throw at document_start, before anything is guarded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const manifest = JSON.parse(read('extension/manifest.json'));
const src = read('extension/content/popup-guard.js');

const guardEntry = manifest.content_scripts.find((c) => c.js.includes('content/popup-guard.js'));

test('the guard is declared in the page\'s own world, at document_start', () => {
  assert.ok(guardEntry, 'popup-guard.js is no longer in the manifest');
  assert.equal(guardEntry.world, 'MAIN',
    'in the isolated world this file overrides a window.open no page can call');
  assert.equal(guardEntry.run_at, 'document_start',
    'an ad script that runs before the guard is not guarded');
  // The detector bundle is the opposite case: it needs chrome.runtime, so it
  // must stay isolated. Pin that too — the two entries are easy to confuse.
  const detector = manifest.content_scripts.find((c) => c.js.includes('content/detect.js'));
  assert.equal(detector.world, undefined, 'detect.js needs chrome.* and must stay isolated');
});

test('nothing in the guard reaches for an extension API', () => {
  // The comments above the code say "chrome.*" themselves, and a rule that
  // trips over its own explanation would be dropped rather than obeyed.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const chromeUse = code.match(/\bchrome\s*\./g) || [];
  assert.deepEqual(chromeUse, [], 'chrome.* is undefined in the main world');
});

/** The guard, run against a stand-in for the page's window, loaded on href. */
function runGuard(href = 'https://sushiscan.fr/kingdom-chapitre-874/') {
  const listeners = {};
  const opened = [];
  const win = { open: (url) => { opened.push(url); return { url }; } };
  const addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
  const fire = (type, ev) => (listeners[type] || []).forEach((fn) => fn(ev));
  new Function('window', 'addEventListener', 'console', 'location', src)(
    win, addEventListener, { debug() {} }, new URL(href));
  return { win, opened, fire };
}

test('a window.open with no user gesture behind it is refused', () => {
  const { win, opened } = runGuard();
  assert.equal(win.open('https://ad.example/pop'), null);
  assert.deepEqual(opened, [], 'the page never reached the real open');
});

test('a window.open just after a real click goes through', () => {
  const { win, opened, fire } = runGuard();
  fire('pointerdown', {});
  const handle = win.open('https://sushiscan.fr/kingdom-chapitre-884/');
  assert.equal(handle.url, 'https://sushiscan.fr/kingdom-chapitre-884/');
  assert.deepEqual(opened, ['https://sushiscan.fr/kingdom-chapitre-884/']);
});

test('the gesture expires, so a timer armed by a click cannot spend it later', () => {
  const { win, opened, fire } = runGuard();
  fire('keydown', {});
  const realNow = Date.now;
  Date.now = () => realNow() + 5000; // the 1s window has long closed
  try {
    assert.equal(win.open('https://ad.example/late'), null);
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(opened, []);
});

test('a synthetic click on a new-window anchor is cancelled, a real one is not', () => {
  const { fire } = runGuard();
  const anchor = { href: 'https://ad.example/x', target: '_blank' };
  const clickOn = (isTrusted) => {
    const ev = { isTrusted, prevented: false, stopped: false,
      target: { closest: (sel) => (sel.includes('_blank') ? anchor : null) },
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; } };
    fire('click', ev);
    return ev;
  };
  const synthetic = clickOn(false);
  assert.equal(synthetic.prevented, true);
  assert.equal(synthetic.stopped, true);
  // The reader's own next-chapter link is a real click and must survive.
  assert.equal(clickOn(true).prevented, false);
});

test('a click on the reader is not a gesture the page may spend', () => {
  // The reader is a <div> in the site's document, so pressing its close button
  // looks to the page exactly like pressing the page — and these sites run
  // pop-under scripts waiting for exactly that. Reading a chapter was costing a
  // tab of advertising per button pressed.
  const { win, opened, fire } = runGuard();
  const inReader = { target: { closest: (sel) => (sel.includes('#panelflow-reader') ? {} : null) } };
  fire('pointerdown', inReader);
  assert.equal(win.open('https://ad.example/pop'), null, 'our own button opened an ad');
  assert.deepEqual(opened, []);

  // Keys too: the reader's shortcuts are pressed with the reader focused.
  fire('keydown', inReader);
  assert.equal(win.open('https://ad.example/pop'), null);
});

test('a click on the page itself still is one', () => {
  // The guard exists to stop windows nobody asked for, not to stop the site
  // working: a real click on a real link still opens what it opens.
  const { win, opened, fire } = runGuard('https://scan.test/kingdom-chapitre-1/');
  fire('pointerdown', { target: { closest: () => null } });
  win.open('https://scan.test/chapitre-2/');
  assert.deepEqual(opened, ['https://scan.test/chapitre-2/']);
});

// --- the gesture is not a blank cheque -------------------------------------
//
// Reported from sushiscan: clicking the site's own chapter controls opened an
// ad page every time. Every test above passes on that page — the click is real,
// the gesture is real, and the window the site asks for is an advertiser's.
// What separates the two is the destination: a scan site opens its own pages,
// and the tab it wants to send somewhere else is never the one the reader
// asked for.

test('a real gesture does not pay for a tab on another domain', () => {
  const { win, opened, fire } = runGuard('https://sushiscan.fr/kingdom-chapitre-874/');
  fire('pointerdown', { target: { closest: () => null } });
  assert.equal(win.open('https://ad.example/interstitial?ref=sushiscan'), null);
  assert.deepEqual(opened, [], 'the click on "next chapter" bought an ad tab');
});

test("the site's own pages open, subdomains and relative links included", () => {
  const { win, opened, fire } = runGuard('https://sushiscan.fr/kingdom-chapitre-874/');
  for (const url of ['https://sushiscan.fr/kingdom-chapitre-875/',
    'https://www.sushiscan.fr/catalogue/', '/kingdom/', 'chapitre-875/']) {
    fire('pointerdown', { target: { closest: () => null } });
    assert.ok(win.open(url), url + ' is the site opening itself');
  }
  assert.equal(opened.length, 4);
});

test('a two-part suffix is not mistaken for the site', () => {
  // Without the exception list, "ads.co.uk" and "scans.co.uk" both reduce to
  // "co.uk" and every ad network on that suffix would count as the same site.
  const { win, opened, fire } = runGuard('https://scans.co.uk/kingdom-1/');
  fire('pointerdown', { target: { closest: () => null } });
  assert.equal(win.open('https://ads.co.uk/pop'), null);
  fire('pointerdown', { target: { closest: () => null } });
  assert.ok(win.open('https://cdn.scans.co.uk/next'), 'its own subdomain');
  assert.deepEqual(opened, ['https://cdn.scans.co.uk/next']);
});

test('the blank tab kept for later is refused too', () => {
  // The pop-under proper: open a tab with no URL while the gesture is live,
  // hold the handle, and navigate it once nobody is looking. There is no
  // destination to judge, which is exactly what makes it one.
  const { win, opened, fire } = runGuard();
  for (const args of [[], [''], [undefined, '_blank'], ['about:blank'],
    ['javascript:void(0)']]) {
    fire('pointerdown', { target: { closest: () => null } });
    assert.equal(win.open(...args), null, JSON.stringify(args));
  }
  assert.deepEqual(opened, []);
});

test('the overlay it refuses to spend a gesture for is the one it ships', () => {
  // Two ids, and both have to be the ones the other files actually use — a
  // typo here is a rule that silently never matches.
  const reader = read('extension/content/reader.js');
  const modal = read('extension/content/library-modal.js');
  assert.match(src, /#panelflow-reader/, 'the guard no longer knows the reader');
  assert.match(src, /#panelflow-libmodal/, 'the guard no longer knows the library sheet');
  assert.match(src, /#panelflow-pill/, 'the guard no longer knows the button on the page');
  assert.match(reader, /root\.id = 'panelflow-reader'/);
  assert.match(modal, /host\.id = 'panelflow-libmodal'/);
  assert.match(read('extension/content/detect.js'), /pill\.id = 'panelflow-pill'/);
});
