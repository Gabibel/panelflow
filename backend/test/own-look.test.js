// PanelFlow's own look, kept its own (owner's request, October 2026: check the
// interface is not too close to another reading app's, keeping every feature).
//
// A design review compared PanelFlow with the competitor's public material on
// 12/10/2026 and found four places where PanelFlow had taken its expression
// rather than an idea: the popup's reader setting worded and drawn the same
// way, orange on the same warm black, the same five English folder names in
// the same order, and the same grey / orange / half-orange legend. Each was
// redrawn without removing anything. This file holds the redrawn version, so
// none of the four drifts back one innocent edit at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const messages = (lang) => JSON.parse(read('shared', '_locales', lang, 'messages.json'));

// --- colour distance, CIEDE2000 ----------------------------------------------

const srgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));

function lab(hex) {
  const [r, g, b] = srgb(hex);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
  const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
  const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIEDE2000 between two CIELAB colours. */
function de00([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const ap1 = (1 + G) * a1; const ap2 = (1 + G) * a2;
  const C1 = Math.hypot(ap1, b1); const C2 = Math.hypot(ap2, b2);
  const hue = (y, x) => (x === 0 && y === 0 ? 0 : ((Math.atan2(y, x) / rad) + 360) % 360);
  const h1 = hue(b1, ap1); const h2 = hue(b2, ap2);
  let dh = h2 - h1;
  if (C1 * C2 === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dL = L2 - L1; const dC = C2 - C1;
  const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * rad);
  const Lm = (L1 + L2) / 2; const Cm = (C1 + C2) / 2;
  let hm = h1 + h2;
  if (C1 * C2 !== 0) hm = Math.abs(h1 - h2) > 180 ? (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2 : (h1 + h2) / 2;
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad)
    + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const Rc = 2 * Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7));
  const Rt = -Math.sin(2 * 30 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad) * Rc;
  const Sl = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2);
  const Sc = 1 + 0.045 * Cm; const Sh = 1 + 0.015 * Cm * T;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

/** ΔE00 between two hex colours: under 1 nobody sees it, past 20 nobody misses it. */
const deltaE = (a, b) => de00(lab(a), lab(b));

test('the colour distance is the standard one', () => {
  // Pairs 1, 7 and 17 of Sharma, Wu and Dalal's CIEDE2000 test data, with the
  // differences they publish, so a slip in the formula cannot pass every
  // palette by being wrong in the lenient direction.
  assert.equal(de00([50, 2.6772, -79.7751], [50, 0, -82.7485]).toFixed(4), '2.0425');
  assert.equal(de00([50, 0, 0], [50, -1, 2]).toFixed(4), '2.3669');
  assert.equal(de00([50, 2.5, 0], [73, 25, -18]).toFixed(4), '27.1492');
  assert.ok(Math.abs(deltaE('#12100f', '#13110f') - 0.6) < 0.2, 'the review measured 0.6 between these blacks');
});

// The competitor's orange as its store screenshots show it, its icon and its
// site: the three values the review measured.
const THEIR_ORANGES = ['#fe733b', '#ff7d4a', '#ff8656'];

test('the accent is nowhere near the orange family, in either theme', () => {
  const css = read('shared', 'theme.css');
  for (const theme of ['dark', 'light']) {
    const accent = css.match(new RegExp(`--${theme}-accent:\\s*(#[0-9a-f]{6});`, 'i'))[1];
    for (const orange of THEIR_ORANGES) {
      const d = deltaE(accent, orange);
      assert.ok(d > 30, `--${theme}-accent ${accent} is ${d.toFixed(1)} from ${orange}`);
    }
    // And it is no longer one step from the red that means "remove".
    const danger = css.match(new RegExp(`--${theme}-danger:\\s*(#[0-9a-f]{6});`, 'i'))[1];
    assert.ok(deltaE(accent, danger) > 30, `--${theme}-accent reads as --${theme}-danger`);
  }
});

test('the popup asks when the reader opens in its own words, as a choice and not a switch', () => {
  const html = read('extension', 'popup', 'popup.html');
  const js = read('extension', 'popup', 'popup.js');
  assert.match(html, /data-group="opening"/);
  assert.match(html, /id="default-autoshow" role="radiogroup"/);
  assert.match(html, /role="radio" data-value="on"[\s\S]*?data-i18n="popupOpenReaderAuto"/);
  assert.match(html, /role="radio" data-value="off"[\s\S]*?data-i18n="popupOpenReaderAsk"/);
  // The site in the open tab is one line under the general answer, not a
  // second group headed by its name with the same setting in it again.
  assert.match(html, /<select id="site-autoshow">\s*<option value="default" data-i18n="popupSiteFollow">/);
  assert.doesNotMatch(html, /data-group="site"|class="switcher"/);
  // Same storage as before: nothing a reader chose is lost to the redesign.
  assert.match(js, /chrome\.storage\.local\.set\(\{ autoShowDefault: value === 'on' \}\)/);
  assert.match(js, /if \(e\.target\.value === 'default'\) delete sites\[state\.host\];/);
  assert.match(js, /chrome\.storage\.local\.set\(\{ autoShowSites: sites \}\)/);
  for (const lang of ['en', 'fr']) {
    const m = messages(lang);
    for (const gone of ['popupGroupDefaults', 'popupAutoShowReader', 'switchOn', 'switchOff', 'switchDefault']) {
      assert.ok(!(gone in m), `${lang}: ${gone} is back`);
    }
  }
  assert.equal(messages('en').popupHideReader.message, 'Close the reader');
});

test('the folders read as PanelFlow\'s, in English as in French', () => {
  const folders = read('shared', 'folders.js');
  const ids = [...folders.match(/const BUILTIN = \[([\s\S]*?)\];/)[1].matchAll(/id: '([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(ids, ['reading', 'plan', 'paused', 'completed', 'dropped']);
  assert.equal(messages('en').folder_plan.message, 'Plan to read');
  // The sheet a content script draws has its own copy of the order.
  assert.match(read('extension', 'content', 'library-modal.js'),
    /const FOLDERS = \['reading', 'plan', 'paused', 'completed', 'dropped'\];/);
});

test('read, part-way and unread are three shapes, not three shades of a dot', () => {
  for (const css of [read('web', 'styles.css'), read('extension', 'popup', 'popup.css')]) {
    assert.doesNotMatch(css, /linear-gradient\(90deg, var\(--unread\) 50%, var\(--muted\) 50%\)/,
      'the half-and-half dot is back');
    assert.match(css, /is-reading [^{]*\{[^}]*conic-gradient\(var\(--accent\) calc\(var\(--done, 0\) \* 1turn\)/,
      'part-way is not a ring filled to the pages read');
    assert.match(css, /is-read [^{]*\{[^}]*border-width: 0 [\d.]+px [\d.]+px 0;[^}]*rotate\(45deg\)/,
      'caught up is not a check');
  }
  assert.match(read('extension', 'content', 'reader.css'), /\.pf-wrow\.pf-read::before \{ content: '\\2713/);
});

test('chapters kept for reading without network are "Offline", not "Downloads"', () => {
  assert.equal(messages('en').navSaved.message, 'Offline');
  assert.equal(messages('fr').navSaved.message, 'Hors ligne');
  for (const lang of ['en', 'fr']) {
    for (const key of ['mobileSavedLede', 'mobileSavedEmpty']) {
      assert.doesNotMatch(messages(lang)[key].message, /download|téléchargement/i, `${lang}: ${key}`);
    }
  }
  // The tab's picture is not the download arrow either.
  assert.doesNotMatch(read('scripts', 'build-icons.mjs'), /saved: 'M12 4v10M7\.5 9\.5L12 14l4\.5-4\.5M5 19\.5h14'/);
});

test('the pill and the website say it their own way', () => {
  const en = messages('en'); const fr = messages('fr');
  assert.equal(en.pillReaderMode.message, 'Read in PanelFlow');
  assert.equal(fr.pillReaderMode.message, 'Lire dans PanelFlow');
  assert.doesNotMatch(en.webTagline.message, /^Your manga/);
  // The App Store text opens on the reading mode, not on "a browser".
  const listing = read('docs', 'store-listing.md');
  assert.doesNotMatch(listing, /a browser made for reading|navigateur pensé pour la lecture/);
  // And Apple is told the truth about what the app keeps.
  assert.doesNotMatch(listing, /No content is downloaded or kept on the\s*>?\s*device/);
});
