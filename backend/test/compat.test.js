// "Can PanelFlow read this page?" answered from markup alone.
//
// This is the thing the mobile app puts in front of the user before they open
// anything, so the cost of being wrong is asymmetric: calling a working site
// unsupported sends them away from a page that would have worked, while an
// over-optimistic "ready" costs one tap. The tests below pin that asymmetry as
// much as they pin the scoring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, pageImages, chapterLabel, latestChapter } from '../src/compat.js';

/** A chapter page as the real ones look: numbered panels, prev/next, a list. */
const chapterPage = (n = 20) => `
<html><head><title>Ao no Hako Chapitre 109 - ScanTest</title>
<meta property="og:image" content="/covers/ao-no-hako.jpg"></head>
<body>
  <a href="/manga/ao-no-hako/chapitre-108">Chapitre précédent</a>
  <a href="/manga/ao-no-hako/chapitre-110">Chapitre suivant</a>
  <div class="reader">
    ${Array.from({ length: n }, (_, i) =>
      `<img src="https://cdn.scan-test.io/ao/109/${String(i + 1).padStart(3, '0')}.webp">`).join('\n')}
  </div>
  <select>
    <option value="/manga/ao-no-hako/chapitre-109">109</option>
    <option value="/manga/ao-no-hako/chapitre-110">110</option>
  </select>
</body></html>`;

const CHAPTER_URL = 'https://scan-test.io/manga/ao-no-hako/chapitre-109';

test('a real chapter page reads as ready', () => {
  const r = analyze(chapterPage(), CHAPTER_URL);
  assert.equal(r.verdict, 'ready');
  assert.equal(r.imageCount, 20);
  assert.ok(r.signals.includes('image-gallery'));
  assert.ok(r.signals.includes('chapter-nav'));
  assert.ok(r.signals.includes('url-pattern'));
  assert.equal(r.chapterLabel, 'Ch. 109');
  assert.equal(r.latestChapter, '110');
  assert.equal(r.coverUrl, 'https://scan-test.io/covers/ao-no-hako.jpg');
});

test('an article is not a chapter', () => {
  const html = `<html><head><title>Why Blue Box works</title></head><body>
    <img src="/img/logo.png"><p>${'word '.repeat(4000)}</p></body></html>`;
  const r = analyze(html, 'https://blog.test/posts/why-blue-box-works');
  assert.equal(r.verdict, 'unlikely');
  assert.equal(r.imageCount, 0);
});

test('a lazy-loading reader still counts its pages', () => {
  // The real src is a placeholder; the page URLs sit in data-src. Missing this
  // would report zero images on a large share of scan sites.
  const html = `<html><body>${Array.from({ length: 12 }, (_, i) =>
    `<img src="/assets/blank.gif" data-src="https://cdn.test/ch/${i}.jpg">`).join('')}
    <a href="/read/next-chapter">Next chapter</a></body></html>`;
  const r = analyze(html, 'https://lazy.test/read/series/chapter-5');
  assert.equal(r.imageCount, 12);
  assert.equal(r.verdict, 'ready');
});

test('sprites, logos and tracking pixels are not pages', () => {
  const imgs = pageImages(`
    <img src="/static/logo.png">
    <img src="/img/sprite-icons.png">
    <img src="/avatar/u12.jpg">
    <img src="https://t.test/pixel.gif">
    <img src="/ads/banner-728.png">
    <img src="https://cdn.test/ch/001.jpg">
  `, 'https://x.test/');
  assert.deepEqual(imgs, ['https://cdn.test/ch/001.jpg']);
});

test('a JS-built reader is unknown, never unlikely', () => {
  // No <img> in the markup at all — the pages arrive from a fetch. Scoring
  // alone would call this unsupported and steer the user away from a site that
  // works perfectly once loaded.
  const html = `<html><head><title>Series - Chapter 12</title></head><body>
    <div id="reader"></div>
    <script>window.__NEXT_DATA__={"pages":["a.jpg","b.jpg"]}</script></body></html>`;
  const r = analyze(html, 'https://spa.test/series/chapter-12');
  assert.equal(r.verdict, 'unknown');
  assert.ok(r.signals.includes('scripted-reader'));
  assert.match(r.reason, /JavaScript/);
});

test('a cover carousel on a home page does not pass as a chapter', () => {
  // Three big covers in one container is exactly what the score cannot tell
  // from a reading strip; the URL and the missing chapter nav are what settle
  // it, which is why "likely" and not "ready".
  const html = `<html><body><div class="carousel">
    <img src="https://cdn.test/covers/a.jpg">
    <img src="https://cdn.test/covers/b.jpg">
    <img src="https://cdn.test/covers/c.jpg">
  </div></body></html>`;
  const r = analyze(html, 'https://scan-test.io/');
  assert.equal(r.verdict, 'likely');
  assert.ok(!r.signals.includes('url-pattern'));
  assert.ok(!r.signals.includes('chapter-nav'));
});

test('a known domain carries the page on its own', () => {
  const html = '<html><body><p>nothing much</p></body></html>';
  const plain = analyze(html, 'https://known.test/x');
  const known = analyze(html, 'https://known.test/x', { domains: { 'known.test': { title: 'h1' } } });
  assert.equal(plain.knownDomain, false);
  assert.equal(known.knownDomain, true);
  assert.ok(known.score > plain.score);
  // Still no images, so it cannot claim the reader will open — only that the
  // page is one we have a rule for.
  assert.equal(known.verdict, 'likely');
});

test('chapterLabel matches what detect.js would report for the same URL', () => {
  assert.equal(chapterLabel('https://a.test/manga/x/chapitre-109'), 'Ch. 109');
  assert.equal(chapterLabel('https://a.test/Ao-no-Hako-Chapitre-109-FR_330666.html'), 'Ch. 109');
  assert.equal(chapterLabel('https://a.test/manga/x'), null);
  assert.equal(chapterLabel('https://a.test/x', 'Blue Box Chapter 12'), 'Ch. 12');
});

test('latestChapter reads the chapter list, not stray numbers', () => {
  const html = `<p>12345 views</p>
    <a href="/manga/x/chapter-3">Chapter 3</a>
    <a href="/manga/x/chapter-11">Chapter 11</a>`;
  assert.equal(latestChapter(html), '11');
  assert.equal(latestChapter('<p>nothing</p>'), null);
});

test('an empty or junk page never throws', () => {
  for (const [html, url] of [['', ''], [null, null], ['<<<', 'not a url']]) {
    const r = analyze(html, url);
    assert.equal(r.verdict, 'unlikely');
    assert.equal(r.imageCount, 0);
  }
});
