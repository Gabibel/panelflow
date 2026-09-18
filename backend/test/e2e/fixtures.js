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

/**
 * A 720×1080 PNG of one flat colour: a page, at a page's size. The detector
 * refuses images under 400×200 (shared/detection-rules.json, minImageWidth),
 * because that is how it tells a strip of scans from a row of thumbnails, so
 * the synthetic pages have to be as big as real ones. Flat colour compresses
 * to almost nothing, whatever the size.
 */
export function png(shade) {
  const w = 720;
  const h = 1080;
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

/** Serve the pages and the pictures. Resolves with the port. */
export function serve() {
  const shades = new Map();
  const server = createServer((req, res) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/img/')) {
      if (!shades.has(path)) shades.set(path, png(40 + (shades.size * 17) % 180));
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(shades.get(path));
    }
    const html = PAGES[path];
    if (!html) { res.writeHead(404); return res.end('not here'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
