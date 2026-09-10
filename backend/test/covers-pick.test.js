// Which tracker result is allowed to become a cover.
//
// Background: a series added from a chapter page has no picture — the cover
// lives on the series page, which nobody visited. The phone fills those in by
// searching a connected tracker, because AniList and MyAnimeList have a picture
// for nearly every work in existence, including the light novels whose own
// sites never had one.
//
// The risk that buys is a wrong picture. A search for "Boruto" returns a dozen
// Boruto-adjacent works; a search for a mistyped title returns whatever is
// nearest. And a wrong cover is a bad failure precisely because it does not
// look like one — a grey rectangle is reported, a plausible picture is not. So
// the rule is the same one the server uses before writing a chapter count onto
// a tracker entry: `STRONG`, or nothing.
//
// `native/src/covers.js` cannot be imported here — it pulls in the client's
// core, which wants AsyncStorage — so the pure function is lifted out of it the
// way the content scripts are lifted elsewhere. What runs below is the shipping
// source, not a copy of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import '../src/series-match.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'native', 'src', 'covers.js'), 'utf8');

const pickCover = (() => {
  const from = 'export function pickCover(hits, entry) {';
  const to = '/** A cover from the reader';
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  assert.ok(a !== -1 && b > a, 'pickCover is not where this test expects it in covers.js');
  // `export` is meaningless inside a Function body; the rest is verbatim.
  const body = src.slice(a, b).replace('export function', 'function');
  return new Function('Match', `${body}\n return pickCover;`)(globalThis.PanelFlowMatch);
})();

const hit = (title, over = {}) => ({
  id: '1', title, coverUrl: `https://cdn.test/${title}.jpg`, ...over,
});

test('an exact title match becomes the cover', () => {
  const hits = [hit('Ao no Hako')];
  assert.equal(pickCover(hits, { title: 'Ao no Hako' }), 'https://cdn.test/Ao no Hako.jpg');
});

test('a different work with a similar name is refused', () => {
  // The case this whole rule exists for. "Boruto: Naruto Next Generations" and
  // "Naruto" are two works, and a search for one returns the other.
  const hits = [hit('Naruto')];
  assert.equal(pickCover(hits, { title: 'Boruto: Naruto Next Generations' }), null);
});

test('a match on an alternative title counts', () => {
  // How a light novel is usually found: the shelf holds the English title the
  // site used, the tracker's main title is the romaji one.
  const hits = [hit('Ao no Hako', { altTitles: ['Blue Box'] })];
  assert.equal(pickCover(hits, { title: 'Blue Box' }), 'https://cdn.test/Ao no Hako.jpg');
});

test('a hit with no picture is skipped, not taken as an answer', () => {
  // A tracker entry with no artwork must not stop the search: the next hit may
  // be the same work with one.
  const hits = [hit('Ao no Hako', { coverUrl: null }), hit('Ao no Hako')];
  assert.equal(pickCover(hits, { title: 'Ao no Hako' }), 'https://cdn.test/Ao no Hako.jpg');
});

test('the first hit that clears the bar wins, not the first hit', () => {
  const hits = [hit('Something Else Entirely'), hit('Ao no Hako')];
  assert.equal(pickCover(hits, { title: 'Ao no Hako' }), 'https://cdn.test/Ao no Hako.jpg');
});

test('nothing at all is a grey rectangle, not a crash', () => {
  assert.equal(pickCover(undefined, { title: 'Ao no Hako' }), null);
  assert.equal(pickCover([], { title: 'Ao no Hako' }), null);
  assert.equal(pickCover([null], { title: 'Ao no Hako' }), null);
});

test('a short title is not fuzzy-matched', () => {
  // shared/series-match.js refuses to score short titles on bigrams — "Gantz"
  // and "Gantz:O" would otherwise pass. Asserted here because the cover path is
  // exactly where a near-miss on a short name would go unnoticed.
  assert.equal(pickCover([hit('Gantz:O')], { title: 'Gantz' }), null);
  assert.equal(pickCover([hit('Gantz')], { title: 'Gantz' }), 'https://cdn.test/Gantz.jpg');
});

test('the bar really is the shared one, not a number copied into this file', () => {
  // If someone lowers it locally to "fill in more covers", this fails.
  assert.equal(globalThis.PanelFlowMatch.STRONG, 0.9);
  assert.ok(src.includes('Match.STRONG'), 'covers.js no longer defers to the shared threshold');
  assert.ok(!/>=\s*0\.\d/.test(src), 'covers.js has a hand-written threshold in it');
});
