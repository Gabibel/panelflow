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
export const INK = [0x00, 0x00, 0x00];      // --dark-bg
export const ACCENT = [0x3f, 0xb0, 0xc9];   // --dark-accent
// The light theme's pair, for the one picture drawn on paper: the image a
// shared link shows (see ICONS, web/og-image.png).
export const PAPER = [0xf7, 0xf4, 0xec];    // --light-bg
export const INK_BLUE = [0x1d, 0x6a, 0x85]; // --light-accent
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

/**
 * A wide picture: the mark, `span` pixels across, centred on a plain `bg`.
 * Drawn as the square icon would be, in a square the height of the picture
 * standing in its middle; everything either side of it is background.
 */
export function banner(width, height, { bg, fg, span }) {
  const SS = 4;
  const px = Buffer.alloc(width * height * 4);
  const left = (width - height) / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let fgHits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inMark(x - left + (sx + 0.5) / SS, y + (sy + 0.5) / SS, height, span)) fgHits++;
        }
      }
      const i = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round((fg[c] * fgHits + bg[c] * (SS * SS - fgHits)) / (SS * SS));
      px[i + 3] = 255;
    }
  }
  return png(width, height, px);
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

// --- the phone app's interface icons ------------------------------------------------
//
// Lines on the grid the reader's and the popup's icons use: a 24-unit box,
// strokes 1.8 wide with round ends and joins, written as SVG path data so they
// read like the icons they sit beside. Drawn here rather than by a browser for
// the reason this file exists: every raster the surfaces ship comes out of
// geometry in this repository, byte for byte the same on every run
// (icons.test.js regenerates them and compares). White on nothing — the app
// tints each one with the theme (native/src/components/Icon.js).
export const GLYPHS = {
  // The shelf: three spines, the last one leaning.
  library: 'M4.5 4h3.5v16H4.5zM10 4h3.5v16H10zM15.6 5.3l3.3-.9 3.6 14.9-3.3.9z',
  // What was read, by when.
  history: 'M12 7.5V12l3 2M20.5 12a8.5 8.5 0 11-17 0 8.5 8.5 0 0117 0z',
  // The sites a library comes from.
  sites: 'M20.5 12a8.5 8.5 0 11-17 0 8.5 8.5 0 0117 0zM3.5 12h17M12 3.5c2.3 2.4 3.5 5.3 3.5 8.5s-1.2 6.1-3.5 8.5c-2.3-2.4-3.5-5.3-3.5-8.5S9.7 5.9 12 3.5z',
  search: 'M10.5 17.5a7 7 0 100-14 7 7 0 000 14zM20 20l-4.5-4.5',
  // Settings as sliders: a cog is the machine's; these are the reader's.
  settings: 'M4 6h9M17 6h3M17 6a2 2 0 11-4 0 2 2 0 014 0zM4 12h3M11 12h9M11 12a2 2 0 11-4 0 2 2 0 014 0zM4 18h10M18 18h2M18 18a2 2 0 11-4 0 2 2 0 014 0z',
  // More about this one: the sheet behind a card.
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  // Empty shelves and first launch.
  book: 'M12 6.5c-2.2-1.6-5-2.3-8-2v13c3-.3 5.8.4 8 2 2.2-1.6 5-2.3 8-2v-13c-3-.3-5.8.4-8 2zM12 6.5v13',
  bookmark: 'M7 4h10v16l-5-3.5L7 20z',
  bell: 'M6 9a6 6 0 1112 0c0 5 2 6 2 6H4s2-1 2-6M10 20a2 2 0 004 0',
  link: 'M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  close: 'M6 6l12 12M18 6L6 18',
  // Chapters kept to read with no network: the cloud, struck through. Not a
  // download arrow — the tab is about reading offline, not about fetching.
  saved: 'M9 6.2A5.5 5.5 0 0117.5 11.5a3.5 3.5 0 011 6.8M15.5 18.5H7.5a4.2 4.2 0 01-1.4-8.2M4 4l16 16',
  // AniList's three-face grade (POINT_3): a score, drawn, not an emoji whose
  // look is the phone maker's. Same face, the mouth is the grade.
  sad: 'M20.5 12a8.5 8.5 0 11-17 0 8.5 8.5 0 0117 0zM9 8.8v1.6M15 8.8v1.6M8.5 16.5c2-2.2 5-2.2 7 0',
  meh: 'M20.5 12a8.5 8.5 0 11-17 0 8.5 8.5 0 0117 0zM9 8.8v1.6M15 8.8v1.6M8.5 15h7',
  happy: 'M20.5 12a8.5 8.5 0 11-17 0 8.5 8.5 0 0117 0zM9 8.8v1.6M15 8.8v1.6M8.5 14c2 2.6 5 2.6 7 0',
  // The account, at the end of the bar (dark redesign, October 2026).
  account: 'M16 8a4 4 0 11-8 0 4 4 0 018 0zM4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5',
  // Adding a series: the middle of the bar.
  plus: 'M12 5v14M5 12h14',
};

// The dots of "more" are drawn heavier, or they vanish at 24 points.
const GLYPH_WIDTH = { more: 3.2 };

/**
 * SVG path data to line segments: M L H V C S A Z, absolute and relative —
 * what the glyphs above use. Curves and arcs are cut into short straight
 * pieces, which at these sizes nobody can tell from the curve.
 */
export function pathSegments(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
  const segs = [];
  let i = 0;
  let cmd = null;
  let x = 0; let y = 0; let sx = 0; let sy = 0;   // pen, and where the subpath began
  let cx2 = null; let cy2 = null;                 // last cubic control, for S
  const num = () => parseFloat(tokens[i++]);
  // A flag is one character, and the compact form runs them together ("11-17").
  const flag = () => {
    const tok = tokens[i];
    if (tok.length > 1 && (tok[0] === '0' || tok[0] === '1') && tok[1] !== '.') {
      tokens[i] = tok.slice(1);
      return tok[0] === '1';
    }
    i++;
    return tok === '1';
  };
  const line = (nx, ny) => { segs.push([x, y, nx, ny]); x = nx; y = ny; };
  const cubic = (x1, y1, x2, y2, nx, ny) => {
    const [x0, y0] = [x, y];
    const N = 24;
    for (let k = 1; k <= N; k++) {
      const t = k / N; const u = 1 - t;
      line(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * nx,
        u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ny);
    }
    cx2 = x2; cy2 = y2;
  };
  // The endpoint form of an arc to its centre form (SVG 1.1, appendix F.6.5).
  const arc = (rx, ry, rot, large, sweep, nx, ny) => {
    const [x1, y1] = [x, y];
    if (rx === 0 || ry === 0) return line(nx, ny);
    const phi = (rot * Math.PI) / 180;
    const cos = Math.cos(phi); const sin = Math.sin(phi);
    const dx = (x1 - nx) / 2; const dy = (y1 - ny) / 2;
    const xp = cos * dx + sin * dy; const yp = -sin * dx + cos * dy;
    rx = Math.abs(rx); ry = Math.abs(ry);
    const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
    if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
    const num2 = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
    const den = rx * rx * yp * yp + ry * ry * xp * xp;
    const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den));
    const cxp = (coef * rx * yp) / ry; const cyp = (-coef * ry * xp) / rx;
    const cx = cos * cxp - sin * cyp + (x1 + nx) / 2;
    const cy = sin * cxp + cos * cyp + (y1 + ny) / 2;
    const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
    let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const N = Math.max(8, Math.ceil(Math.abs(dt) / (Math.PI / 24)));
    for (let k = 1; k <= N; k++) {
      const t = t1 + (dt * k) / N;
      if (k === N) line(nx, ny);
      else line(cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos);
    }
  };
  while (i < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0; const oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M': {
        x = num() + ox; y = num() + oy; sx = x; sy = y;
        // Further pairs after a moveto are linetos.
        cmd = rel ? 'l' : 'L';
        cx2 = null;
        break;
      }
      case 'L': line(num() + ox, num() + oy); cx2 = null; break;
      case 'H': line(num() + ox, y); cx2 = null; break;
      case 'V': line(x, num() + oy); cx2 = null; break;
      case 'C': cubic(num() + ox, num() + oy, num() + ox, num() + oy, num() + ox, num() + oy); break;
      case 'S': {
        const x1 = cx2 === null ? x : 2 * x - cx2;
        const y1 = cy2 === null ? y : 2 * y - cy2;
        cubic(x1, y1, num() + ox, num() + oy, num() + ox, num() + oy);
        break;
      }
      case 'A': {
        const rx = num(); const ry = num(); const rot = num();
        const large = flag(); const sweep = flag();
        arc(rx, ry, rot, large, sweep, num() + ox, num() + oy);
        cx2 = null;
        break;
      }
      case 'Z': line(sx, sy); cx2 = null; cmd = null; break;
      default: throw new Error(`path command ${cmd} is not drawn here`);
    }
    if (cmd === null && i < tokens.length && !/[a-zA-Z]/.test(tokens[i])) {
      throw new Error('numbers after Z');
    }
  }
  return segs;
}

/** Distance from (px, py) to the segment (x0, y0)–(x1, y1), squared. */
function dist2(px, py, x0, y0, x1, y1) {
  const vx = x1 - x0; const vy = y1 - y0;
  const len = vx * vx + vy * vy;
  let t = len ? ((px - x0) * vx + (py - y0) * vy) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = px - (x0 + t * vx); const ey = py - (y0 + t * vy);
  return ex * ex + ey * ey;
}

/**
 * One interface icon: white, its alpha the share of each pixel the stroke
 * covers. A stroke with round ends and joins is exactly the set of points
 * within half its width of the path, which is what is measured here, 4×4
 * samples a pixel.
 */
export function glyph(size, name) {
  const segs = pathSegments(GLYPHS[name]);
  const half = (GLYPH_WIDTH[name] ?? 1.8) / 2;
  const scale = size / 24;
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  // Each segment's box, widened by the half-width, so a pixel only measures
  // the pieces that could reach it.
  const boxes = segs.map(([x0, y0, x1, y1]) => [
    Math.min(x0, x1) - half, Math.min(y0, y1) - half, Math.max(x0, x1) + half, Math.max(y0, y1) + half,
  ]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const near = [];
      const ux0 = x / scale; const uy0 = y / scale; const ux1 = (x + 1) / scale; const uy1 = (y + 1) / scale;
      for (let k = 0; k < segs.length; k++) {
        const b = boxes[k];
        if (b[0] <= ux1 && b[2] >= ux0 && b[1] <= uy1 && b[3] >= uy0) near.push(segs[k]);
      }
      if (!near.length) continue;
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / scale;
          const v = (y + (sy + 0.5) / SS) / scale;
          for (const [x0, y0, x1, y1] of near) {
            if (dist2(u, v, x0, y0, x1, y1) <= half * half) { hits++; break; }
          }
        }
      }
      if (!hits) continue;
      const i = (y * size + x) * 4;
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
      px[i + 3] = Math.round((hits / (SS * SS)) * 255);
    }
  }
  return png(size, size, px);
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
  // The phone app's interface icons (native/src/components/Icon.js), at the
  // three scales iOS asks for; white on nothing, tinted by the app.
  ...Object.keys(GLYPHS).flatMap((name) => [['', 24], ['@2x', 48], ['@3x', 72]].map(([suffix, px]) => [
    `native/assets/icons/${name}${suffix}.png`, px, { glyph: name },
  ])),
  // The two drawn large, for the welcome and the empty history (EmptyState in
  // native/src/ui.js, 34 points): a 24-point drawing stretched to 34 was a
  // blur (QA re-test It.5).
  ...['book', 'history'].flatMap((name) => [['', 40], ['@2x', 80], ['@3x', 120]].map(([suffix, px]) => [
    `native/assets/icons/${name}-large${suffix}.png`, px, { glyph: name },
  ])),
  // The website. The tab's icon, rounded like the extension's; /favicon.ico
  // answers with it too, for whatever never reads the page's <link>.
  ['web/icons/favicon-32.png', 32, { bg: INK, fg: ACCENT, span: 22, radius: 6 }],
  // What an iPhone puts on the home screen for "Add to Home Screen": opaque
  // and square, like the app icon, because iOS rounds the corners itself.
  ['web/icons/apple-touch-icon.png', 180, { bg: INK, fg: ACCENT, span: 110 }],
  // The web manifest's (web/manifest.webmanifest): the two sizes Chrome asks
  // for, and a maskable one for Android, full bleed with the mark well inside
  // the circle a launcher may cut it to.
  ['web/icons/icon-192.png', 192, { bg: INK, fg: ACCENT, span: 126, radius: 32 }],
  ['web/icons/icon-512.png', 512, { bg: INK, fg: ACCENT, span: 336, radius: 86 }],
  ['web/icons/maskable-512.png', 512, { bg: INK, fg: ACCENT, span: 256 }],
  // The picture a link to the site shows when it is shared (Open Graph, 1200
  // by 630). On paper, the theme the store pages are drawn in rather than the
  // dark one (docs/store-listing.md), the mark in the light theme's ink-blue.
  ['web/og-image.png', [1200, 630], { banner: true, bg: PAPER, fg: INK_BLUE, span: 320 }],
];

/** Render every icon. Returns [path, bytes] pairs; writes nothing. */
export const render = () => ICONS.map(([path, size, opts]) => [
  path, opts.banner ? banner(size[0], size[1], opts) : opts.glyph ? glyph(size, opts.glyph) : icon(size, opts),
]);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [path, bytes] of render()) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
    console.log(`wrote ${path} (${bytes.length} bytes)`);
  }
}
