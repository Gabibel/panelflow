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

/** The guard, run against a stand-in for the page's window. */
function runGuard() {
  const listeners = {};
  const opened = [];
  const win = { open: (url) => { opened.push(url); return { url }; } };
  const addEventListener = (type, fn) => { (listeners[type] ||= []).push(fn); };
  const fire = (type, ev) => (listeners[type] || []).forEach((fn) => fn(ev));
  new Function('window', 'addEventListener', 'console', src)(
    win, addEventListener, { debug() {} });
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
