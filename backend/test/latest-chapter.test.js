// "What is the latest chapter of this series?" — asked twice, by two different
// pieces of code, and they have to agree.
//
// The server asks it of raw HTML (maxChapterIn, in shared/panelflow-core.js);
// the extension asks it of the live DOM (latestChapterInDom, in
// extension/content/detect.js). The answer is written into the library as
// lastKnownChapter and is what "new chapter" notifications compare against, so
// a wrong number is not cosmetic: it tells the user a chapter exists that does
// not, and then never tells them again about the ones that do.
//
// The bug both of these were written against: a series page carries a carousel
// of *other* series, each card reading "Hajime no Ippo Chapitre 1515". A single
// maximum over the whole page answered 1515 for a series whose own chapters
// stop at 125 — and answered a different number on the next load, because the
// carousel rotates. Hence passes, best source first, rather than one scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maxChapterIn } from '../src/panelflow-core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// detect.js is a browser IIFE with no exports, so the rule is lifted out of the
// source rather than reimplemented — the same trick chapter-labels.test.js
// uses, and for the same reason: the rule under test is the one that ships.
const src = readFileSync(join(root, 'extension', 'content', 'detect.js'), 'utf8');
const from = src.indexOf('  function latestChapterInDom');
const to = src.indexOf('  // The chapter this page IS');
assert.ok(from !== -1 && to > from, 'the chapter rule is not where this test expects it');
const latestChapterInDom = new Function(`${src.slice(from, to)}\nreturn latestChapterInDom;`)();

/**
 * Enough of a DOM for the rule under test, which only ever calls
 * querySelectorAll, getAttribute and textContent. A real parser would add a
 * dependency to test fifteen lines that never touch anything else.
 */
const dom = (els) => ({
  querySelectorAll: () => els.map((el) => ({
    getAttribute: (name) => el[name] ?? null,
    textContent: el.text ?? '',
  })),
});

// A series page as the sites actually build one: its own chapter list, plus a
// sidebar of unrelated series whose numbers run much higher.
const CAROUSEL = [
  { text: 'Hajime no Ippo Chapitre 1515', href: '/manga/hajime-no-ippo' },
  { text: 'One Piece Chapitre 1120', href: '/manga/one-piece' },
  { text: 'Naruto Chapitre 700', href: '/manga/naruto' },
];
const OWN_CHAPTERS = [
  { text: 'Chapitre 125', href: '/manga/kagurabachi/chapitre-125' },
  { text: 'Chapitre 124', href: '/manga/kagurabachi/chapitre-124' },
  { text: 'Chapitre 1', href: '/manga/kagurabachi/chapitre-1' },
];

const asHtml = (els) => els.map((e) => `<a href="${e.href}">${e.text}</a>`).join('\n');

test('a carousel of other series cannot outbid the series\' own chapter links', () => {
  const els = [...CAROUSEL, ...OWN_CHAPTERS];
  assert.equal(maxChapterIn(asHtml(els)), 125);
  assert.equal(latestChapterInDom(dom(els)), '125');
});

test('the answer does not change when the carousel rotates', () => {
  // This is what made the bug so hard to see from the outside: two loads of the
  // same page, two different "latest chapters", and a notification each time.
  const rotated = [
    { text: 'Solo Leveling Chapitre 179', href: '/manga/solo-leveling' },
    { text: 'Berserk Chapitre 374', href: '/manga/berserk' },
  ];
  const first = maxChapterIn(asHtml([...CAROUSEL, ...OWN_CHAPTERS]));
  const second = maxChapterIn(asHtml([...rotated, ...OWN_CHAPTERS]));
  assert.equal(first, second);
  assert.equal(latestChapterInDom(dom([...CAROUSEL, ...OWN_CHAPTERS])),
    latestChapterInDom(dom([...rotated, ...OWN_CHAPTERS])));
});

test('the server and the extension answer the same number on the same page', () => {
  // They are separate implementations against separate inputs — one reads
  // markup, the other a DOM — and the whole point is that the user sees one
  // answer whichever client they are holding.
  for (const els of [
    [...OWN_CHAPTERS, ...CAROUSEL],
    OWN_CHAPTERS,
    [{ text: 'Chapter 42', href: '/read/x/chapter-42' }],
    [{ text: 'Ch. 7.5', href: '/read/x/chapitre-7-5' }],
  ]) {
    assert.equal(String(maxChapterIn(asHtml(els))), latestChapterInDom(dom(els)));
  }
});

test('a chapter list rendered as a dropdown is read too', () => {
  // Some sites ship no chapter links at all: the list is a <select>, and the
  // number lives in the option's value.
  const els = [
    { value: 'chapitre-110', text: 'Chapitre 110' },
    { value: 'chapitre-109', text: 'Chapitre 109' },
  ];
  assert.equal(latestChapterInDom(dom(els)), '110');
  assert.equal(maxChapterIn(els.map((e) => `<option value="${e.value}">${e.text}</option>`).join('')), 110);
});

test('the loose-text pass still runs when nothing on the page links a chapter', () => {
  // Last resort, and it is allowed to be wrong about a carousel — being wrong
  // beats "this series has no chapters" on a page that plainly says otherwise.
  const html = '<div class="latest">Dernier chapitre : Chapitre 88</div>';
  assert.equal(maxChapterIn(html), 88);
  assert.equal(latestChapterInDom(dom([{ text: 'Lire le Chapitre 88' }])), '88');
});

test('a page with no chapter anywhere says so instead of guessing', () => {
  assert.equal(maxChapterIn('<h1>Kagurabachi</h1><p>Aucun chapitre disponible.</p>'), null);
  assert.equal(latestChapterInDom(dom([{ text: 'Accueil', href: '/' }])), null);
});

test('a number too large to be a chapter is not one', () => {
  // Ids, years and timestamps sit in hrefs all over these pages.
  const els = [
    { text: 'Chapitre 12', href: '/manga/x/chapitre-12' },
    { text: 'Chapter 20240115', href: '/manga/x/chapter-20240115' },
  ];
  assert.equal(maxChapterIn(asHtml(els)), 12);
  assert.equal(latestChapterInDom(dom(els)), '12');
});
