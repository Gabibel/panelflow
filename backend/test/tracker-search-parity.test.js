// "Not in the list? Search for it yourself", wherever a series is added to a
// tracker.
//
// Owner's report, September 2026: MyAnimeList had never heard the title a site
// wrote in French, and its guesses were five seasons of the right series, none
// of them the one being watched. The sheet offered those five and nothing else.
// Now each surface that asks the reader to pick also lets them search: the
// extension's sheet (also the phone's in-app browser), the website's series
// form and the phone's series sheet. The popup's picker already had a search
// field, which this test does not cover.
//
// The extension's sheet is run for real in library-modal.test.js. This file
// holds the three to the same answer, so that none of them goes back to
// offering only the guesses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

/** The code that handles an unmatched answer, up to the next blank-line block. */
const unmatchedBranch = (src) => {
  const at = src.indexOf("skipped === 'unmatched'");
  assert.ok(at !== -1, 'the unmatched answer is not handled here any more');
  return src.slice(at, at + 700);
};

test('the extension\'s sheet offers a search after the guesses', () => {
  const src = read('extension', 'content', 'library-modal.js');
  assert.match(unmatchedBranch(src), /searchable: true/);
  assert.match(src, /send\(\{ type: 'trackerSearch', service, q: query, medium: state\.medium \}\)/,
    'the search does not ask the catalogue of the right kind of work');
  assert.match(src, /t\(live\.hits\?\.length \? 'modalTrackerSearchLead' : 'modalTrackerSearchOwn'\)/);
});

test('the website\'s series form offers a search after the guesses', () => {
  const src = read('web', 'app.js');
  assert.match(unmatchedBranch(src), /trackerSearchRow\(entry, service, li, hits\.length > 0\)/);
  assert.match(src, /\/trackers\/\$\{encodeURIComponent\(service\)\}\/search\?q=\$\{encodeURIComponent\(q\)\}/);
  assert.match(src, /&medium=\$\{encodeURIComponent\(PanelFlowView\.mediumOf\(entry\)\)\}/);
});

test('the phone\'s series sheet offers a search after the guesses', () => {
  const src = read('native', 'src', 'EntrySheet.js');
  assert.match(unmatchedBranch(src), /searchable: true/);
  assert.match(src, /send\(\{ type: 'trackerSearch', service, q: query, medium: Shelf\.mediumOf\(entry\) \}\)/);
  assert.match(src, /live\?\.searchable && \(/);
});

test('every surface shows a guess with what tells it apart', () => {
  // "… 2nd Season" and "… 2nd Season Part 2" differ by two words at the end
  // of a long line: the English title and the format go under each.
  for (const [file, pattern] of [
    [['extension', 'content', 'library-modal.js'], /function hitButton\(hit, onClick\)/],
    [['web', 'app.js'], /btn\.className = pick \? 'tracker-add tracker-pick' : 'tracker-add';/],
    [['native', 'src', 'EntrySheet.js'], /function Hit\(\{ hit, colors, onPress \}\)/],
  ]) {
    const src = read(...file);
    assert.match(src, pattern, file.join('/'));
    assert.match(src, /\((hit|pick)\.altTitles \|\| \[\]\)\.find\(\(x\) => x && x !== (hit|pick)\.title && \/\[a-z\]\/i\.test\(x\)\)/, file.join('/'));
  }
});
