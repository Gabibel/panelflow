// Moving to the next chapter without loading a page.
//
// MangaDex is a Vue app served as a 5 kB shell: tapping "next" calls
// history.pushState and swaps the content in place. Nothing about that is a
// navigation as far as a content script is concerned — no new document, no
// `load`, and `popstate` fires only for the Back button. So the detector held
// on to the chapter before last: the pill pointed at it, the library recorded
// it, and the observer had already been disconnected by the accept() of a page
// that was no longer on screen.
//
// The two obvious fixes are both closed. Patching `history.pushState` from a
// content script patches a copy the page cannot see — separate JavaScript
// realms. `chrome.webNavigation` works and spends "read your browsing history"
// on the install screen, which is not a thing to ask of someone installing a
// zip a friend sent them. What is left is to watch the address, which costs one
// string comparison a second and catches every way a page can replace itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const src = read('extension', 'content', 'detect.js');

/**
 * The address watcher, lifted out of the shipping detect.js — a browser IIFE
 * with no exports. Everything it reads arrives as a parameter; the four pieces
 * of state it resets are declared around it, so a test can see that they moved.
 */
function buildWatcher({ pill = null, readerOpen = false } = {}) {
  const from = src.indexOf('  // An SPA navigation is a new page');
  const to = src.indexOf('  // A chapter page often only shows');
  assert.ok(from !== -1 && to > from, 'the address watcher is not where this test expects it');

  const log = [];
  const here = { pathname: '/chapter/aaa', search: '', hash: '' };
  const location = {
    get href() { return `https://mangadex.org${here.pathname}${here.search}${here.hash}`; },
    get pathname() { return here.pathname; },
    get search() { return here.search; },
  };
  const document = { getElementById: (id) => (id === 'panelflow-pill' ? pill : null) };
  const window = {
    PanelFlowReader: {
      isOpen: () => readerOpen,
      close: () => log.push('reader closed'),
    },
  };

  const make = new Function(
    'location', 'document', 'window', 'watchDom', 'scheduleScan', 'addEventListener', 'setInterval',
    `let detection = { score: 120 }, tracked = 'https://mangadex.org/chapter/aaa';
     let site = { imageContainer: '#x' }, autoOpened = true;
     ${src.slice(from, to)}
     return {
       addressChanged,
       state: () => ({ detection, tracked, site, autoOpened }),
     };`,
  );

  const listeners = [];
  const timers = [];
  const built = make(
    location, document, window,
    () => log.push('watching'), () => log.push('rescan'),
    (name, fn) => listeners.push({ name, fn }),
    (fn, ms) => timers.push({ fn, ms }),
  );
  return { ...built, log, here, listeners, timers };
}

test('a chapter swapped in under us is a new page', () => {
  const removed = [];
  const w = buildWatcher({ pill: { remove: () => removed.push('pill') }, readerOpen: true });

  w.here.pathname = '/chapter/bbb';
  w.addressChanged();

  assert.deepEqual(w.state(), { detection: null, tracked: null, site: null, autoOpened: false });
  // The pill named the old chapter and the reader was full of its panels.
  assert.deepEqual(removed, ['pill']);
  assert.ok(w.log.includes('reader closed'));
  // accept() disconnected the observer on the way out of the last chapter, so
  // re-arming it is what lets the panels of this one be noticed at all.
  assert.deepEqual(w.log.filter((l) => l !== 'reader closed'), ['watching', 'rescan']);
});

test('the same address, a second later, is not a navigation', () => {
  // This runs once a second for the life of the tab. If it rescanned each time
  // it would re-detect, re-send pageDetected and re-open the reader forever.
  const w = buildWatcher();
  w.addressChanged();
  w.addressChanged();
  assert.deepEqual(w.log, []);
  assert.equal(w.state().detection.score, 120, 'a detection that still applies was thrown away');
});

test('an anchor inside the chapter is not a navigation either', () => {
  // Paginated readers move `#page-4` as you scroll, and a rescan per panel
  // would close the reader the reader itself just opened.
  const w = buildWatcher({ readerOpen: true });
  w.here.hash = '#page-4';
  w.addressChanged();
  assert.deepEqual(w.log, []);
});

test('a query string is part of the address', () => {
  // Plenty of readers page with ?chapter=, and dropping the query would make
  // those sites the one place this never fires.
  const w = buildWatcher();
  w.here.search = '?chapter=27';
  w.addressChanged();
  assert.ok(w.log.includes('rescan'));
});

test('a reader that is not open is not closed', () => {
  const w = buildWatcher({ readerOpen: false });
  w.here.pathname = '/chapter/ccc';
  w.addressChanged();
  assert.ok(!w.log.includes('reader closed'));
});

test('the Back button and the poll are both wired up', () => {
  // popstate alone was the old behaviour, and it is exactly the half that
  // pushState navigation does not reach.
  const w = buildWatcher();
  assert.deepEqual(w.listeners.map((l) => l.name), ['popstate']);
  assert.equal(w.listeners[0].fn, w.addressChanged);
  assert.equal(w.timers.length, 1);
  assert.equal(w.timers[0].fn, w.addressChanged);
  assert.ok(w.timers[0].ms >= 500 && w.timers[0].ms <= 2000, 'the poll is not on a sane interval');
});

test('watching the address is not paid for with a permission', () => {
  // The whole point of polling rather than asking chrome.webNavigation: the
  // extension is meant to be installable from a zip by someone who is being
  // asked to trust it, and "read your browsing history" is not on the list of
  // things it needs.
  const manifest = JSON.parse(read('extension', 'manifest.json'));
  const asked = [...(manifest.permissions || []), ...(manifest.optional_permissions || [])];
  assert.ok(!asked.includes('webNavigation'), 'the extension now asks for browsing history');
  assert.ok(!asked.includes('history'));
});
