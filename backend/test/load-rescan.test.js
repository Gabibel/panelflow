// A panel that finishes loading is a reason to look at the page again.
//
// The detector scans when the DOM changes. An image that finishes loading does
// not change the DOM, so on a page-per-address reader (mangago) whose one panel
// was still on its way at the last scan, nothing ever asked again and the
// chapter was never offered: on a slow network that combination failed 3/3 on
// every profile (T3). detect.js now listens for images that finish loading and
// asks for a scan, without pushing back one already on its way.
//
// scheduleScan and watchImages are lifted out of the shipping file and run with
// a fake document and fake timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'extension', 'content', 'detect.js'), 'utf8').replace(/\r\n/g, '\n');

/** The source of `function name() { ... }`, up to its closing brace at two spaces. */
function lifted(name) {
  const a = src.indexOf(`  function ${name}(`);
  const b = src.indexOf('\n  }\n', a);
  assert.ok(a !== -1 && b > a, `${name} is not where this test expects it`);
  return src.slice(a, b + 4);
}

/** The two functions over a page whose load listeners and timers the test holds. */
function page() {
  const listeners = [];
  const timers = [];
  let scans = 0;
  const document = { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }) };
  // scheduleScan waits longer on a page that keeps finding nothing (scanWait,
  // one line in the file, so read as one).
  const wait = src.match(/^ {2}function scanWait\(\) \{.*\}$/m);
  assert.ok(wait, 'scanWait is not where this test expects it');
  const api = new Function('document', 'setTimeout', 'clearTimeout', 'scan', `
    let scanTimer = null;
    let detection = null;
    let fruitless = 0;
    ${wait[0]}
    ${lifted('scheduleScan')}
    ${lifted('watchImages')}
    watchImages();
    return { detect: () => { detection = {}; }, pending: () => scanTimer !== null };`)(
    document,
    (fn) => { timers.push(fn); return timers.length; },
    () => {},
    () => { scans += 1; },
  );
  const load = (tagName) => {
    for (const l of listeners) if (l.type === 'load') l.fn({ target: { tagName } });
  };
  const tick = () => { for (const fn of timers.splice(0)) fn(); };
  return { api, listeners, load, tick, scans: () => scans, timers };
}

test('an image that finishes loading asks for a scan, in the capture phase', () => {
  const p = page();
  const listener = p.listeners.find((l) => l.type === 'load');
  assert.ok(listener, 'nothing listens for images that load');
  assert.equal(listener.capture, true, 'load does not bubble: only a capturing listener hears an <img>');
  p.load('IMG');
  assert.equal(p.timers.length, 1);
  p.tick();
  assert.equal(p.scans(), 1);
});

test('a strip of images arriving one by one does not keep pushing the scan back', () => {
  const p = page();
  for (let i = 0; i < 300; i++) p.load('IMG');
  assert.equal(p.timers.length, 1, 'one scan asked for, not three hundred');
  p.tick();
  assert.equal(p.scans(), 1);
  assert.equal(p.api.pending(), false, 'the timer is free again once the scan has run');
  p.load('IMG');
  assert.equal(p.timers.length, 1, 'and the next image asks again');
});

test('nothing is asked once a chapter is detected, nor for a script or a frame', () => {
  const p = page();
  p.load('SCRIPT');
  p.load('IFRAME');
  assert.equal(p.timers.length, 0);
  p.api.detect();
  p.load('IMG');
  assert.equal(p.timers.length, 0);
});
