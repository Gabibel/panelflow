// The reading clock across a chapter change made in place.
//
// The reader swaps chapters without leaving the page (loadChapterInPlace), and
// the clock that banks reading time did not know: it ran on across the swap,
// so a reader who went through ten chapters in place ended with one history
// row, on the tenth, carrying every minute of the other nine. The long-run
// e2e is what found it; this is the cheaper guard, read off the source, that
// runs on a clone without a browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rjs = readFileSync(join(root, 'extension', 'content', 'reader.js'), 'utf8');

const between = (from, to) => {
  const a = rjs.indexOf(from);
  const b = rjs.indexOf(to, a);
  assert.ok(a !== -1 && b > a, `${from.trim()} is not where this test expects it`);
  return rjs.slice(a, b);
};

test('the chapter being left is banked before its name goes, and the clock restarts on the new one', () => {
  const swap = between('  async function loadChapterInPlace(url) {', '  async function gotoChapter(url) {');
  const banked = swap.indexOf('bankRead();');
  const renamed = swap.indexOf('meta: {');
  const restarted = swap.indexOf('clockStart();');
  assert.ok(banked !== -1, 'the swap never banks the chapter it leaves');
  assert.ok(renamed !== -1 && banked < renamed, 'the read must be banked while state.meta still names the old chapter');
  assert.ok(restarted > renamed, 'the clock must start again on the new chapter, after the swap');
  assert.match(swap, /clock\.banked = 0;/, 'a bank that is not zeroed is banked twice');
});

test('open() resolves once the reader is built, not once storage was asked', () => {
  // detect.js feeds a chapter walked page by page into a reader that is on
  // its way up, and asks isOpen() whether to go on. Between the call and
  // build() the answer would be no; so the promise waits for build().
  const open = between('  async function open(images, meta, rule, container', '  function close() {');
  assert.match(open, /await new Promise\(\(built\) => chrome\.storage\.local\.get/);
  assert.ok(open.indexOf('build();') < open.indexOf('built();'), 'built() must follow build()');
});
