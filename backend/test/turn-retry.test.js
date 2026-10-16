// A chapter the reader turned to, answered with a server error, is loaded
// again once.
//
// When the reader cannot load the next chapter in place, it navigates to it
// and asks to be reopened there (`reopenReaderFor`). A site that answered that
// one request with a 5xx left the reader closed on an error page; a text
// chapter, which always turns by a full load, did so 3 times out of 3 on a
// network that fails one request in five (T3). detect.js now reloads that
// address once, and only that address, and only once per tab session.
//
// retryFailedTurn is lifted out of the shipping file and run with a fake
// page: its navigation status, the extension's storage, the tab's session
// storage and its timers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'extension', 'content', 'detect.js'), 'utf8').replace(/\r\n/g, '\n');

const a = src.indexOf('  function retryFailedTurn() {');
const b = src.indexOf('\n  }\n', a);
assert.ok(a !== -1 && b > a, 'retryFailedTurn is not where this test expects it');
const SOURCE = src.slice(a, b + 4);

const HERE = 'https://scan.test/b/crimson-blade/chapter-5';

/**
 * One page load: what it answered, what the reader asked for, what the tab
 * remembers; and, by the time the retry is due, whether the page turned out
 * to hold a chapter (`detected`) or the reader is open on it (`open`).
 */
function load({ status, reopen = HERE, session = new Map(), detected = false, open = false, entries }) {
  let reloads = 0;
  const timers = [];
  const delays = [];
  const run = new Function('globalThis', 'chrome', 'sessionStorage', 'location', 'setTimeout', 'detection',
    `${SOURCE}\nretryFailedTurn();`);
  run(
    {
      // `entries` stands in for an engine that keeps no navigation entry at
      // all; `status: undefined` for one whose entry has no responseStatus
      // (WebKit, Safari 26).
      performance: { getEntriesByType: () => entries ?? [{ responseStatus: status }] },
      PanelFlowReader: { isOpen: () => open },
    },
    { storage: { local: { get: (keys, cb) => cb({ reopenReaderFor: reopen }) } } },
    { getItem: (k) => session.get(k) ?? null, setItem: (k, v) => session.set(k, v) },
    { href: HERE, reload: () => { reloads += 1; } },
    (fn, ms) => { timers.push(fn); delays.push(ms); },
    detected ? { kind: 'gallery' } : null,
  );
  for (const fn of timers.splice(0)) fn();
  return { reloads, session, delays };
}

test('a chapter the reader asked for that answered 5xx is loaded again, once', () => {
  const first = load({ status: 503 });
  assert.equal(first.reloads, 1);
  assert.deepEqual(first.delays, [1500]);
  // The same address failing again in the same tab is a site that is down.
  assert.equal(load({ status: 503, session: first.session }).reloads, 0);
});

test('nothing is reloaded for a page that loaded, or one the reader did not ask for', () => {
  assert.equal(load({ status: 200 }).reloads, 0);
  assert.equal(load({ status: 404 }).reloads, 0, 'a missing chapter is H25, not a retry');
  assert.equal(load({ status: 503, reopen: 'https://scan.test/b/crimson-blade/chapter-6' }).reloads, 0);
  assert.equal(load({ status: 503, reopen: null }).reloads, 0, 'nothing asked for');
});

test('where the engine does not say what the page answered, a page with no chapter after a wait is retried once', () => {
  // WebKit has no responseStatus (Safari 26): on the iOS app the retry never
  // happened. Measured in Playwright's WebKit 26.6, 2026-10-16.
  const ios = load({ status: undefined });
  assert.equal(ios.reloads, 1, 'a failed chapter page was left as it was on iOS');
  assert.deepEqual(ios.delays, [6000], 'the detector\'s own tries come first');
  assert.equal(load({ status: undefined, session: ios.session }).reloads, 0, 'once per tab session');
  assert.equal(load({ entries: [] }).reloads, 1, 'no navigation entry at all');
  // A page that turned out to be a chapter is left alone, as with a known status.
  assert.equal(load({ status: undefined, detected: true }).reloads, 0);
  assert.equal(load({ status: undefined, open: true }).reloads, 0);
  assert.equal(load({ status: undefined, reopen: null }).reloads, 0, 'nothing asked for');
});

test('a page sent with a 5xx that holds a chapter all the same is not reloaded under the reader', () => {
  // Some servers answer their pages with a 5xx status and the page in full.
  // The reader is open on it by the time the retry is due: a reload would
  // close it.
  assert.equal(load({ status: 500, detected: true }).reloads, 0);
  assert.equal(load({ status: 500, open: true }).reloads, 0);
});
