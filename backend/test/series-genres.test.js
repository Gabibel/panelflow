// Which words end up as the tags of a series nobody has tagged yet.
//
// Reported with a screenshot: opening the library sheet on Kingdom — a war
// epic — offered "Adulte" and "Romance", pre-selected. Nothing about the series
// says either. They are the first two entries of sushiscan's genre dropdown,
// which is on every page of the site, and genresInDom() was reading the whole
// document: on a chapter page the site's own menu is the only place genre links
// exist, so the sheet was proposing the site's alphabet as the book's subject.
//
// The rule this file pins is that the answer has to come from the page's
// content, and that no answer is better than a wrong one — a form left empty is
// one the reader fills in, a form filled in wrongly is one they have to notice
// first.
//
// Lifted out of the shipping detect.js the way cover-guess.test.js does it: the
// file is a browser IIFE with no exports, so the function is pulled from the
// source rather than restated here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'extension', 'content', 'detect.js'), 'utf8');

const from = src.indexOf('  const SITE_CHROME =');
const to = src.indexOf('  // Latest chapter = max over');
assert.ok(from !== -1 && to > from, 'genresInDom is not where this test expects it');
// CHAPTERISH is declared further down the same IIFE, so it comes in as a
// parameter rather than being restated with a second, drifting copy.
const CHAPTERISH = /(chapter|chapitre|chap|ch|episode)[-_/ .]?\d/i;
const genresInDom = new Function(
  'CHAPTERISH', `${src.slice(from, to)}\nreturn genresInDom;`)(CHAPTERISH);

/**
 * One anchor. `where` is the selector of the element containing it, which is
 * what `closest` is asked about — 'main' for the article, 'nav' or '.menu' for
 * the site's own furniture.
 */
const a = (label, { href = '/genre/x/', rel = '', where = 'main' } = {}) => ({
  href,
  textContent: label,
  getAttribute: (k) => (k === 'rel' ? rel : null),
  rel,
  closest: (sel) => (sel.split(',').map((s) => s.trim()).includes(where) ? {} : null),
});

/** A page holding those anchors, matching the selector genresInDom asks for. */
const page = (anchors) => ({
  querySelectorAll: (sel) => {
    assert.match(sel, /genre/, 'the selector stopped looking for genre links');
    return anchors.filter((n) => /\/genre|\/tag/i.test(n.href) || /\btag\b/.test(n.rel));
  },
});

test('a series page answers with its own genres, in order and without repeats', () => {
  assert.deepEqual(genresInDom(page([
    a('Action'), a('Historique'), a('Seinen'), a('Action'),
    a('Guerre', { href: '/tag/guerre/' }),
    a('Drame', { href: '/manga-genre/drame/', rel: 'tag' }),
  ])), ['Action', 'Historique', 'Seinen', 'Guerre', 'Drame']);
});

test("the site's own menu is not the book's subject", () => {
  // Kingdom, exactly as reported: a chapter page whose only genre links are the
  // dropdown at the top of every page on the site.
  const menu = ['Adulte', 'Romance', 'Action', 'Comédie'].map((g) => a(g, { where: '.menu' }));
  assert.deepEqual(genresInDom(page(menu)), []);

  for (const where of ['nav', 'header', 'footer', 'aside', '.navbar', '.dropdown', '.submenu']) {
    assert.deepEqual(genresInDom(page([a('Romance', { where })])), [],
      `a genre link inside ${where} was taken for the series' own`);
  }
});

test('the genres in the article survive the menu around them', () => {
  assert.deepEqual(genresInDom(page([
    a('Adulte', { where: 'nav' }),
    a('Historique'),
    a('Romance', { where: 'footer' }),
  ])), ['Historique']);
});

test('a page offering more genres than a book has offers none', () => {
  // The site's own genre index, or a menu written in a class this file does not
  // know. Either way nothing on the page belongs to one series, and the wrong
  // eight out of forty is the failure that was reported.
  const many = Array.from({ length: 40 }, (_, i) => a(`Genre ${String.fromCharCode(65 + i % 26)}`));
  assert.deepEqual(genresInDom(page(many)), []);
  // Twelve is still a book with a lot of genres; thirteen is a catalogue.
  const twelve = Array.from({ length: 12 }, (_, i) => a(`G${String.fromCharCode(97 + i)}`));
  assert.equal(genresInDom(page(twelve)).length, 12);
  assert.deepEqual(genresInDom(page([...twelve, a('Gm')])), []);
});

test('what is plainly not a genre is dropped rather than offered', () => {
  assert.deepEqual(genresInDom(page([
    a('  Science-Fiction  '),
    a('Chapitre 874'),
    a('Chapter 12'),
    a('   '),
    a('Tous les mangas du catalogue classés par ordre alphabétique'),
    a('1998'),
  ])), ['Science-Fiction']);
});

test('a label split across lines is one word again', () => {
  assert.deepEqual(genresInDom(page([a('Tranche\n  de vie')])), ['Tranche de vie']);
});

test('an element with no closest at all is not treated as a menu', () => {
  // DOMParser gives real elements, but the stand-ins other tests in this suite
  // hand in do not always, and an anchor with no ancestors is not furniture.
  assert.deepEqual(genresInDom({
    querySelectorAll: () => [{ href: '/genre/action/', textContent: 'Action' }],
  }), ['Action']);
});
