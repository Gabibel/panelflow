// The colour code: read, part-way, not caught up.
//
// MangaPin greys what you have finished and lights what you have not, and that
// one colour is the whole reason its shelf can be read at a glance. PanelFlow
// said the same things in words — a chapter number, a page count, a chip —
// spread over four lines of a card, so telling two series apart meant reading
// both of them.
//
// The rule lives in shared/library-view.js, which is a plain browser script:
// nothing is imported in the usual sense, it hangs `PanelFlowView` off the
// global and this file picks it up from there. The source-level tests at the
// bottom are the point of putting it there — three screens draw this, and the
// failure mode is not a wrong comparison, it is one of them quietly growing its
// own idea of "have I read this".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

await import(pathToFileURL(join(root, 'shared', 'library-view.js')).href);
const { READ, READING, UNREAD, readState } = globalThis.PanelFlowView;

const series = (latest) => ({ title: 'A', lastKnownChapter: latest });
const at = (label, page, pageCount) => ({
  chapterUrl: 'https://a.test/ch/' + label, chapterLabel: label, page, pageCount,
});

test('a series nobody has opened is unread, not read', () => {
  // The trap: chaptersBehind is null here, and "not behind" would be taken for
  // "caught up" — so a series added this morning would open already grey.
  assert.equal(readState(series('Chapter 12'), null), UNREAD);
  assert.equal(readState(series('Chapter 12'), undefined), UNREAD);
  assert.equal(readState(series('Chapter 12'), { page: 4, pageCount: 20 }), UNREAD,
    'a progress row with no chapter in it is not a bookmark');
});

test('chapters you have not reached outrank the page you stopped on', () => {
  // Three chapters behind is the thing worth seeing from across the room.
  // Being nine pages into the one before them is not, and must not dilute it.
  assert.equal(readState(series('Chapter 40'), at('Chapter 37', 8, 20)), UNREAD);
  assert.equal(readState(series('Chapter 40'), at('Chapter 39', 19, 20)), UNREAD);
});

test('the last page of the last chapter is read', () => {
  assert.equal(readState(series('Chapter 40'), at('Chapter 40', 19, 20)), READ);
  // Page counts are zero-based, so 19/20 is the end and 18/20 is not.
  assert.equal(readState(series('Chapter 40'), at('Chapter 40', 18, 20)), READING);
});

test('a chapter opened and left in the middle is neither', () => {
  assert.equal(readState(series('Chapter 40'), at('Chapter 40', 0, 20)), READING);
  assert.equal(readState(series('Chapter 40'), at('Chapter 40', 5, 20)), READING);
});

test('a page count nobody measured does not invent a part-way state', () => {
  // Progress written by the importers and by the ✎ dialog carries a chapter and
  // no pages at all. Half-orange there would be a claim about a position that
  // was never recorded — "caught up" is what was actually said.
  assert.equal(readState(series('Chapter 40'), at('Chapter 40', 0, 0)), READ);
  assert.equal(readState(series('Chapter 40'), at('Chapter 40', 0, undefined)), READ);
  assert.equal(readState(series('Chapter 40'), at('Chapter 40', 0, 1)), READ,
    'a one-page chapter is finished the moment it is open');
});

test('a series whose latest chapter is unknown is judged on its bookmark alone', () => {
  // Half the library has no lastKnownChapter — nothing has scraped it yet.
  // Those cards still have to say something, and what they know is how far
  // through the chapter the reader got.
  assert.equal(readState(series(null), at('Chapter 3', 2, 30)), READING);
  assert.equal(readState(series(null), at('Chapter 3', 29, 30)), READ);
  assert.equal(readState({ title: 'A' }, at('Chapter 3', 29, 30)), READ);
});

test('the three states are the three the screens name', () => {
  // They are strings that end up in class names, so they are part of the
  // contract with three stylesheets and cannot be renamed quietly.
  assert.deepEqual([READ, READING, UNREAD], ['read', 'reading', 'unread']);
});

// --- and that the screens actually use it -----------------------------------

test('both shelves colour from the shared rule, not from their own', () => {
  for (const [script, style] of [
    ['web/app.js', 'web/styles.css'],
    ['extension/popup/popup.js', 'extension/popup/popup.css'],
  ]) {
    const js = read(script);
    assert.match(js, /PanelFlowView\.readState\(/, `${script} grades its cards itself`);
    // The class is what the stylesheet keys on, so the two have to agree.
    assert.match(js, /'is-' \+/, `${script} does not put the state on the card`);
    const css = read(style);
    for (const state of ['is-read', 'is-unread', 'is-reading']) {
      assert.ok(css.includes('.' + state), `${style} has no rule for ${state}`);
    }
  }
});

test('the reader colours its wheel from the history, and says which is which', () => {
  // The wheel is the one list of *chapters* in PanelFlow, and readState cannot
  // grade it — it is handed a series and one bookmark, never the set of
  // chapters the history has rows for. So the reader answers this itself, and
  // what is checked here is that it answers with both halves: a wheel that
  // marks the read rows and leaves the rest neutral is the wheel we already had.
  const js = read('extension/content/reader.js');
  assert.match(js, /'pf-read' : 'pf-unread'/, 'the wheel still only marks what is read');
  // Before the history answers, readChapters is null and nothing may be
  // claimed — a wheel of "unread" shown to someone who has read all of it is
  // worse than no colour at all.
  assert.match(js, /if \(state\.readChapters\) \{/, 'the wheel colours before it knows');

  const css = read('extension/content/reader.css');
  for (const cls of ['pf-read', 'pf-unread', 'pf-here']) {
    assert.match(css, new RegExp(`\\.pf-wrow\\.${cls}\\s*\\{`), `${cls} has no colour`);
  }
  // The row in the middle stays the brightest thing in the wheel whatever else
  // is true of it, and in a flat cascade that means it is declared last.
  assert.ok(css.indexOf('.pf-wrow.pf-here {') > css.indexOf('.pf-wrow.pf-unread {'),
    'an unread chapter now outranks the row the wheel is pointing at');
});
