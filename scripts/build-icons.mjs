// Every icon the four surfaces ship, drawn from the one mark PanelFlow owns.
//
// Until this script, the phone's icon was the blueprint "A" that `create-expo-
// app` puts in every new project — Expo's artwork, MIT-licensed and nobody's
// brand — and the extension's was a flat purple square, a placeholder that
// stayed. Neither was PanelFlow's. The mark is: three panels of a page, the
// `#i-mark` symbol web/index.html draws in its header (`M3 4h18v16H3zM10 4v16
// M10 12h11`, stroked 2 units wide in a 24-unit box). This file draws that
// same geometry, at every size every platform asks for, in the palette's own
// two colours — ink and accent from shared/theme.css — and writes the PNGs.
//
// No dependency: the image is a byte array, the rasteriser is coverage
// sampling over rectangles (the mark is nothing but rectangles), and a PNG is
// a zlib stream with a CRC around it, which node:zlib and forty lines provide.
// Deterministic, so backend/test/icons.test.js can regenerate and compare —
// an icon edited by hand, or an Expo upgrade putting its placeholder back,
// fails the suite rather than shipping.
//
//   npm run build:icons
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- the palette, as numbers ---------------------------------------------------
// Copied rather than parsed out of the stylesheet: two colours, and the icons
// are not rebuilt when the theme is tuned — an app icon that changes shade
// between releases is a different app on the home screen. icons.test.js holds
// these to --dark-bg and --dark-accent anyway, so a deliberate change is one
// edit and a regeneration.
export const INK = [0x12, 0x10, 0x0f];      // --dark-bg
export const ACCENT = [0xe8, 0x61, 0x3c];   // --dark-accent
const WHITE = [0xff, 0xff, 0xff];

// --- the mark, as rectangles in its 24-unit box ---------------------------------
// The SVG path stroked 2 wide, written out as the bars it is. Corners are the
// overlap of two bars, which is what a mitre join draws.
const MARK = [
  [2, 3, 22, 5],    // top edge     (y = 4)
  [2, 19, 22, 21],  // bottom edge  (y = 20)
  [2, 3, 4, 21],    // left edge    (x = 3)
  [20, 3, 22, 21],  // right edge   (x = 21)
  [9, 3, 11, 21],   // the vertical gutter (x = 10)
  [9, 11, 22, 13],  // the horizontal gutter, right half (y = 12, x ≥ 10)
];

/**
 * Coverage of point (x, y) by the mark, with the box scaled to `span` pixels
 * and centred in `size`. 1 inside a bar, 0 outside; sampled 4×4 per pixel by
 * the caller, which is where the anti-aliasing comes from.
 */
function inMark(x, y, size, span) {
  const scale = span / 24;
  const off = (size - span) / 2;
  const u = (x - off) / scale;
  const v = (y - off) / scale;
  for (const [x0, y0, x1, y1] of MARK) {
    if (u >= x0 && u < x1 && v >= y0 && v < y1) return true;
  }
  return false;
}

/** Whether (x, y) is inside a square of `size` with corners rounded by `r`. */
function inRounded(x, y, size, r) {
  if (r <= 0) return true;
  const cx = x < r ? r : (x > size - r ? size - r : x);
  const cy = y < r ? r : (y > size - r ? size - r : y);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/**
 * One icon.
 *
 * @param {number} size    pixels, square
 * @param {object} o
 *   bg       background colour, or null for transparent
 *   fg       the mark's colour
 *   span     how many pixels of `size` the 24-unit box takes up
 *   radius   corner radius of the background, 0 for a full-bleed square
 *   mark     draw the mark at all (the Android background layer does not)
 * @returns {Buffer} a PNG
 */
export function icon(size, { bg, fg, span, radius = 0, mark = true }) {
  const SS = 4; // samples per axis per pixel
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgHits = 0;
      let fgHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS;
          const fy = y + (sy + 0.5) / SS;
          const onBg = bg && inRounded(fx, fy, size, radius);
          const onFg = mark && inMark(fx, fy, size, span) && (!bg || onBg);
          if (onFg) fgHits++;
          else if (onBg) bgHits++;
        }
      }
      const n = SS * SS;
      const a = (fgHits + bgHits) / n;
      const i = (y * size + x) * 4;
      if (a === 0) continue; // transparent, already zero
      // Composite the two colours by their coverage, then premultiply nothing:
      // PNG wants straight alpha, so the colour is the coverage-weighted mix
      // of the two and the alpha is the total coverage.
      for (let c = 0; c < 3; c++) {
        px[i + c] = Math.round(((fg[c] * fgHits) + ((bg || fg)[c] * bgHits)) / (fgHits + bgHits));
      }
      px[i + 3] = Math.round(a * 255);
    }
  }
  return png(size, size, px);
}

// --- PNG, by hand ----------------------------------------------------------------

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** RGBA pixels to a PNG file: 8-bit, colour type 6, no filtering. */
export function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  // Each scanline is prefixed with its filter byte; 0 is "none".
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- what gets written, and why each looks the way it does ---------------------

/**
 * Every file, with the recipe for it. Exported so the test can regenerate
 * exactly this list and compare.
 */
export const ICONS = [
  // iOS wants an opaque, full-bleed square: it rounds the corners itself and
  // paints transparent ones black. 1024 is the one size App Store Connect
  // takes; Expo derives the rest.
  ['native/assets/icon.png', 1024, { bg: INK, fg: ACCENT, span: 620 }],
  // Android's adaptive icon is two layers the launcher masks and parallaxes.
  // The foreground keeps the mark inside the inner two thirds — the safe zone
  // — so a circular mask does not clip the corners of the page.
  ['native/assets/android-icon-foreground.png', 1024, { bg: null, fg: ACCENT, span: 440 }],
  ['native/assets/android-icon-background.png', 1024, { bg: INK, fg: INK, span: 0, mark: false }],
  // The monochrome layer is a silhouette the launcher tints; white on nothing.
  ['native/assets/android-icon-monochrome.png', 1024, { bg: null, fg: WHITE, span: 440 }],
  // The splash icon sits on the splash colour; the mark alone.
  ['native/assets/splash-icon.png', 512, { bg: null, fg: ACCENT, span: 300 }],
  ['native/assets/favicon.png', 48, { bg: INK, fg: ACCENT, span: 30, radius: 8 }],
  // The extension: Chrome shows these unmasked, so the corners are ours.
  ['extension/icons/icon16.png', 16, { bg: INK, fg: ACCENT, span: 12, radius: 3 }],
  ['extension/icons/icon48.png', 48, { bg: INK, fg: ACCENT, span: 32, radius: 8 }],
  ['extension/icons/icon128.png', 128, { bg: INK, fg: ACCENT, span: 84, radius: 22 }],
  // The Kotlin shell's launcher, one per density. Legacy square icons, which
  // every launcher still accepts; the same rounded look as the extension's.
  ...[['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]].map(([d, s]) => [
    `android/app/src/main/res/mipmap-${d}/ic_launcher.png`, s,
    { bg: INK, fg: ACCENT, span: Math.round(s * 0.66), radius: Math.round(s * 0.17) },
  ]),
];

/** Render every icon. Returns [path, bytes] pairs; writes nothing. */
export const render = () => ICONS.map(([path, size, opts]) => [path, icon(size, opts)]);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [path, bytes] of render()) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
    console.log(`wrote ${path} (${bytes.length} bytes)`);
  }
}
