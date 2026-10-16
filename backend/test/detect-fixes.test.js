// The detector's answers on the pages the QA campaign of October 2026 found
// it wrong on (qa-sim/BUGS.md), each pinned to the bug it was.
//
// Same lifting trick as panel-strip.test.js and page-by-page.test.js:
// detect.js is a browser IIFE with no exports, so each part is pulled out of
// the shipping source and run here against a stub DOM. What is tested is the
// code that ships.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chapterNumber } from '../src/site-rules.js';
import { seriesKey } from '../src/series-match.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'extension', 'content', 'detect.js'), 'utf8');

/** A slice of detect.js between two markers, run with `inject` as its free variables. */
const lift = (from, to, names, inject) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to);
  assert.ok(a !== -1 && b > a, `${from.trim()} is not where this test expects it`);
  const keys = Object.keys(inject);
  return new Function(...keys, `${src.slice(a, b)}\nreturn { ${names.join(', ')} };`)(
    ...keys.map((k) => inject[k]));
};

// --- chapter navigation ------------------------------------------------------

const { pageTemplate } = lift('  /** A link that reads as a page turn', '  function nextPageLink(',
  ['pageTemplate'], {});

/** An <a> as chapterNav reads one, its href attribute written as the address. */
const anchor = (href, text = '') => {
  const u = new URL(href);
  return {
    host: u.host, pathname: u.pathname, search: u.search, href, textContent: text,
    getAttribute: (name) => (name === 'href' ? href : null),
  };
};

/**
 * chapterNav on a page at `here`, with these links and <select>s, and the
 * site's own arrows (`arrows`: { next, prev } elements) when it has a rule.
 */
function nav(here, { links = [], selects = [], arrows = {} } = {}) {
  const anchors = links.map(([href, text]) => anchor(href, text));
  const url = new URL(here);
  const document = {
    querySelectorAll: (sel) => (sel === 'select' ? selects : sel === 'a[href]' ? anchors : []),
    querySelector: () => null,
  };
  const location = { href: here, host: url.host, pathname: url.pathname, search: url.search };
  const rule = { nextChapter: arrows.next ? 'NEXT' : undefined, prevChapter: arrows.prev ? 'PREV' : undefined };
  const { chapterNav } = lift('  const CHAPTERISH', '  function seriesUrlGuess() {', ['chapterNav'], {
    document, location, chapterNumber, pageTemplate,
    window: { PanelFlowMatch: { seriesKey } },
    siteFor: () => rule,
    firstMatch: (sel) => (sel === 'NEXT' ? arrows.next : sel === 'PREV' ? arrows.prev : null) || null,
  });
  return chapterNav();
}

const MANGAGO = 'https://www.mangago.me/read-manga/crimson-blade/uu/br_chapter-2';

test('NEW-19: a "next" that turns the page is not the next chapter', () => {
  // mangago's "next" goes from /pg-1/ to /pg-2/ of the same chapter, and its
  // address names the chapter: it was taken for the next chapter, and at the
  // end of a chapter auto-next went back to its own second page for ever.
  const n = nav(`${MANGAGO}/pg-1/`, { links: [[`${MANGAGO}/pg-2/`, 'Next']] });
  assert.equal(n.nextUrl, null);
  assert.ok(!n.options.some((o) => o.url.endsWith('/pg-2/')), 'a page of this chapter is not a row of the list');
  // And when the page does link the next chapter, that is the answer.
  const m = nav(`${MANGAGO}/pg-1/`, { links: [
    [`${MANGAGO}/pg-2/`, 'Next'],
    ['https://www.mangago.me/read-manga/crimson-blade/uu/br_chapter-3/pg-1/', 'Ch.3'],
  ] });
  assert.equal(m.nextUrl, 'https://www.mangago.me/read-manga/crimson-blade/uu/br_chapter-3/pg-1/');
});

test('RS-4: on the newest chapter, an arrow pointing at the series page is no next chapter', () => {
  const series = 'https://www.mangaread.org/manga/i-killed-an-academy-player/';
  const here = `${series}chapter-140/`;
  const n = nav(here, {
    links: [[`${series}chapter-139/`, 'Prev'], [series, 'Next']],
    arrows: { next: { href: series }, prev: { href: `${series}chapter-139/` } },
  });
  assert.equal(n.nextUrl, null, 'the series page was offered as the next chapter');
  assert.equal(n.prevUrl, `${series}chapter-139/`);
});

test('RS-6: one link to the next chapter of this series is enough to go there', () => {
  // fmteam: the page links the next chapter and nothing else, with an icon.
  const n = nav('https://fmteam.fr/read/kingdom/fr/ch/888', {
    links: [['https://fmteam.fr/read/kingdom/fr/ch/889#1', '']],
  });
  assert.equal(n.nextUrl, 'https://fmteam.fr/read/kingdom/fr/ch/889#1');
  assert.deepEqual(n.options.map((o) => o.n), [889, 888]);
});

test('RS-6 stays careful: a lone link to another series is not a neighbour', () => {
  const n = nav('https://fmteam.fr/read/kingdom/fr/ch/888', {
    links: [['https://fmteam.fr/read/blue-box/fr/ch/109', 'Blue Box 109']],
  });
  assert.equal(n.nextUrl, null);
  assert.equal(n.prevUrl, null);
});

test('an arrow that goes the wrong way is not taken', () => {
  const base = 'https://scan.test/manga/x/chapter-';
  const n = nav(`${base}10`, { arrows: { next: { href: `${base}9` }, prev: { href: `${base}11` } },
    links: [[`${base}9`, '9'], [`${base}11`, '11']] });
  assert.equal(n.nextUrl, `${base}11`);
  assert.equal(n.prevUrl, `${base}9`);
});

test('H26: a series of 5,000 chapters keeps the chapter being read in its list, and both neighbours', () => {
  const base = 'https://scan.test/manga/long/chapter-';
  const options = Array.from({ length: 5000 }, (_, i) => ({
    value: `${base}${5000 - i}`, textContent: `Chapter ${5000 - i}`,
  }));
  const n = nav(`${base}50`, { selects: [{ options }] });
  assert.ok(n.options.length <= 2000, `${n.options.length} rows`);
  assert.ok(n.options.some((o) => o.n === 50), 'the chapter being read is not in its own list');
  assert.ok(n.options.some((o) => o.n === 1), 'the oldest chapters are out of reach');
  assert.equal(n.nextUrl, `${base}51`);
  assert.equal(n.prevUrl, `${base}49`);
});

// --- is it a chapter -----------------------------------------------------------

test('NEW-16: a MangaDex chapter whose id starts with a letter is a chapter', () => {
  const at = (pathname) => lift('  // A chapter page names its chapter', '  // --- prose chapters',
    ['chapterEvidence'], {
      location: { pathname },
      chapterLabelHere: () => null,
      hasChapterNav: () => false,
      headingChapter: () => null,
      siteFor: () => ({ pageApi: { from: '/chapter/([0-9a-fA-F-]{36})' } }),
    }).chapterEvidence();
  assert.equal(at('/chapter/c8d169e9-1234-4abc-9def-0123456789ab'), true);
  assert.equal(at('/chapter/38d169e9-1234-4abc-9def-0123456789ab'), true);
  assert.equal(at('/title/c8d169e9-1234-4abc-9def-0123456789ab/some-title'), false,
    'a series page is still not a chapter');
});

// --- which images are pages ----------------------------------------------------

const { lazySrc } = lift("  // Where a page's address is", '  async function stableImageSrc',
  ['lazySrc'], { location: { href: 'https://www.webtoons.com/en/x/y/ep-1/viewer' } });

/** An <img> as these helpers read one. */
const img = ({ src = '', natural = [800, 1200], rect = null, complete = true, attrs = {} } = {}) => ({
  src, currentSrc: '', complete,
  naturalWidth: natural[0], naturalHeight: natural[1], width: natural[0], height: natural[1],
  getBoundingClientRect: () => ({ width: rect ? rect[0] : natural[0], height: rect ? rect[1] : natural[1] }),
  getAttribute: (name) => attrs[name] ?? null,
});

test('NEW-15: a stand-in file in src loses to the slice kept in data-url', () => {
  // webtoons.com parks a real, tiny file in src and the slice in data-url;
  // the reader opened episodes on the four slices that happened to be loaded.
  const slice = 'https://webtoon-phinf.pstatic.net/2014/001.jpg?type=q90';
  const standIn = 'https://webtoons-static.pstatic.net/image/bg_transparency.png';
  assert.equal(lazySrc(img({ src: standIn, natural: [16, 16], attrs: { 'data-url': slice } })), slice);
  assert.equal(lazySrc(img({ src: standIn, complete: false, natural: [0, 0], attrs: { 'data-url': slice } })),
    slice, 'by its name, before it has even loaded');
  // A real page that a lazy loader has already swapped in keeps its address.
  const page = 'https://cdn.test/ch/1/01.jpg';
  assert.equal(lazySrc(img({ src: page, attrs: { 'data-src': page } })), page);
  assert.equal(lazySrc(img({ src: page, attrs: { 'data-src': 'https://cdn.test/ch/1/01-small.jpg' } })), page,
    'a decoded page is not a stand-in because a data- attribute disagrees');
});

const sizing = (minImageWidth, innerWidth) => {
  const saved = globalThis.innerWidth;
  globalThis.innerWidth = innerWidth;
  const out = lift('  /** An image big enough', '  // --- is this page actually a chapter?',
    ['sizedImage', 'brokenImage', 'minBoxWidth'], { rules: { heuristics: { minImageWidth } }, lazySrc });
  return { ...out, restore: () => { globalThis.innerWidth = saved; } };
};

test('RS-3: on a phone, a page still loading is judged against the phone\'s width', () => {
  const loading = { src: 'https://cdn.test/ch/1/05.jpg', natural: [0, 0], complete: false };
  const pending = img({ ...loading, rect: [360, 0] });
  const phone = sizing(400, 412);
  try {
    assert.equal(phone.sizedImage(pending), true, 'a strip 360 px wide on a 412 px phone is a strip');
    assert.equal(phone.sizedImage(img({ ...loading, rect: [150, 0] })), false, 'a cover in a carousel is not');
  } finally { phone.restore(); }
  const desktop = sizing(400, 1280);
  try {
    assert.equal(desktop.sizedImage(pending), false, 'on a desktop the bar is where it was');
  } finally { desktop.restore(); }
});

test('NEW-12: an image whose load failed is not a page', () => {
  const { sizedImage, brokenImage, restore } = sizing(300, 1280);
  try {
    const refused = img({ src: 'https://ads.test/banner.png', natural: [0, 0], rect: [728, 90] });
    assert.equal(brokenImage(refused), true);
    assert.equal(sizedImage(refused), false, 'a refused banner as wide as a panel became a page');
    const pending = img({ src: 'https://cdn.test/ch/1/02.jpg', natural: [0, 0], complete: false, rect: [800, 0] });
    assert.equal(brokenImage(pending), false, 'a page still loading is not broken');
    assert.equal(sizedImage(pending), true);
  } finally { restore(); }
});

test('NEW-12: in the strip, a page the network dropped stays, a refused advert goes', () => {
  const { sizedImage, brokenImage, restore } = sizing(300, 1280);
  try {
    const { folderOf } = lift('  /** The folder of an address, host left out', '  function panelIn(',
      ['folderOf'], {});
    const { currentStrip } = lift('  // The strip as it is now', '  /** How many panels', ['currentStrip'],
      { sizedImage, lazySrc, brokenImage, folderOf, galleryImages: () => null });
    const page = (i) => img({ src: `https://cdn.test/ch/7/${i}.jpg` });
    const dropped = img({ src: 'https://cdn.test/ch/7/4.jpg', natural: [0, 0] });
    const advert = img({ src: 'https://adserver.test/creative/300x250.png', natural: [0, 0], rect: [800, 250] });
    const all = [page(1), page(2), page(3), dropped, advert, page(5)];
    const strip = currentStrip({ container: { querySelectorAll: () => all }, images: [all[0], all[1], all[2]] });
    assert.deepEqual(strip.images.map((i) => i.src), [
      'https://cdn.test/ch/7/1.jpg', 'https://cdn.test/ch/7/2.jpg', 'https://cdn.test/ch/7/3.jpg',
      'https://cdn.test/ch/7/4.jpg', 'https://cdn.test/ch/7/5.jpg',
    ]);
  } finally { restore(); }
});

test('RS-5: a row of badges laid out on the page is not a chapter parked in it', () => {
  const NAMES = ['parkedStrip'];
  const badge = (i) => ({
    src: `https://www.royalroadcdn.com/public/ui/${i}.png`, currentSrc: '', complete: true,
    naturalWidth: 48, naturalHeight: 48, getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 48, height: 48 }),
  });
  const parked = (i) => ({
    src: '', currentSrc: '', complete: false, naturalWidth: 0, naturalHeight: 0,
    getAttribute: (n) => (n === 'data-src' ? `https://scan-vf.test/uploads/ch/9/${i}.jpg` : null),
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  });
  // The same page behind a spacer gif, which a browser decodes at once, at 1 px.
  const SPACER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const behindSpacer = (i) => ({ ...parked(i), src: SPACER, currentSrc: SPACER, complete: true, naturalWidth: 1, naturalHeight: 1 });
  const { brokenImage } = lift('  /** An image big enough', '  // --- is this page actually a chapter?',
    ['brokenImage'], { rules: { heuristics: { minImageWidth: 400 } }, lazySrc: () => '' });
  const run = (images) => lift('  /** A label that names a page rather than a chapter',
    '  // A chapter whose panels are not on the page at all.', NAMES, {
      rules: { heuristics: { minGalleryImages: 3, minImageWidth: 400 } },
      document: { images, querySelectorAll: () => [] },
      location: { href: 'https://www.royalroad.com/fiction/1/x/chapter/2/y' },
      sizedImage: () => false,
      lazySrc: (im) => (im.src && !im.src.startsWith('data:') ? im.src : im.getAttribute('data-src') || ''),
      isSpacer: () => false,
      brokenImage,
      minBoxWidth: () => 400,
      console: { warn: () => {} },
      fetch: undefined,
      DOMParser: undefined,
    }).parkedStrip();
  assert.equal(run([badge(1), badge(2), badge(3), badge(4), badge(5)]), null);
  assert.equal(run([parked(1), parked(2), parked(3)]).length, 3, 'a hidden chapter is still found');
  assert.equal(run([behindSpacer(1), behindSpacer(2), behindSpacer(3)]).length, 3,
    'the 1 px spacer in front of a parked page is not the page');
});

// --- prose ----------------------------------------------------------------------

/** A text chapter: a container of <p>s, some of them wrapped in a <div> of their own. */
function prose(lines, { wrapped = [] } = {}) {
  const container = { innerText: '', parentElement: null };
  const wrapper = { innerText: '', parentElement: container };
  const ps = lines.map((text, i) => ({ innerText: text, parentElement: wrapped.includes(i) ? wrapper : container }));
  // The <p>s anywhere inside an element, as the detector counts them to find
  // the wrapper that holds one paragraph and no other (paragraphSlot).
  const within = (el) => ps.filter((p) => {
    for (let up = p.parentElement; up; up = up.parentElement) if (up === el) return true;
    return false;
  });
  for (const el of [container, wrapper]) el.getElementsByTagName = (tag) => (tag === 'p' ? within(el) : []);
  container.innerText = lines.join('\n');
  container.querySelectorAll = (sel) => (sel === 'p' ? ps : []);
  const document = { querySelectorAll: (sel) => (sel === 'p' ? ps : []) };
  return lift('  const MIN_NOVEL_CHARS', '  function scorePage() {', ['novelContent'], {
    document, isVisible: () => true,
  }).novelContent();
}

const LONG = 'The rain had not stopped for three days, and the river was already over the road.';

test('a chapter keeps its short lines: the floor decides where the chapter is, not what it says', () => {
  const lines = [LONG, '“No.”', LONG, 'Silence.', LONG, LONG, '* * *', LONG, LONG, LONG,
    LONG, LONG, LONG, LONG, LONG, LONG, LONG, LONG, LONG];
  const got = prose(lines);
  assert.ok(got, 'the chapter was not found');
  assert.deepEqual(got.paragraphs, lines, 'lines of dialogue and scene breaks were dropped');
});

test('NEW-17: a paragraph the site wrapped in a <div> of its own is still in the chapter', () => {
  const lines = Array.from({ length: 16 }, (_, i) => `${i}. ${LONG}`);
  const got = prose(lines, { wrapped: [3] });
  assert.equal(got.paragraphs.length, 16);
  assert.equal(got.paragraphs[3], lines[3]);
});

test('RS-2: a chapter written in Japanese reads as prose', () => {
  const line = 'ある日、森の中で少女は小さな光を見つけた。';
  const lines = Array.from({ length: 25 }, () => line);
  const got = prose(lines);
  assert.ok(got, 'a syosetu chapter was not seen as text');
  assert.equal(got.paragraphs.length, 25);
});

// --- syosetu: its arrows, its words, its reactions (RS-2 on the real site) -------

const SYOSETU = 'https://ncode.syosetu.com/n1571ko/';
const SYOSETU_RULE = { medium: 'novel', nextChapter: 'a.c-pager__item--next', prevChapter: 'a.c-pager__item--before, a.c-pager__item--prev' };

/**
 * hasChapterNav on a page at `here`, with the site's rule and the page's
 * links given. `has` stands in for the rule's arrows; an arrow's href is
 * absolute, as a browser hands it out.
 */
function chapterNavHere({ here = `${SYOSETU}1/`, rule = null, links = [], has = () => null } = {}) {
  return lift('  // "Next" on its own is a carousel arrow.', '  // A chapter page names its chapter', ['hasChapterNav'], {
    document: { querySelectorAll: () => links.map((textContent) => ({ textContent })) },
    location: { href: here, pathname: new URL(here).pathname },
    siteFor: () => rule,
    firstMatch: has,
  }).hasChapterNav();
}

test('RS-2: the arrows a site rule names are chapter navigation, whatever they say', () => {
  // syosetu.com, chapter 1, as served on 2026-10-16: the pager says 目次
  // (contents) and 次へ ("next"), nothing a pattern could take for a chapter
  // turn, so the page was never seen as a chapter.
  const rule = SYOSETU_RULE;
  const pager = ['目次', '次へ'];
  assert.equal(chapterNavHere({ links: pager }), false, 'the words alone are not enough, as before');
  assert.equal(chapterNavHere({ rule, links: pager, has: (sel) => (sel === rule.nextChapter ? { href: `${SYOSETU}2/` } : null) }), true);
  // A page of the same site without the arrows (its home) is not a chapter by this.
  assert.equal(chapterNavHere({ rule, links: ['ランキング'] }), false);
});

test('RS-2: the same arrows turning the pages of the table of contents are not chapter navigation', () => {
  // syosetu's contents page uses the pager's class for its own pages (?p=2),
  // and so does webtoons.com's episode list (&page=11).
  const toc = (href) => chapterNavHere({ here: SYOSETU, rule: SYOSETU_RULE, links: ['次へ'],
    has: (sel) => (sel === SYOSETU_RULE.nextChapter ? { href } : null) });
  assert.equal(toc(`${SYOSETU}?p=2`), false, 'the second page of the contents made them a chapter');
  assert.equal(toc(`${SYOSETU}1/`), true, 'an arrow to an episode still is navigation');
});

test('a phrase that names the next or previous chapter in Japanese, Chinese or Korean is navigation', () => {
  for (const words of ['次話', '前話', '次のエピソード', '下一章', '上一章', '下一話', '다음화', '이전 화']) {
    assert.equal(chapterNavHere({ links: [words] }), true, words);
  }
  // "Next" alone is a carousel arrow, in any language.
  assert.equal(chapterNavHere({ links: ['次へ', '다음'] }), false);
  // 화 is "episode" only on its own: 다음 화면 is "next screen", 이전화면 "previous screen".
  assert.equal(chapterNavHere({ links: ['다음 화면', '이전화면'] }), false);
});

test('RS-2: syosetu\'s next episode is the next chapter, not the second page of this one', () => {
  // n1571ko is the novel's id, not a chapter number: /n1571ko/1/ to /n1571ko/2/
  // was read as two pages of chapter 1571, and the reader had no "next".
  assert.equal(pageTemplate(`${SYOSETU}1/`, `${SYOSETU}2/`), null);
  // The same with a port in the address (the QA mock serves it on one).
  assert.equal(pageTemplate('http://ncode.syosetu.com:8901/n1571ko/1/', 'http://ncode.syosetu.com:8901/n1571ko/2/'), null);
  const n = nav(`${SYOSETU}1/`, {
    links: [[`${SYOSETU}2/`, '次へ'], [SYOSETU, '目次']],
    arrows: { next: { href: `${SYOSETU}2/` } },
  });
  assert.equal(n.nextUrl, `${SYOSETU}2/`);
});

test('a listing\'s second page is not the second page of a chapter, a number in the host notwithstanding', () => {
  assert.equal(pageTemplate('https://manga4life.com/latest/', 'https://manga4life.com/latest/page/2'), null);
  // The shapes that are pages stay pages.
  assert.ok(pageTemplate('https://reader.test/read/series/fr/0/12/', 'https://reader.test/read/series/fr/0/12/page/2'));
  assert.ok(pageTemplate('https://scan.test/read/8841/3', 'https://scan.test/read/8841/4'));
  assert.ok(pageTemplate(`${MANGAGO}/pg-1/`, `${MANGAGO}/pg-2/`));
});

test('a folder of reaction buttons is furniture, a series called Chain Reaction is not', () => {
  const a = src.indexOf('  const FURNITURE = ');
  const FURNITURE = new Function(`${src.slice(a, src.indexOf('\n', a))}\nreturn FURNITURE;`)();
  assert.ok(FURNITURE.test('https://images.hinaproject.com/reaction/e5b6cba419310e8ff7bad5ff8a88eca65e495de6.png'));
  assert.ok(!FURNITURE.test('https://scans.test/manga/chain-reaction/chapter-3/01.jpg'));
});

test('badges are furniture as words of the address, never inside a word', () => {
  const a = src.indexOf('  const FURNITURE = ');
  const FURNITURE = new Function(`${src.slice(a, src.indexOf('\n', a))}\nreturn FURNITURE;`)();
  // What the real sites filed them as (qa-sim/runs/real-sites).
  for (const url of [
    'https://www.royalroadcdn.com/public/achievements/500-comments-small-AACAcBe0Ig0.png',
    'https://www.mangaread.org/wp-content/plugins/wpdiscuz/assets/sticker-3.png',
    'https://rizzfables.com/assets/images/default_pfp_mewo.webp',
    'https://forum.test/emotes/kekw.png',
  ]) assert.ok(FURNITURE.test(url), url);
  // A series called Medalist, a CDN folder called remote: pages.
  for (const url of [
    'https://scans.test/manga/medalist/chapter-12/01.jpg',
    'https://cdn.test/remote/series/9/chapter-3/04.webp',
    'https://scans.test/manga/the-awardee/chapter-1/02.jpg',
  ]) assert.ok(!FURNITURE.test(url), url);
});

test('a site that publishes novels is never read as a strip of pictures', () => {
  // An illustrated episode has a picture and a link to the next part: the
  // shape of mangago's one page per address. On a site whose rule says
  // novel, the text is the answer.
  const at = src.indexOf('    const proseSite = siteFor()?.medium === \'novel\';');
  assert.ok(at !== -1, 'the novel guard is gone');
  const guarded = src.slice(at, src.indexOf('    /**\n     * Prose, but only where prose is a possible answer.', at));
  assert.match(guarded, /const parked = proseSite \? null : parkedStrip\(\);/);
  assert.match(guarded, /const byNext = proseSite \? null : pagedByNext\(\);/);
});

test('parkedStrip: the folder with the most whole images wins, not the longest', () => {
  const run = (images) => lift('  /** A label that names a page rather than a chapter',
    '  // A chapter whose panels are not on the page at all.', ['parkedStrip'], {
      rules: { heuristics: { minGalleryImages: 3, minImageWidth: 400 } },
      document: { images, querySelectorAll: () => [] },
      location: { href: 'https://scan-vf.test/manga/x/chapitre-9' },
      sizedImage: () => false,
      lazySrc: (im) => im.getAttribute('data-src') || '',
      isSpacer: () => false,
      brokenImage: (im) => !!im.broken,
      minBoxWidth: () => 400,
      console: { warn: () => {} },
      fetch: undefined,
      DOMParser: undefined,
    }).parkedStrip();
  const img = (address, broken = false) => ({
    src: '', currentSrc: '', complete: false, naturalWidth: 0, naturalHeight: 0, broken,
    getAttribute: (n) => (n === 'data-src' ? address : null),
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
  });
  const pages = Array.from({ length: 5 }, (_, i) => img(`https://scan-vf.test/uploads/ch/9/${i + 1}.jpg`));
  // Eight refused ads and three that got through, filed together.
  const ads = Array.from({ length: 11 }, (_, i) => img(`https://ads.test/creatives/${i}.jpg`, i < 8));
  const got = run([...ads, ...pages]);
  assert.deepEqual(got, pages.map((p) => p.getAttribute('data-src')));
});
