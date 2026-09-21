// Chapters read one page at a time, on the two sites that made the mode
// necessary and in the two shapes they have.
//
// scan-vf writes every page into the markup as <img data-src> inside a hidden
// container and lays out one: the chapter is there, unmeasurable. mangago
// writes none of them — its script decodes an encrypted string into the <img>
// once the page runs — and offers a "next page" link whose address is this
// one's with the number one higher. The first is read by address, the second
// by walking, and each walk is handed over one page at a time so the reader
// opens on the first three.
//
// Lifted out of extension/content/detect.js rather than restated, with the
// DOM of each site reduced to what the code reads: a few images with
// addresses, a few links with words, a <select>, a script.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const djs = readFileSync(join(root, 'extension', 'content', 'detect.js'), 'utf8');

const NAMES = ['pageTemplate', 'nextPageLink', 'pageTotal', 'pagedByNext', 'parkedStrip', 'walkPages', 'folderOf'];

const lift = (inject) => {
  const from = '  /** A label that names a page rather than a chapter';
  const to = '  // A chapter whose panels are not on the page at all.';
  const a = djs.indexOf(from);
  const b = djs.indexOf(to);
  assert.ok(a !== -1 && b > a, 'the page walk is not where this test expects it');
  const keys = Object.keys(inject);
  return new Function(...keys, `${djs.slice(a, b)}
    return { ${NAMES.join(', ')} };`)(...keys.map((k) => inject[k]));
};

// --- a DOM small enough to read ----------------------------------------------

/** An <img> as the lifted code reads one: an address, a size, a box. */
const img = ({ src = '', dataSrc = null, wide = 0, laidOut = true }) => ({
  src, currentSrc: src, naturalWidth: wide, naturalHeight: wide ? 1500 : 0, complete: !!wide,
  getAttribute: (n) => (n === 'data-src' ? dataSrc : n === 'src' ? src : null),
  getBoundingClientRect: () => (laidOut && wide ? { width: 900, height: 1300, top: 0 } : { width: 0, height: 0, top: 0 }),
});

/** An <a> as nextPageLink reads one. */
const link = (href, words = {}) => ({
  textContent: words.text || '', title: words.title || '', rel: words.rel || '',
  className: words.className || '', id: words.id || '',
  getAttribute: (n) => (n === 'href' ? href : n === 'aria-label' ? words.aria || null : null),
});

const select = (labels) => ({ options: labels.map((l) => ({ textContent: String(l), value: String(l) })) });

/** The page as document and location, with the detector's helpers stubbed. */
function page({ href, images = [], links = [], selects = [], scripts = [] }) {
  const document = {
    images,
    scripts: scripts.map((textContent) => ({ src: '', textContent })),
    querySelectorAll: (sel) => (sel === 'select' ? selects : sel === 'a[href]' ? links : []),
    createElement: () => { throw new Error('this test builds no frame'); },
  };
  const isSpacer = (src) => src.startsWith('data:') && src.length < 512;
  const lifted = lift({
    rules: { heuristics: { minGalleryImages: 3 } },
    document,
    location: { href },
    // The detector's own two readings, reduced: an image counts when it has
    // a box, and its address is the lazy one when the src is a spacer.
    sizedImage: (im) => im.getBoundingClientRect().width >= 400,
    lazySrc: (im) => {
      if (im.src && !isSpacer(im.src)) return im.src;
      const v = im.getAttribute('data-src');
      return v ? new URL(v, href).href : '';
    },
    isSpacer,
    console: { warn: () => {} },
    fetch: undefined,
    DOMParser: undefined,
  });
  return lifted;
}

const SPACER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// --- the shape of one chapter's addresses, from two of them ------------------

test('mangago: /pg-1/ and /pg-2/ give every page of the chapter', () => {
  const { pageTemplate } = page({ href: 'https://m.test/' });
  const here = 'https://www.mangago.me/read-manga/borderline/uu/br_chapter-438912/pg-1/';
  const t = pageTemplate(here, 'https://www.mangago.me/read-manga/borderline/uu/br_chapter-438912/pg-2/');
  assert.ok(t, 'two pages of one chapter were not read as such');
  assert.equal(t.from, 1);
  assert.equal(t.at(1), 'https://www.mangago.me/read-manga/borderline/uu/br_chapter-438912/pg-1/');
  assert.equal(t.at(48), 'https://www.mangago.me/read-manga/borderline/uu/br_chapter-438912/pg-48/');
});

test('scan-vf: the bare chapter address, then /2', () => {
  const { pageTemplate } = page({ href: 'https://m.test/' });
  const t = pageTemplate('https://www.scan-vf.net/one_piece/chapitre-1193', 'https://www.scan-vf.net/one_piece/chapitre-1193/2');
  assert.ok(t);
  assert.equal(t.at(1), 'https://www.scan-vf.net/one_piece/chapitre-1193', 'page one is the address itself');
  assert.equal(t.at(17), 'https://www.scan-vf.net/one_piece/chapitre-1193/17');
});

test('a page in the query is a page too', () => {
  const { pageTemplate } = page({ href: 'https://m.test/' });
  const t = pageTemplate('https://r.test/reader?ch=5&page=1', 'https://r.test/reader?ch=5&page=2');
  assert.ok(t);
  assert.equal(t.at(7), 'https://r.test/reader?ch=5&page=7');
});

test('nine to ten and nineteen to twenty are one step, not a digit swap', () => {
  const { pageTemplate } = page({ href: 'https://m.test/' });
  assert.equal(pageTemplate('https://m.test/c/12/pg-9/', 'https://m.test/c/12/pg-10/').at(11), 'https://m.test/c/12/pg-11/');
  assert.equal(pageTemplate('https://m.test/c/12/pg-19/', 'https://m.test/c/12/pg-20/').from, 19);
  assert.equal(pageTemplate('https://m.test/c/12/pg-1/', 'https://m.test/c/12/pg-12/'), null, 'twelve is not the page after one');
});

test('the next chapter is never the next page', () => {
  // The failure this whole shape guards against: walking chapter 11, 12, 13
  // and opening the first page of forty chapters. Two chapters differ by one
  // run of digits too, and the number follows a chapter word.
  const { pageTemplate } = page({ href: 'https://m.test/' });
  assert.equal(pageTemplate('https://m.test/manga/op/chapter-11/', 'https://m.test/manga/op/chapter-12/'), null);
  assert.equal(pageTemplate('https://m.test/manga/op/chapitre-1193', 'https://m.test/manga/op/chapitre-1194'), null);
  assert.equal(pageTemplate('https://m.test/anime/x/episode-3', 'https://m.test/anime/x/episode-4'), null);
  // A bare number with nothing before it and no chapter number earlier is a
  // chapter as well: /manga/op/700 to /701.
  assert.equal(pageTemplate('https://m.test/manga/op/700', 'https://m.test/manga/op/701'), null);
  // And the same address twice, or two with nothing in common, are nothing.
  assert.equal(pageTemplate('https://m.test/a/1', 'https://m.test/a/1'), null);
  assert.equal(pageTemplate('https://m.test/a/1', 'https://m.test/b/2/3'), null);
});

// --- the link that says "next page" ------------------------------------------

const MANGAGO = 'https://www.mangago.me/read-manga/borderline/uu/br_chapter-438912/pg-1/';

test('mangago: "next >" with class next_page is the page turn, "Ch.13" is not', () => {
  const { nextPageLink } = page({
    href: MANGAGO,
    links: [
      link('/read-manga/borderline/uu/to_chapter-13/pg-1/', { text: 'Ch.13 : Next time' }),
      link('/read-manga/borderline/uu/br_chapter-438912/pg-2/', { text: 'next >', className: 'next_page' }),
    ],
  });
  const found = nextPageLink();
  assert.ok(found);
  assert.equal(found.href, 'https://www.mangago.me/read-manga/borderline/uu/br_chapter-438912/pg-2/');
});

test('a link with no page-turn word in it is not looked at, whatever its address', () => {
  const { nextPageLink } = page({
    href: MANGAGO,
    links: [link('/read-manga/borderline/uu/br_chapter-438912/pg-2/', { text: 'Borderline' })],
  });
  assert.equal(nextPageLink(), null);
});

test('"chapitre suivant" is a chapter turn however its address looks', () => {
  const { nextPageLink } = page({
    href: 'https://s.test/op/1193/3',
    links: [link('/op/1193/4', { text: 'Chapitre suivant' })],
  });
  assert.equal(nextPageLink(), null);
});

// --- how many pages, when the page says --------------------------------------

test('scan-vf: a <select> of 1 to 17 is the count, and its values are not addresses', () => {
  const { pageTotal } = page({ href: 'https://s.test/op/chapitre-1193', selects: [select([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])] });
  assert.equal(pageTotal(), 17);
});

test('a <select> of chapters (1189, 1190, 1191) is not a page count', () => {
  const { pageTotal } = page({ href: 'https://s.test/op/chapitre-1193', selects: [select([1193, 1192, 1191, 1190])] });
  assert.equal(pageTotal(), null);
});

test('mangago: total_pages=48 in a script is the count', () => {
  const { pageTotal } = page({
    href: MANGAGO,
    scripts: ['var pcurl = "/read-manga/x/pg-1/",current_chapter=76,total_chapters=76,current_page=1,total_pages=48,manga_name="Borderline";'],
  });
  assert.equal(pageTotal(), 48);
});

// --- the page put together -----------------------------------------------------

const PANEL = 'https://iweb_9.mangapicgallery.com/r/newpiclink/borderline/438912/438912_59311726.jpg';

test('mangago: one panel, a next link and a count give forty-eight addresses', () => {
  const { pagedByNext } = page({
    href: MANGAGO,
    images: [img({ src: PANEL, wide: 1280 }), img({ src: PANEL.replace('26.jpg', '27.jpg'), wide: 1280, laidOut: false })],
    links: [link('/read-manga/borderline/uu/br_chapter-438912/pg-2/', { text: 'next >', className: 'next_page' })],
    scripts: ['total_pages=48'],
  });
  const paged = pagedByNext();
  assert.ok(paged?.urls, 'the chapter was not read as one page per address');
  assert.equal(paged.urls.length, 48);
  assert.equal(paged.urls[0], MANGAGO);
  assert.equal(paged.urls[47], MANGAGO.replace('pg-1', 'pg-48'));
});

test('without a count, the walk is told to follow the link', () => {
  const { pagedByNext } = page({
    href: MANGAGO,
    images: [img({ src: PANEL, wide: 1280 })],
    links: [link('/read-manga/borderline/uu/br_chapter-438912/pg-2/', { text: 'next >' })],
  });
  const paged = pagedByNext();
  assert.equal(paged.urls, undefined);
  assert.equal(paged.first, MANGAGO);
  assert.equal(paged.follow, MANGAGO.replace('pg-1', 'pg-2'));
});

test('no panel on screen, no page-by-page: a series page with a "next" link is left alone', () => {
  const { pagedByNext } = page({
    href: 'https://m.test/list/page-1/',
    images: [],
    links: [link('/list/page-2/', { text: 'next' })],
  });
  assert.equal(pagedByNext(), null);
});

// --- the chapter parked in the page ------------------------------------------

const VF = 'https://www.scan-vf.net/uploads/manga/one_piece/chapters/chapitre-1193/';

test('scan-vf: seventeen hidden <img data-src> in one folder are the chapter, in order', () => {
  const hidden = Array.from({ length: 17 }, (_, i) =>
    img({ src: SPACER, dataSrc: ` ${VF}${String(i + 1).padStart(2, '0')}.webp `, wide: 0, laidOut: false }));
  const { parkedStrip } = page({
    href: 'https://www.scan-vf.net/one_piece/chapitre-1193',
    images: [
      img({ src: 'https://ads.test/wp-content/uploads/2026/08/bane.png', wide: 1254 }),
      img({ src: `${VF}01.webp`, wide: 1644 }), // the one laid out: page one again
      ...hidden,
      img({ src: 'https://www.scan-vf.net/uploads/manga/kingdom/cover/cover_250x350.jpg', wide: 250 }),
      img({ src: 'https://www.scan-vf.net/uploads/manga/naruto/cover/cover_250x350.jpg', wide: 250 }),
      img({ src: 'https://www.scan-vf.net/uploads/manga/bleach/cover/cover_250x350.jpg', wide: 250 }),
    ],
  });
  const pages = parkedStrip();
  assert.ok(pages, 'the hidden chapter was not found');
  assert.equal(pages.length, 17, 'page one, laid out and parked, is one page');
  assert.equal(pages[0], `${VF}01.webp`, 'the address is read without the spaces the site left around it');
  assert.equal(pages[16], `${VF}17.webp`);
});

test('three covers in three folders are not a chapter, nor are three in one', () => {
  const { parkedStrip } = page({
    href: 'https://www.scan-vf.net/one_piece',
    images: [
      img({ src: 'https://s.test/uploads/manga/a/cover/cover.jpg', wide: 250 }),
      img({ src: 'https://s.test/uploads/manga/b/cover/cover.jpg', wide: 250 }),
      img({ src: 'https://s.test/uploads/manga/c/cover/cover.jpg', wide: 250 }),
      img({ src: 'https://s.test/uploads/thumbs/1.jpg', wide: 250 }),
      img({ src: 'https://s.test/uploads/thumbs/2.jpg', wide: 250 }),
      img({ src: 'https://s.test/uploads/thumbs/3.jpg', wide: 250 }),
    ],
  });
  assert.equal(parkedStrip(), null);
});

// --- the walk, handing pages over as they come -------------------------------

/**
 * A walk over a site that answers fetches, with a spy on what it fetched. The
 * markup of page n carries the panel n in the chapter's folder; `broken` pages
 * carry nothing filed there, so the walk must try the frame, which this
 * harness refuses to build.
 */
function site({ href, urls, broken = [], follow = null }) {
  const fetched = [];
  const panel = (n) => `https://cdn.test/one-piece/1193/${String(n).padStart(2, '0')}.jpg`;
  const pageOf = (url) => Number((url.match(/(\d+)\/?$/) || [])[1] || 1);
  const html = (url) => {
    const n = pageOf(url);
    const p = broken.includes(n) ? '<img src="https://cdn.test/arrow.jpg">' : `<img src="${panel(n)}">`;
    const nx = follow && n < follow ? `<a href="${url.replace(/\d+\/?$/, '')}${n + 1}" class="next_page">next ></a>` : '';
    return `<html><body>${p}${nx}</body></html>`;
  };
  const lifted = lift({
    rules: { heuristics: { minGalleryImages: 3 } },
    document: {
      images: [img({ src: panel(1), wide: 1200 })],
      querySelectorAll: () => [],
      createElement: () => { throw new Error('frame'); },
    },
    location: { href },
    sizedImage: (im) => im.getBoundingClientRect().width >= 400,
    lazySrc: (im) => im.src,
    isSpacer: () => false,
    console: { warn: () => {} },
    fetch: async (url) => { fetched.push(url); return { ok: true, text: async () => html(url) }; },
    DOMParser: class {
      parseFromString(text) {
        const images = [...text.matchAll(/<img src="([^"]+)">/g)].map((m) => ({ getAttribute: (n) => (n === 'src' ? m[1] : null) }));
        const anchors = [...text.matchAll(/<a href="([^"]+)" class="([^"]+)">([^<]*)<\/a>/g)]
          .map((m) => link(m[1], { text: m[3], className: m[2] }));
        return { images, querySelectorAll: (sel) => (sel === 'a[href]' ? anchors : []) };
      }
    },
  });
  return { ...lifted, fetched, panel, urls };
}

test('the pages come out in order, one at a time, whatever order they were read in', async () => {
  const base = 'https://s.test/op/1193/';
  const urls = Array.from({ length: 6 }, (_, i) => `${base}${i + 1}`);
  const s = site({ href: urls[0], urls });
  const seen = [];
  const pages = await s.walkPages({ urls }, (src, index, total) => seen.push([index, total, src]));
  assert.equal(pages.length, 6);
  assert.deepEqual(seen.map((x) => x[0]), [0, 1, 2, 3, 4, 5], 'handed over in page order');
  assert.ok(seen.every((x) => x[1] === 6), 'each hand-over says how many there are');
  assert.equal(seen[0][2], s.panel(1), 'the page on screen is page one, not fetched');
  assert.ok(!s.fetched.includes(urls[0]), 'the page being read is never fetched');
  assert.equal(s.fetched.length, 5);
});

test('a page that could not be read costs one page, and the order holds', async () => {
  const base = 'https://s.test/op/1193/';
  const urls = Array.from({ length: 5 }, (_, i) => `${base}${i + 1}`);
  // Page three carries nothing filed with the chapter; the frame door, which
  // this harness cannot open, throws, and the walk goes on.
  const s = site({ href: urls[0], urls, broken: [3] });
  const seen = [];
  const pages = await s.walkPages({ urls }, (src) => seen.push(src));
  assert.deepEqual(pages, [1, 2, 4, 5].map(s.panel));
  assert.deepEqual(seen, pages);
});

test('the walk stops when the reader it feeds has closed', async () => {
  const base = 'https://s.test/op/1193/';
  const urls = Array.from({ length: 40 }, (_, i) => `${base}${i + 1}`);
  const s = site({ href: urls[0], urls });
  let count = 0;
  const pages = await s.walkPages({ urls }, () => { count += 1; }, () => count < 5);
  assert.ok(pages.length < 40, 'a closed reader is a walk that stops');
  assert.ok(s.fetched.length < 20, `${s.fetched.length} pages fetched for a reader nobody was looking at`);
});

test('with no list, the walk follows "next" until the link runs out', async () => {
  const base = 'https://s.test/op/1193/';
  const s = site({ href: `${base}1`, urls: null, follow: 7 });
  const seen = [];
  const pages = await s.walkPages({ first: `${base}1`, follow: `${base}2` }, (src, index, total) => seen.push([index, total]));
  assert.equal(pages.length, 7);
  assert.deepEqual(seen.map((x) => x[0]), [0, 1, 2, 3, 4, 5, 6]);
  assert.ok(seen.every((x) => x[1] === null), 'no count to promise');
});

test('the same folder is the same folder from another host', () => {
  // mangago serves one chapter from iweb_3 and iweb_9 by turns.
  const { folderOf } = page({ href: 'https://m.test/' });
  assert.equal(folderOf('https://iweb_9.cdn.test/r/x/438912/1.jpg'), folderOf('https://iweb_3.cdn.test/r/x/438912/2.jpg'));
  assert.notEqual(folderOf('https://iweb_9.cdn.test/r/x/438912/1.jpg'), folderOf('https://iweb_9.cdn.test/r/x/438913/1.jpg'));
});
