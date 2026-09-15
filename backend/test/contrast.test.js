// Every pairing of text and ground in the palette clears WCAG AA.
//
// The palette in shared/theme.css is the only place a colour is written for
// four surfaces, which makes it the one place a contrast failure can be caught
// for all of them at once. This test computes the ratio — the real formula,
// relative luminance over sRGB — for every colour the stylesheets use *as text*
// against every surface it can sit on, and holds each to 4.5:1, the AA bar for
// text at the sizes these apps use. Nothing here reads a screen; it reads the
// numbers the screens are drawn from.
//
// What it found when it was written, and what it now prevents coming back:
//   * white on the dark accent — every primary button in the dark theme — was
//     3.4:1. Readable by people with good eyes in a dark room, and by nobody
//     else. `--on-accent` is now per theme: ink on the bright accent, white on
//     the dark one.
//   * the "unread" amber as text on the light background was 2.0:1. It was one
//     value for both themes on the argument that information does not change
//     colour with the room — true, and it made the information unreadable.
//   * the light accent, warn and ok colours as text on the raised light
//     surface were 3.8–4.1:1; each was darkened by the least amount that clears
//     the bar on every light surface.
//
// The muted colour is held to the same bar rather than the 3:1 that "large or
// incidental" text gets: it is the colour of every hint, every chapter label
// and every date in the app, none of which is large.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const css = readFileSync(join(root, 'shared', 'theme.css'), 'utf8');

/** `--name: #hex;` out of the stylesheet, or a failure that names the token. */
function token(name) {
  const m = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`));
  assert.ok(m, `--${name} is not a hex colour in shared/theme.css`);
  return m[1];
}

/** Relative luminance, per WCAG 2.x. */
function luminance(hex) {
  const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(hex.slice(1 + i, 3 + i), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two colours, 1 to 21. */
export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;

// The colours the stylesheets set as `color:` on ordinary text, and the
// surfaces `background:` puts under them. Every combination is a pairing that
// exists somewhere — a status word on a card, a hint on the raised sheet, an
// "unread" count on the page background.
const INKS = ['text', 'muted', 'accent', 'danger', 'ok', 'warn', 'unread'];
const GROUNDS = ['bg', 'surface', 'surface-hi'];

for (const theme of ['dark', 'light']) {
  test(`${theme}: every ink clears 4.5:1 on every ground`, () => {
    const failures = [];
    for (const ink of INKS) {
      for (const ground of GROUNDS) {
        const ratio = contrast(token(`${theme}-${ink}`), token(`${theme}-${ground}`));
        if (ratio < AA) failures.push(`--${theme}-${ink} on --${theme}-${ground}: ${ratio.toFixed(2)}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test(`${theme}: the text on a primary button can be read`, () => {
    // `--on-accent` is the ink every solid button, active tab and "on" chip
    // uses over `--accent`. This is the pairing that was 3.4:1 in the dark.
    const ratio = contrast(token(`${theme}-on-accent`), token(`${theme}-accent`));
    assert.ok(ratio >= AA, `--${theme}-on-accent on --${theme}-accent is ${ratio.toFixed(2)}`);
  });

  test(`${theme}: the ink on an "unread" badge can be read`, () => {
    // The phone's badge and the web's chip draw the count in the theme's own
    // background colour on top of --unread (LibraryScreen.js, styles.css).
    const ratio = contrast(token(`${theme}-bg`), token(`${theme}-unread`));
    assert.ok(ratio >= AA, `--${theme}-bg on --${theme}-unread is ${ratio.toFixed(2)}`);
  });
}

test('the formula is the standard one', () => {
  // Two anchors from the specification itself, so a slip in the arithmetic
  // above cannot pass every palette by being wrong in the lenient direction.
  assert.equal(contrast('#ffffff', '#000000').toFixed(0), '21');
  assert.equal(contrast('#777777', '#ffffff').toFixed(2), '4.48'); // the classic near-miss
});
