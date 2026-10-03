// A scan site that does not exist, served from here.
//
// The audit asked for an end-to-end run of the extension in a real browser on
// "a corpus of synthetic pages, then real ones". These are the synthetic ones:
// the shapes the detector and the reader are built for, written small and
// served by a plain http server so the test controls every byte and no real
// site is hit. Each page is a case: a manga chapter with a strip of images, a
// series index that is not a chapter, a prose chapter, and a chapter that
// carries the ad hijack the popup guard exists for.
//
// The images are real PNGs (one pixel each, drawn here) because the reader
// looks at what an <img> loaded, not at what the markup promised.
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A video that plays: 130 seconds of four colours, 64×48, VP8 at one frame a
 * second (32 KB). An episode counts after two minutes of real playback, so a
 * test that watches one needs something that lasts that long; at 4× it is
 * over in half a minute.
 */
const EPISODE_VIDEO = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'media', 'episode.webm'));

/**
 * A 720×1080 PNG of one flat colour: a page, at a page's size. The detector
 * refuses images under 400×200 (shared/detection-rules.json, minImageWidth),
 * because that is how it tells a strip of scans from a row of thumbnails, so
 * the synthetic pages have to be as big as real ones. Flat colour compresses
 * to almost nothing, whatever the size.
 */
export function png(shade, w = 720, h = 1080) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      raw[i] = shade; raw[i + 1] = shade; raw[i + 2] = shade;
    }
  }
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const page = (title, body) => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>${title}</title></head><body>${body}</body></html>`;

/** The pages, by path. */
export const PAGES = {
  // A chapter as the Themesia-style sites lay one out: a title with a chapter
  // number, a strip of images in a reader area, links to the neighbours.
  '/manga/blue-box/chapter-9/': page('Blue Box Chapter 9 - Scan VF', `
    <h1 class="entry-title">Blue Box Chapter 9</h1>
    <div class="chapter-nav"><a href="/manga/blue-box/chapter-8/">Chapitre précédent</a>
      <a href="/manga/blue-box/">Blue Box</a>
      <a href="/manga/blue-box/chapter-10/">Chapitre suivant</a></div>
    <div id="readerarea">${Array.from({ length: 12 }, (_, i) => `<img src="/img/p${i + 1}.png" alt="">`).join('\n')}</div>
    <div class="chapter-nav"><a href="/manga/blue-box/chapter-8/">Chapitre précédent</a>
      <a href="/manga/blue-box/chapter-10/">Chapitre suivant</a></div>`),
  '/manga/blue-box/chapter-10/': page('Blue Box Chapter 10 - Scan VF', `
    <h1 class="entry-title">Blue Box Chapter 10</h1>
    <div id="readerarea">${Array.from({ length: 10 }, (_, i) => `<img src="/img/p${i + 1}.png" alt="">`).join('\n')}</div>
    <a href="/manga/blue-box/chapter-9/">Chapitre précédent</a>`),
  // The series page: a cover and a list of chapters. Not a chapter, and the
  // detector must say so; a pill here would be a pill on every index page.
  '/manga/blue-box/': page('Blue Box - Scan VF', `
    <h1 class="entry-title">Blue Box</h1>
    <img class="cover" src="/img/cover.png" alt="Blue Box">
    <p>Une comédie romantique sportive.</p>
    <ul class="chapters">${Array.from({ length: 12 }, (_, i) => `<li><a href="/manga/blue-box/chapter-${12 - i}/">Chapter ${12 - i}</a></li>`).join('')}</ul>`),
  // A chapter whose page carries the hijack: the first click anywhere opens an
  // advertiser, and the "next" link swaps its address under the finger.
  '/manga/hijacked/chapter-1/': page('Hijacked Chapter 1 - Scan VF', `
    <h1 class="entry-title">Hijacked Chapter 1</h1>
    <div id="readerarea">${Array.from({ length: 8 }, (_, i) => `<img src="/img/p${i + 1}.png" alt="">`).join('\n')}</div>
    <a id="next" href="/manga/hijacked/chapter-2/">Chapitre suivant</a>
    <script>
      document.addEventListener('click', function () { window.open('https://ad.example/land', '_blank'); }, true);
      document.getElementById('next').addEventListener('pointerdown', function (e) { e.currentTarget.href = 'https://ad.example/swap'; });
    </script>`),
  '/manga/hijacked/chapter-2/': page('Hijacked Chapter 2', '<h1>Chapter 2</h1><div id="readerarea"><img src="/img/p1.png" alt=""></div>'),
};

// Chapters 11 and 12 of the same series, for a reader who keeps going: the
// long-run test walks the series from 9 to 12 over several sittings.
for (const n of [11, 12]) {
  PAGES[`/manga/blue-box/chapter-${n}/`] = page(`Blue Box Chapter ${n} - Scan VF`, `
    <h1 class="entry-title">Blue Box Chapter ${n}</h1>
    <div id="readerarea">${Array.from({ length: 8 }, (_, i) => `<img src="/img/p${i + 1}.png" alt="">`).join('\n')}</div>
    <a href="/manga/blue-box/chapter-${n - 1}/">Chapitre précédent</a>
    ${n < 12 ? `<a href="/manga/blue-box/chapter-${n + 1}/">Chapitre suivant</a>` : ''}`);
}
PAGES['/manga/blue-box/chapter-10/'] = page('Blue Box Chapter 10 - Scan VF', `
    <h1 class="entry-title">Blue Box Chapter 10</h1>
    <div id="readerarea">${Array.from({ length: 10 }, (_, i) => `<img src="/img/p${i + 1}.png" alt="">`).join('\n')}</div>
    <a href="/manga/blue-box/chapter-9/">Chapitre précédent</a>
    <a href="/manga/blue-box/chapter-11/">Chapitre suivant</a>`);

// --- the other shapes a reader meets, one site each -------------------------
//
// Each is a domain the manifest names, reduced to the markup the detector and
// the reader read on the real one (opened on 21 September 2026), so the
// long-run test can put one user through every reader the extension has.

const SPACER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * scan-vf: one page laid out, the whole chapter parked in a hidden container
 * as <img data-src> (with the spaces the site leaves around the address), a
 * <select> of page numbers whose values are numbers, covers of other series
 * below. Seventeen pages, and not one of them should have to be fetched.
 */
const scanVf = (chapter, pages) => page(`Scan One Piece Chapitre ${chapter} : En plein entraînement - Page 1 sur ScanVF.Net`, `
    <h1>One Piece Chapitre ${chapter}</h1>
    <a href="/one_piece/chapitre-${chapter - 1}">Chapitre précédent</a>
    <a href="/one_piece/chapitre-${chapter + 1}">Chapitre suivant</a>
    <select id="page-list">${Array.from({ length: pages }, (_, i) => `<option value="${i + 1}">${i + 1}</option>`).join('')}</select>
    <a href="/one_piece/chapitre-${chapter}/2"><img class="img-responsive scan-page" src="/uploads/manga/one_piece/chapters/chapitre-${chapter}/01.png" alt="Page 1"></a>
    <div id="all" style="display:none">${Array.from({ length: pages }, (_, i) =>
      `<img class="img-responsive" src="${SPACER}" data-src=" /uploads/manga/one_piece/chapters/chapitre-${chapter}/${String(i + 1).padStart(2, '0')}.png " alt="Page ${i + 1}">`).join('\n')}</div>
    <div class="related">${['kingdom', 'naruto', 'bleach'].map((s) => `<a href="/${s}"><img src="/uploads/manga/${s}/cover/cover_250x350.png" width="250" height="350"></a>`).join('')}</div>`);

/**
 * mangago: one page per address, no picture in the markup at all. The site's
 * own script puts the panel in once the page runs (from an encrypted string
 * on the real one; from a timer here), with the next page preloaded and
 * hidden beside it. A "next >" link and total_pages=12 say the rest.
 */
const mangago = (n, total) => page(`Borderline Ch.1 Page ${n} - Mangago`, `
    <h1>Borderline Ch.1</h1>
    <a href="/read-manga/borderline/uu/br_chapter-2/pg-1/">Ch.2 : Next time</a>
    ${n < total ? `<a class="next_page" href="/read-manga/borderline/uu/br_chapter-1/pg-${n + 1}/">next &gt;</a>` : ''}
    <a id="pic_container" href="/read-manga/borderline/uu/br_chapter-1/pg-${Math.min(n + 1, total)}/"></a>
    <img src="/img/arrow-40x40.png" alt="">
    <script>var pcurl = "/read-manga/borderline/uu/br_chapter-1/pg-${n}/",current_page=${n},total_pages=${total},manga_name="Borderline",chapter_name="Ch.1";
      var imgsrcs = 'VbcEgSFU24/e314OiB/msU0x+xjwNyi579A3wePvDFy9WsNI0JrE';</script>
    <script>
      setTimeout(function () {
        var a = document.getElementById('pic_container');
        var i = document.createElement('img'); i.id = 'page${n}'; i.src = '/r/newpiclink/borderline/1/${n}.png'; a.appendChild(i);
        ${n < total ? `var p = document.createElement('img'); p.id = 'page${n + 1}'; p.style.display = 'none'; p.src = '/r/newpiclink/borderline/1/${n + 1}.png'; a.appendChild(p);` : ''}
      }, 300);
    </script>`);

/** A light novel chapter: a heading, prev/next, fourteen long paragraphs. */
const LINE = 'Arthur Leywin had been the strongest of his world, and none of it had followed him into this one. ';
const novel = (n) => page(`The Beginning After the End - Chapter ${n} - Read Novel Full`, `
    <h1>The Beginning After the End</h1>
    <h2>Chapter ${n}: A new life</h2>
    <a href="/b/the-beginning-after-the-end/chapter-${n - 1}">Prev chapter</a>
    <a href="/b/the-beginning-after-the-end/chapter-${n + 1}">Next chapter</a>
    <div id="chr-content">${Array.from({ length: 14 }, (_, i) => `<p>${LINE.repeat(2)}(${n}.${i + 1})</p>`).join('\n')}</div>`);

/**
 * An anime episode: the page names the episode and holds the player in a
 * frame from a listed host, as voiranime embeds sibnet. The port is the
 * fixture server's, known only once it listens.
 */
const episode = (n, port) => page(`One Piece Saison 1 Épisode ${n} VOSTFR - voiranime`, `
    <h1>One Piece Saison 1 Épisode ${n}</h1>
    <a href="/one-piece/saison-1/episode-${n - 1}/">Épisode précédent</a>
    <a href="/one-piece/saison-1/episode-${n + 1}/">Épisode suivant</a>
    <iframe src="http://sibnet.ru:${port}/shell/videos/${100 + n}" width="800" height="450" allowfullscreen></iframe>`);

const player = () => page('Sibnet', '<video controls width="800" height="450" src="/media/none.mp4"></video>');

/**
 * lelscans: the series' landing page shows its latest chapter, one panel of
 * it, and "Pages: 1 2 … 13", each a link to one page of that chapter. Nothing
 * in the address or in prev/next says "chapter"; the chapter list, a <select>
 * of full addresses with the latest selected, says which chapter this is.
 */
const lelscans = (port) => page('One Piece lecture en ligne scan', `
    <h2><a href="/lecture-en-ligne-one-piece">Lecture en ligne One Piece</a> &gt;
      <a href="http://lelscans.net:${port}/scan-one-piece/1194" class="lien-chapitre">1194</a></h2>
    <select>${[1194, 1193, 1192, 1191].map((n, i) =>
      `<option value="http://lelscans.net:${port}/scan-one-piece/${n}"${i ? '' : ' selected'}>${n}</option>`).join('')}</select>
    <div id="navigation"><strong>Pages:</strong> <a href="/scan-one-piece/1194/1">Prec</a>${
      Array.from({ length: 13 }, (_, i) => `<a href="/scan-one-piece/1194/${i + 1}">${i + 1}</a>`).join('')
    }<a href="/scan-one-piece/1194/2">Suiv</a></div>
    <div id="image"><a href="/scan-one-piece/1194/2"><img src="/mangas/one-piece/1194/00.png" alt="One Piece 1194 page 1"></a></div>`);

const lelscansPage = (n) => page('One Piece lecture en ligne scan',
  `<div id="image"><img src="/mangas/one-piece/1194/${String(n - 1).padStart(2, '0')}.png" alt=""></div>`);

/**
 * webnovel: every paragraph in its own two <div>s, each with a comment bubble
 * beside it, so no two paragraphs share a parent. Short lines of dialogue
 * among the long ones: they are part of the chapter.
 */
const WEBNOVEL_LINE = 'Un jeune homme à l’apparence frêle était assis sur un banc rouillé en face du commissariat. ';
const webnovel = () => page('Le Cauchemar Commence - Esclave de l’Ombre - WebNovel', `
    <h2 class="lh1">Esclave de l’Ombre</h2>
    <div class="cha-tit"><h1>Chapitre 1: Le Cauchemar Commence</h1></div>
    <div class="cha-content"><div class="cha-words">${Array.from({ length: 14 }, (_, i) => `
      <div class="cha-paragraph"><div class="dib pr"><p>${i === 3 ? '« Ah ! Quelle amertume ! »' : WEBNOVEL_LINE.repeat(2) + `(${i + 1})`}</p><i class="para-comment">${i}</i></div></div>`).join('')}
    </div></div>`);

/**
 * Crunchyroll: one page for the whole visit. The player, and the data that
 * name the episode, arrive after the page has loaded; the next episode is
 * reached without loading a page (history.pushState), and the data are
 * rewritten in place. Nothing in the title says which series this is.
 */
const CRUNCHY_SERIES = 'https://www.crunchyroll.com/fr/series/GYZJ43JMR/that-time-i-got-reincarnated-as-a-slime';
const crunchyLd = (n) => JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'TVEpisode',
  name: `Saison 4 | E${n} - Episode title`,
  episodeNumber: n,
  partOfSeason: { '@type': 'TVSeason', name: 'Saison 4', seasonNumber: 4 },
  partOfSeries: { '@type': 'TVSeries', '@id': CRUNCHY_SERIES, name: 'Moi, quand je me réincarne en Slime' },
}).replace(/</g, '\\u003c');
const crunchyroll = (n) => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Saison 4 Episode title - Regardez sur Crunchyroll</title>
<meta property="og:title" content="Saison 4 | E${n} - Episode title"></head>
<body style="margin:0;background:#000;color:#fff;font:14px sans-serif">
<header id="site-header" style="height:60px;background:#222">Crunchyroll · Nouveau · Populaire · Simulcast</header>
<div id="app"></div>
<a id="next" href="/fr/watch/GE0000000${n + 1}/next">Épisode suivant</a>
<script>
  setTimeout(() => {
    const ld = document.createElement('script');
    ld.type = 'application/ld+json';
    ld.id = 'ld';
    ld.textContent = ${JSON.stringify(crunchyLd(n))};
    document.head.appendChild(ld);
    document.getElementById('app').innerHTML = '<div style="padding-top:20px"><video id="player0" width="960" height="540" style="display:block;margin-left:120px;background:#111"></video></div><h1>E${n} - Episode title</h1>';
  }, 800);
  document.getElementById('next').addEventListener('click', (e) => {
    e.preventDefault();
    history.pushState({}, '', e.currentTarget.getAttribute('href'));
    document.getElementById('ld').textContent = ${JSON.stringify(crunchyLd(n + 1))};
    document.querySelector('meta[property="og:title"]').content = 'Saison 4 | E${n + 1} - Episode title';
    document.querySelector('h1').textContent = 'E${n + 1} - Episode title';
  });
</script></body></html>`;

/**
 * Another series on the same platform, built whole at load: what the popup's
 * "Add" (and the phone's) reads, through the detector rather than the bar.
 */
const crunchyOther = () => `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<title>Saison 2 Episode title - Regardez sur Crunchyroll</title>
<meta property="og:title" content="Saison 2 | E3 - Episode title">
<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'TVEpisode',
  episodeNumber: 3,
  partOfSeason: { '@type': 'TVSeason', name: 'Saison 2', seasonNumber: 2 },
  partOfSeries: { '@type': 'TVSeries', '@id': 'https://www.crunchyroll.com/fr/series/GG5H5XQX4/dan-da-dan', name: 'Dandadan' },
})}</script></head>
<body style="margin:0"><header style="height:60px">Crunchyroll</header>
<video width="960" height="540" style="display:block"></video><h1>E3 - Episode title</h1></body></html>`;

/** Its home page: a trailer playing, and no episode anywhere. */
const crunchyHome = () => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Crunchyroll</title></head>
<body style="margin:0"><header style="height:60px">Crunchyroll</header>
<video width="960" height="540" style="display:block"></video></body></html>`;

/**
 * A streaming site with one address per season and language, the episode in a
 * picker, and the player in a frame from another host.
 */
const seasonPage = (slug, name, season) => (port) => page(
  `${name} - Saison ${season} | Anime-Sama - Streaming et catalogage d'animes et scans.`, `
    <h3 id="titreOeuvre">${name}</h3><h2 id="avOeuvre">Saison ${season}</h2>
    <select id="selectEpisodes"><option>Episode 1</option><option>Episode 2</option><option>Episode 3</option></select>
    <iframe src="http://vidmoly.to:${port}/embed-${slug}-${season}.html" width="800" height="450" allowfullscreen></iframe>`);

/**
 * A season page where the next episode comes without leaving the page: the
 * picker moves and the player's frame gets a new address, and no `change`
 * is fired, which is how the site's own "next episode" button does it.
 */
const pickerSeason = (port) => page(
  'Code Geass - Saison 1 | Anime-Sama - Streaming et catalogage d\'animes et scans.', `
    <h3 id="titreOeuvre">Code Geass</h3><h2 id="avOeuvre">Saison 1</h2>
    <select id="selectEpisodes">${[1, 2, 3].map((n) => `<option>Episode ${n}</option>`).join('')}</select>
    <button id="nextEpisode" type="button">Épisode suivant</button>
    <iframe id="player" src="http://vidmoly.to:${port}/embed-code-geass.html?ep=1" width="800" height="450" allowfullscreen></iframe>
    <script>
      document.getElementById('nextEpisode').addEventListener('click', () => {
        const sel = document.getElementById('selectEpisodes');
        sel.selectedIndex = Math.min(sel.selectedIndex + 1, sel.options.length - 1);
        document.getElementById('player').src = 'http://vidmoly.to:${port}/embed-code-geass.html?ep=' + (sel.selectedIndex + 1);
      });
    </script>`);

/** A player whose video really plays. */
const playable = () => page('Vidmoly', '<video muted playsinline width="800" height="450" src="/media/episode.webm"></video>');

/** The pages by host, then by path. A value may be a function of the port. */
export const SITES = {
  'mangakakalot.gg': PAGES,
  'scan-vf.net': {
    '/one_piece/chapitre-1193': scanVf(1193, 17),
    '/one_piece/chapitre-1194': scanVf(1194, 9),
  },
  'mangago.me': Object.fromEntries(Array.from({ length: 12 }, (_, i) =>
    [`/read-manga/borderline/uu/br_chapter-1/pg-${i + 1}/`, mangago(i + 1, 12)])),
  'readnovelfull.com': {
    '/b/the-beginning-after-the-end/chapter-3': novel(3),
    '/b/the-beginning-after-the-end/chapter-4': novel(4),
  },
  'voiranime.rip': {
    '/one-piece/saison-1/episode-3/': (port) => episode(3, port),
    '/one-piece/saison-1/episode-4/': (port) => episode(4, port),
  },
  'sibnet.ru': {
    '/shell/videos/103': player(),
    '/shell/videos/104': player(),
  },
  'lelscans.net': {
    '/lecture-ligne-one-piece': lelscans,
    ...Object.fromEntries(Array.from({ length: 13 }, (_, i) =>
      [`/scan-one-piece/1194/${i + 1}`, lelscansPage(i + 1)])),
  },
  'www.crunchyroll.com': {
    '/fr/watch/GE00000001/first': crunchyroll(1),
    '/fr/watch/GE00000002/next': crunchyroll(2),
    '/fr/watch/GF00000003/dandadan': crunchyOther(),
    '/fr/': crunchyHome(),
  },
  'anime-sama.to': {
    '/catalogue/cyberpunk-edgerunners/saison1/vostfr/': seasonPage('cyberpunk-edgerunners', 'Cyberpunk : Edgerunners', 1),
    '/catalogue/frieren/saison1/vostfr/': seasonPage('frieren', 'Frieren', 1),
    '/catalogue/frieren/saison2/vostfr/': seasonPage('frieren', 'Frieren', 2),
    '/catalogue/code-geass/saison1/vostfr/': pickerSeason,
  },
  'vidmoly.to': {
    ...Object.fromEntries(['cyberpunk-edgerunners-1', 'frieren-1', 'frieren-2']
      .map((slug) => [`/embed-${slug}.html`, player()])),
    '/embed-code-geass.html': playable(),
  },
  'www.webnovel.com': {
    '/book/esclave-de-l-ombre_27567489800660005/le-cauchemar-commence_74026366915371780': webnovel(),
  },
};

/** Every host above, for Chromium's host resolver. */
export const HOSTS = Object.keys(SITES);

/** Serve the pages and the pictures. Resolves with the port. */
export function serve() {
  const shades = new Map();
  // Every request, as `host + path`, for a test to count: "the chapter opened
  // without one page being fetched" is a claim about this list.
  const hits = [];
  let port = 0;
  const server = createServer((req, res) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    const path = req.url.split('?')[0];
    hits.push(host + path);
    if (/\.png$/.test(path)) {
      // A picture at the size its name asks for: a page unless the name says
      // otherwise (cover_250x350, arrow-40x40). The detector refuses anything
      // under 400 wide as a page, so covers and arrows stay small.
      const small = /(\d+)x(\d+)\.png$/.exec(path);
      const w = small ? Number(small[1]) : 720;
      const h = small ? Number(small[2]) : 1080;
      if (!shades.has(path)) shades.set(path, png(40 + (shades.size * 17) % 180, w, h));
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(shades.get(path));
    }
    if (path === '/media/episode.webm') {
      // Ranges, as a media server answers them: Chromium asks for one.
      const range = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range || ''));
      if (!range) {
        res.writeHead(200, { 'Content-Type': 'video/webm', 'Content-Length': EPISODE_VIDEO.length, 'Accept-Ranges': 'bytes' });
        return res.end(EPISODE_VIDEO);
      }
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), EPISODE_VIDEO.length - 1) : EPISODE_VIDEO.length - 1;
      res.writeHead(206, {
        'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${EPISODE_VIDEO.length}`, 'Content-Length': end - start + 1,
      });
      return res.end(EPISODE_VIDEO.subarray(start, end + 1));
    }
    if (path.startsWith('/media/')) { res.writeHead(404); return res.end(''); }
    const site = SITES[host] || PAGES;
    const entry = site[path];
    const html = typeof entry === 'function' ? entry(port) : entry;
    if (!html) { res.writeHead(404); return res.end('not here'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    port = server.address().port;
    resolve({ server, port, hits });
  }));
}
