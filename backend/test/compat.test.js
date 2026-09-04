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

test('the flat permalink scores like the nested one', () => {
  // `/serie-chapitre-883/` is what Madara and Themesia produce out of the box,
  // and it is what sushiscan.fr serves. The pattern used to require a slash
  // immediately before the word, so the single most common chapter URL in the
  // niche scored zero on the URL signal — invisible on a known domain, which
  // clears the threshold on its own, and decisive on a site nobody has listed.
  for (const url of ['https://scan-test.io/kingdom-chapitre-883/',
    'https://scan-test.io/one-piece-chapter-1100/',
    'https://scan-test.io/blue-box_ch-109/',
    'https://scan-test.io/naruto-episode-12/']) {
    assert.ok(analyze(chapterPage(), url).signals.includes('url-pattern'), url);
  }
  // The slashed forms still work, and a page about something else still does not.
  assert.ok(analyze(chapterPage(), CHAPTER_URL).signals.includes('url-pattern'));
  for (const url of ['https://blog.test/posts/why-blue-box-works',
    'https://scan-test.io/recherche/kingdom']) {
    assert.ok(!analyze(chapterPage(), url).signals.includes('url-pattern'), url);
  }
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

// --- text chapters ---------------------------------------------------------
// The reader takes web novels, so "no images" cannot mean "no". A novel scores
// zero by construction — every weight is an image signal — which is exactly the
// case the file's asymmetry was written for.

/** A web-novel chapter: prose in <p>s, prev/next links, a chapter URL. */
const novelPage = (paras = 14) => `
<html><head><title>Reverend Insanity - Chapter 812</title></head><body>
  <a href="/novel/ri/chapter-811">Previous Chapter</a>
  <a href="/novel/ri/chapter-813">Next Chapter</a>
  <div id="chapter-content">
    ${Array.from({ length: paras }, (_, i) =>
      `<p>The mountain did not move, and that was answer enough for him. He counted `
      + `the steps back to the gate, because counting was the only thing left that `
      + `obeyed. (${i + 1})</p>`).join('\n')}
  </div>
</body></html>`;

test('a web-novel chapter is ready, not unlikely', () => {
  const r = analyze(novelPage(), 'https://novels.test/novel/ri/chapter-812');
  assert.equal(r.verdict, 'ready');
  assert.equal(r.imageCount, 0);
  assert.ok(r.signals.includes('text-chapter'));
  assert.match(r.reason, /text chapter/);
  assert.equal(r.chapterLabel, 'Ch. 812');
});

test('a <br>-separated chapter body counts too', () => {
  // What the older novel sites do: one block, no <p> anywhere in it.
  const line = 'She said nothing, which he had learned to read as the longest sentence she owned.';
  const html = `<html><head><title>Chapter 40</title></head><body>
    <a href="/read/x/chapter-41">Next chapter</a>
    <div class="chapter-c">${Array.from({ length: 20 }, (_, i) => `${line} (${i})`).join('<br><br>')}</div>
  </body></html>`;
  const r = analyze(html, 'https://old.test/read/x/chapter-40');
  assert.equal(r.verdict, 'ready');
  assert.ok(r.signals.includes('text-chapter'));
});

test('a long article is still not a chapter, however much prose it has', () => {
  // Same body, minus the two things an article never has: a chapter number in
  // the URL and real prev/next chapter links. The title says "Chapter 3", which
  // is a normal thing for a blog post to be called and must not be enough.
  const html = novelPage()
    .replace(/<a[^>]*>[^<]*<\/a>/g, '')
    .replace('Reverend Insanity - Chapter 812', 'Chapter 3: rebuilding billing');
  const r = analyze(html, 'https://blog.test/posts/rebuilding-billing');
  assert.equal(r.verdict, 'unlikely');
  assert.ok(!r.signals.includes('text-chapter'));
});

test('a chapter list is not prose, however long it is', () => {
  // Every line is a link, which is what separates a table of contents from a
  // chapter — and the page it sits on has both a chapter URL and chapter nav.
  const html = `<html><head><title>Reverend Insanity</title></head><body>
    <a href="/novel/ri/chapter-1">Chapter 1: the first of many very long titles indeed</a>
    ${Array.from({ length: 40 }, (_, i) =>
      `<a href="/novel/ri/chapter-${i + 2}">Chapter ${i + 2}: another chapter with a long descriptive title</a>`).join('\n')}
    <a href="/novel/ri/chapter-2">Next chapter</a>
  </body></html>`;
  const r = analyze(html, 'https://novels.test/novel/ri/chapter-1');
  assert.ok(!r.signals.includes('text-chapter'));
  assert.notEqual(r.verdict, 'ready');
});

test('a short chapter page is not claimed on a paragraph or two', () => {
  const r = analyze(novelPage(2), 'https://novels.test/novel/ri/chapter-812');
  assert.ok(!r.signals.includes('text-chapter'));
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
  const known = analyze(html, 'https://known.test/x',
    { rules: { domains: { 'known.test': { title: 'h1' } } } });
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

// --- les deux copies du même barème -----------------------------------------

test('le barème du serveur est celui que le fichier de règles distribue', async () => {
  // `shared/compat.js` fige ses poids et son seuil, et son propre en-tête dit
  // qu'ils sont « délibérément les mêmes » que ceux de
  // `shared/detection-rules.json`. Personne ne le vérifiait.
  //
  // Le doublon est voulu et doit le rester : compat.js est une fonction pure
  // qui doit répondre sans qu'aucun fichier de règles soit chargé. Ce qui
  // manquait est le garde-fou. Régler `scoreThreshold` dans le fichier de
  // règles est une opération supportée, qui atteint tous les clients en six
  // heures sans release — et le contrôle de compatibilité côté serveur
  // (`/api/search?check=1`, `/api/meta/compat`) continuerait, lui, à juger
  // avec 50. Le symptôme : « l'app dit que ce site n'est pas supporté alors
  // que le lecteur marche dessus », sans rien pour remonter à la cause.
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { WEIGHTS, THRESHOLD, MIN_GALLERY_IMAGES } = await import('../src/compat.js');

  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const shipped = JSON.parse(readFileSync(join(root, 'shared', 'detection-rules.json'), 'utf8'));
  const h = shipped.heuristics;

  assert.equal(THRESHOLD, h.scoreThreshold,
    'le seuil du serveur a divergé de celui que les clients reçoivent');
  assert.equal(MIN_GALLERY_IMAGES, h.minGalleryImages,
    'le nombre minimum de panneaux a divergé');
  assert.deepEqual(WEIGHTS, h.weights,
    'les poids du serveur ont divergé de ceux du fichier de règles');
});
