// Chapters that are published as a whole tome.
//
// Reported from sushiscan: "on a chapter the extension activates, and on the
// volumes it does not detect anything at all". The second half was measured on
// https://sushiscan.fr/bleach-volume-1/ — 188 panels in one #readerarea, every
// one of them wide enough, 188 rows — and the page was still turned away at the
// door. scan() vetoes anything the gallery gate accepts unless chapterEvidence()
// also says yes, and on that page nothing said yes: the URL and the <title> say
// "volume", which the chapter pattern has never heard of, the path is not
// /read/, and the prev/next links read "Précédent" and "Suivant" rather than
// the full "chapitre précédent" the nav pattern demands.
//
// So a volume became a unit the project can name. The one thing it deliberately
// is NOT is a chapter number: a tome holds seven or eight chapters, and the
// forward-only bookmark, the tracker push and "is there a further chapter" all
// read chapterNumber() off a label. "Vol. 1" answers none of them, on purpose —
// reading tome 1 must not tell MyAnimeList that somebody is on chapter 1.
//
// Same lifting trick as auto-open.test.js and panel-strip.test.js: detect.js is
// a browser IIFE with no exports, so each helper is pulled out of the shipping
// source and run here, and a test cannot pass against code that does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chapterNumber, volumeNumber } from '../src/site-rules.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'extension', 'content', 'detect.js'), 'utf8');

const lift = (startMark, endMark, params, exported) => {
  const from = src.indexOf(startMark);
  const to = src.indexOf(endMark, from);
  assert.ok(from !== -1 && to > from, `${startMark.trim()} is not where this test expects it`);
  return new Function(...params, `${src.slice(from, to)}\nreturn ${exported};`);
};

const at = (href) => new URL(href);

// --- the number -------------------------------------------------------------

test('a tome is a number this project can read', () => {
  assert.equal(volumeNumber('/bleach-volume-1/'), '1');
  assert.equal(volumeNumber('/one-piece-tome-105/'), '105');
  assert.equal(volumeNumber('Bleach Vol. 74 - SushiScan'), '74');
  // Same two guards the chapter pattern carries: a number that runs into more
  // characters is part of an id, and four digits is a year or a view count.
  assert.equal(volumeNumber('/v/3bde6546-e07c/volume-3bde6546'), null);
  assert.equal(volumeNumber('volume-10000'), null);
});

test('a word that merely starts like one is left alone', () => {
  // The keyword needs a boundary in front of it and digits behind it, which is
  // what keeps "vol" out of the middle of ordinary words.
  assert.equal(volumeNumber('/volleyball-2/'), null);
  assert.equal(volumeNumber('/evolution-3/'), null);
  assert.equal(volumeNumber('/revolution-9/'), null);
});

test('a volume is not a chapter, and is never filed as one', () => {
  // The whole reason volumeNumber() is a second function rather than a wider
  // CHAPTER_IN. Everything that ranks progress reads chapterNumber() off a
  // label; a tome holding chapters 1 to 7 must not answer "1" to any of them.
  assert.equal(chapterNumber('/bleach-volume-1/'), null);
  assert.equal(chapterNumber('/one-piece-tome-105/'), null);
  assert.equal(chapterNumber('Vol. 74'), null);
  // And the reverse, so the two patterns cannot quietly become one.
  assert.equal(volumeNumber('/bleach-chapitre-686/'), null);
});

// --- what the page calls itself ---------------------------------------------

const chapterLabelHere = lift(
  '  // The chapter this page IS', '  function coverGuess',
  ['location', 'document', 'chapterNumber', 'volumeNumber'], 'chapterLabelHere');

const labelAt = (href, title = '') =>
  chapterLabelHere(at(href), { title }, chapterNumber, volumeNumber)();

test('a volume page says which volume, in a form no chapter can be mistaken for', () => {
  assert.equal(labelAt('https://sushiscan.fr/bleach-volume-1/', 'Bleach Volume 1 - SushiScan'),
    'Vol. 1');
  assert.equal(labelAt('https://sushiscan.fr/', 'Tome 3'), 'Vol. 3');
  // Which is the point: read back, this label names no chapter.
  assert.equal(chapterNumber(labelAt('https://sushiscan.fr/bleach-volume-1/')), null);
});

test('a chapter still wins when the page names both', () => {
  // A volume is the fallback, never the winner. Plenty of readers put the tome
  // in the breadcrumb of a page that is one chapter of it.
  assert.equal(labelAt('https://x.fr/naruto-volume-3-chapitre-21/'), 'Ch. 21');
  assert.equal(labelAt('https://x.fr/naruto-volume-3/', 'Naruto Volume 3, Chapter 21'), 'Ch. 21');
});

test('a decimal chapter spelled with a hyphen is read off the title', () => {
  // sushiscan writes 686.5 as "686-5" in the address, which the pattern reads
  // as the end of chapter 686 — and 686 is a chapter of its own, published
  // days earlier. The title is the one that saw the point.
  assert.equal(
    labelAt('https://sushiscan.fr/bleach-chapitre-686-5/', 'Bleach Chapitre 686.5 - SushiScan'),
    'Ch. 686.5');
  // Only when they agree on the whole number. A title about something else
  // does not get to relabel the page.
  assert.equal(
    labelAt('https://sushiscan.fr/bleach-chapitre-686/', 'Bleach Chapitre 12.5 - SushiScan'),
    'Ch. 686');
  assert.equal(labelAt('https://sushiscan.fr/bleach-chapitre-686/'), 'Ch. 686');
});

test('a page that names neither is still nameless', () => {
  assert.equal(labelAt('https://sushiscan.fr/manga/bleach/', 'Bleach - SushiScan'), null);
});

// --- the gate that was turning them away -------------------------------------

const chapterEvidence = lift(
  '  // A chapter page names its chapter', '  // --- prose chapters',
  ['location', 'chapterLabelHere', 'hasChapterNav'], 'chapterEvidence');

const evidenceAt = (href, { label = null, nav = false } = {}) =>
  chapterEvidence(at(href), () => label, () => nav)();

test('a volume page is a chapter page as far as the detector is concerned', () => {
  // The bug, in one line: 188 panels, and this returned false. Wired to the
  // real labeller rather than a stubbed one, because the two halves passing
  // separately is what the shipping page could not do.
  const evidence = (href, title) =>
    chapterEvidence(at(href), () => labelAt(href, title), () => false)();
  assert.equal(evidence('https://sushiscan.fr/bleach-volume-1/', 'Bleach Volume 1 - SushiScan'),
    true);
  assert.equal(evidence('https://sushiscan.fr/bleach-chapitre-686-5/', 'Bleach Chapitre 686.5'),
    true, 'and the chapter pages that always worked still do');
});

test('the gate still keeps out everything it was built to keep out', () => {
  assert.equal(evidenceAt('https://sushiscan.fr/'), false, 'a home page is never a chapter');
  assert.equal(evidenceAt('https://sushiscan.fr/manga/bleach/'), false, 'nor is a series page');
  assert.equal(evidenceAt('https://x.fr/read/12/'), true);
  assert.equal(evidenceAt('https://x.fr/anything/', { nav: true }), true);
});

// --- the series it belongs to -------------------------------------------------

const cleanTitle = lift(
  '    const clean = (s) =>', '    let title = null;',
  ['location', 'rules', 'window'], 'clean');

const clean = (s) => cleanTitle({ hostname: 'sushiscan.fr' }, { seo: {} }, {})(s);

test('the tome counter is cut off the series name', () => {
  // Otherwise the shelf grows one series per volume: "Bleach Volume 1",
  // "Bleach Volume 2", none of them the series anybody is following.
  assert.equal(clean('Bleach Volume 1 - SushiScan'), 'Bleach');
  assert.equal(clean('One Piece Tome 105'), 'One Piece');
  assert.equal(clean('Bleach Vol. 74'), 'Bleach');
  // Unchanged for the counter it always cut.
  assert.equal(clean('Blue Box Chapter 5 — SushiScan'), 'Blue Box');
});
