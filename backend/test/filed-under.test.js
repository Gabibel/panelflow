// One series, one address, whatever page the reader came from.
//
// The reader guesses the series from the chapter page it is on, and two pages
// of one series guess differently: a page that links the series index gives
// ".../blue-box/", a page that does not gives ".../blue-box", cut from the
// chapter's own address. The long-run e2e found what that did: the bookmark
// and the reads of chapter 10 were filed beside the library entry rather than
// on it, so the shelf's Continue still said chapter 9 and the wheel never
// greyed chapter 10. The core now files both under the entry's address, and
// this is the test that keeps it doing so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootCore } from '../test-support/core.js';

const SERIES = 'https://s.test/manga/blue-box/';
const GUESSED = 'https://s.test/manga/blue-box';
const chapter = (n) => `https://s.test/manga/blue-box/chapter-${n}/`;

async function withEntry() {
  const { core } = bootCore();
  await core.addToLibrary({ title: 'Blue Box', sourceUrl: SERIES, sourceDomain: 's.test', medium: 'manga' });
  return core;
}

test('a bookmark saved under the guessed address lands on the entry', async () => {
  const core = await withEntry();
  await core.saveProgress({ sourceUrl: GUESSED, chapterUrl: chapter(10), chapterLabel: 'Chapter 10', page: 3, pageCount: 10 });
  const { progress } = await core.getProgressAll();
  assert.deepEqual(Object.keys(progress), [SERIES], 'one key, the entry\'s');
  assert.equal(progress[SERIES].chapterUrl, chapter(10));
  assert.equal(progress[SERIES].sourceUrl, SERIES, 'the row says where it is filed');
  // And the shelf reads it: Continue points at the chapter, not at the series.
  const [entry] = await core.getLibrary();
  const targets = await core.continueTargets();
  assert.equal(targets[entry.id].url, chapter(10));
});

test('a read recorded under the guessed address counts for the entry', async () => {
  const core = await withEntry();
  await core.recordRead({ sourceUrl: SERIES, chapterUrl: chapter(9), chapterLabel: 'Chapter 9', pages: 12, seconds: 8 });
  await core.recordRead({ sourceUrl: GUESSED, chapterUrl: chapter(10), chapterLabel: 'Chapter 10', pages: 1, seconds: 7 });
  const rows = await core.getHistory();
  assert.ok(rows.every((r) => r.sourceUrl === SERIES), `rows filed under ${rows.map((r) => r.sourceUrl).join(', ')}`);
  const read = await core.getReadChapters(SERIES);
  assert.deepEqual(read.sort(), [chapter(10), chapter(9)], 'the wheel greys both');
});

test('rows written before the entry existed are still the series\'s, slash or not', async () => {
  // Nothing to file under yet: the guess is kept. Once the entry exists, the
  // wheel asks with its address and must still see the earlier rows.
  const { core } = bootCore();
  await core.recordRead({ sourceUrl: GUESSED, chapterUrl: chapter(3), chapterLabel: 'Chapter 3', pages: 5, seconds: 9 });
  await core.addToLibrary({ title: 'Blue Box', sourceUrl: SERIES, sourceDomain: 's.test', medium: 'manga' });
  assert.deepEqual(await core.getReadChapters(SERIES), [chapter(3)]);
});

test('without an entry, the guess is the address, and nothing is invented', async () => {
  const { core } = bootCore();
  await core.saveProgress({ sourceUrl: GUESSED, chapterUrl: chapter(1), chapterLabel: 'Chapter 1', page: 0, pageCount: 8 });
  const { progress } = await core.getProgressAll();
  assert.deepEqual(Object.keys(progress), [GUESSED]);
});
