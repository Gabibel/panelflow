// What a chapter and a page cost to open (owner's request, October 2026: "pas
// de gros chargements sur l'application et des chapitres").
//
// Three measured costs, each held here:
//   - a strip fetched every page of a chapter the moment it opened: an image
//     not loaded yet is zero pixels tall, so all sixty were "on screen" and
//     `loading="lazy"` did nothing (60 requests at open, 4 since);
//   - the detector measured every image of a page that is not a chapter again
//     at each burst of DOM changes, for as long as the page stayed open;
//   - the phone's browser redrew its screen every two seconds for a page state
//     that had not changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

test('a page of the strip holds its room until it loads, and decodes off the main thread', () => {
  const reader = read('extension', 'content', 'reader.js');
  const from = reader.indexOf('  function stripImage(src, stage) {');
  const to = reader.indexOf('\n  }\n', from) + 4;
  const listeners = {};
  const classes = new Set();
  const img = {
    classList: { remove: (c) => classes.delete(c), add: (c) => classes.add(c) },
    set className(v) { classes.clear(); classes.add(v); },
    addEventListener: (type, fn) => { listeners[type] = fn; },
    style: { setProperty() {} },
  };
  const stripImage = new Function('document', 'state', 'stripBase',
    `${reader.slice(from, to)}; return stripImage;`)({ createElement: () => img }, { stripZoom: 1 }, () => 0);
  stripImage('https://scan.test/1.jpg', {});
  assert.equal(img.loading, 'lazy');
  assert.equal(img.decoding, 'async');
  assert.ok(classes.has('pf-wait'), 'a page not loaded yet takes no room, and every page loads at once');
  listeners.load();
  assert.ok(!classes.has('pf-wait'));
  // A page that fails stops holding a page's room as well.
  classes.add('pf-wait');
  listeners.error();
  assert.ok(!classes.has('pf-wait'));
  const css = read('extension', 'content', 'reader.css');
  assert.match(css, /#panelflow-reader \.pf-vertical img\.pf-wait \{[^}]*min-height: 80vh;/);
  // Pages the detector finds later go through the same door.
  assert.match(reader, /appendChild\(stripImage\(src, \$\('\.pf-stage'\)\)\)/);
});

test('the detector slows down on a page that never turns out to be a chapter', () => {
  const detect = read('extension', 'content', 'detect.js');
  const fn = /function scanWait\(\) \{[^}]*\}/.exec(detect)?.[0];
  assert.ok(fn, 'scanWait is not in detect.js');
  const waitAfter = (fruitless) => new Function('fruitless', `${fn}; return scanWait();`)(fruitless);
  assert.equal(waitAfter(0), 600, 'a fresh page is not looked at as soon as before');
  assert.equal(waitAfter(7), 600);
  assert.ok(waitAfter(12) > 2000);
  assert.equal(waitAfter(100), 10000, 'the wait is not capped, so a late strip would never be found');
  // A new address starts again from the quick pace.
  assert.match(detect, /address = addressHere\(\);\s*fruitless = 0;/);
});

test('the phone\'s browser hears about the page only when its state changed', () => {
  const browser = read('native', 'src', 'screens', 'BrowserScreen.js');
  assert.match(browser, /if\(j===window\.__panelflowSaid\)return;/);
  assert.match(browser, /setPage\(\(prev\) => \(JSON\.stringify\(prev\) === JSON\.stringify\(next\) \? prev : next\)\)/);
});
