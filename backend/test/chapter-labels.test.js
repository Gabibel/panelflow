// What the reader's chapter dropdown is allowed to say.
//
// Sites label the links that move you one chapter "Next" and "Prev", which is
// the right label on the page — the link sits next to the chapter you are on —
// and the wrong one in a list, where it answers a question nobody asked. On
// AsuraScans those two arrows are the *only* chapter links on the page, so the
// whole dropdown read "Next / Prev" with no numbers anywhere.
//
// detect.js is a browser IIFE with no exports, so the rule is lifted out of the
// source and run here. That is deliberate: it means the rule under test is the
// one that ships, not a copy of it that can quietly drift.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'extension', 'content', 'detect.js'), 'utf8');

const from = src.indexOf('const NAV_WORD');
const to = src.indexOf('function chapterNav');
assert.ok(from !== -1 && to > from, 'the label rule is not where this test expects it');
const optionLabel = new Function(`${src.slice(from, to)}\nreturn optionLabel;`)();

test('a label that already names its chapter is left alone', () => {
  // Whatever the site wrote is better than anything derived: it may carry the
  // volume, a part number, a decimal chapter.
  assert.equal(optionLabel('Chapitre 109', 109), 'Chapitre 109');
  assert.equal(optionLabel('Chapter 108 - Le match', 108), 'Chapter 108 - Le match');
  assert.equal(optionLabel('110.5', 110.5), '110.5');
});

test('a bare navigation word becomes the chapter number', () => {
  for (const [text, n, want] of [
    ['Next', 246, 'Ch. 246'],
    ['Prev', 244, 'Ch. 244'],
    ['Previous Chapter', 244, 'Ch. 244'],
    // French reverses the order, which is why the rule reads word by word
    // instead of matching one pattern written for English.
    ['Chapitre suivant', 110, 'Ch. 110'],
    ['Chapitre précédent', 108, 'Ch. 108'],
    ['Chapitre precedent', 108, 'Ch. 108'],
  ]) {
    assert.equal(optionLabel(text, n), want, `${text} should read as ${want}`);
  }
});

test('a label with no letters at all is navigation too', () => {
  // Arrows and chevrons, which is what a lot of sites use instead of a word.
  for (const text of ['«', '»', '←', '→', '<', '>', '', '   ']) {
    assert.equal(optionLabel(text, 42), 'Ch. 42');
  }
});

test('a real chapter name is kept, with its number in front', () => {
  // The number is what you navigate by; the name is why you would pick this
  // row over the one above it. Neither replaces the other.
  assert.equal(optionLabel('Prologue', 1), 'Ch. 1 — Prologue');
  assert.equal(optionLabel('Le match retour', 112), 'Ch. 112 — Le match retour');
  // "Chapter" alone is navigation, but "Chapter of Rain" is a title.
  assert.equal(optionLabel('Chapter', 7), 'Ch. 7');
  assert.equal(optionLabel('Chapter of Rain', 7), 'Ch. 7 — Chapter of Rain');
});

test('with no number to fall back on, the site\'s text survives', () => {
  // A list entry whose URL carries no chapter number: rewriting it to "Ch. NaN"
  // would replace a weak label with a broken one.
  assert.equal(optionLabel('Next', NaN), 'Next');
  assert.equal(optionLabel('Prologue', NaN), 'Prologue');
});

test('a label is never long enough to stretch the dropdown', () => {
  const long = optionLabel('A'.repeat(200), 12);
  assert.ok(long.length <= 70, `a 200-character label came back as ${long.length}`);
});
