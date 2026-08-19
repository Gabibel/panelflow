// One typeface, shipped once, in the weights that were actually drawn.
//
// PanelFlow used to name a font stack in every stylesheet — `system-ui,
// -apple-system, "Segoe UI", …` written out four times, so the popup and the
// shelf were the same list of fallbacks only because nobody had edited one of
// them yet. R2 replaced the stacks with IBM Plex, vendored into shared/fonts
// and declared once in shared/theme.css.
//
// Shipping a font instead of borrowing the system's one buys a guarantee and
// costs a set of rules, and these are the rules:
//
//   - a stylesheet names a token, never a family or a file;
//   - every face declared is a file that exists, and every file shipped is a
//     face something declares — a typo in a url() is 60KB the browser fetches
//     as a 404 and 60KB in the .crx that nothing reads;
//   - `font-synthesis: none` is on :root, so a weight nobody drew is not
//     smeared into existence — it silently snaps to a weight that was. Only
//     400 and 600 were drawn, so only 400 and 600 may be asked for;
//   - the reader keeps the system stack. It is injected into a stranger's page
//     and cannot load a font without web_accessible_resources and a CSP fight
//     on every site PanelFlow supports, so it does not try.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const THEME = 'shared/theme.css';

// The same hand-written set theme.test.js guards, for the same reason: the
// copies under */shared are made by scripts/sync-shared.mjs.
const STYLESHEETS = [
  'web/styles.css',
  'extension/popup/popup.css',
  'extension/welcome/welcome.css',
  'mobile/www/app.css',
];
const INLINE = ['extension/options/options.html', 'extension/offline/offline.html'];

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const styleBlocks = (html) =>
  [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');

const sources = () => [
  ...STYLESHEETS.map((p) => [p, stripComments(read(p))]),
  ...INLINE.map((p) => [p, stripComments(styleBlocks(read(p)))]),
];

test('no stylesheet names a typeface except the one that owns them', () => {
  for (const [path, css] of sources()) {
    const named = [...css.matchAll(/@font-face|\.woff2?\b|IBM Plex|system-ui|-apple-system/g)]
      .map((m) => m[0]);
    assert.deepEqual(named, [], `${path} names ${named.join(', ')} itself. `
      + `Typefaces live in ${THEME}; this file should ask for --font-ui or --font-cond.`);
  }
});

/** Every `url("fonts/…")` shared/theme.css asks the browser to fetch. */
function declaredFiles() {
  return [...read(THEME).matchAll(/url\("fonts\/([^"]+)"\)/g)].map((m) => m[1]);
}

test('every face the theme declares is a file that ships, and the other way round', () => {
  const declared = declaredFiles();
  assert.ok(declared.length > 0, 'the theme declares no @font-face at all');

  const shipped = readdirSync(join(root, 'shared', 'fonts')).filter((f) => f.endsWith('.woff2'));
  assert.deepEqual([...declared].sort(), [...shipped].sort(),
    'shared/fonts and the @font-face rules in the theme disagree about what is shipped');

  // The licence is not a face, and it is not optional either: the SIL OFL asks
  // for its notice wherever the font goes, which includes inside the .crx.
  const all = readdirSync(join(root, 'shared', 'fonts'));
  assert.ok(all.includes('OFL.txt'), 'the fonts ship without their licence');
});

test('a weight is only asked for if it was drawn', () => {
  // What the @font-face rules actually provide.
  const theme = stripComments(read(THEME));
  const drawn = new Set(
    [...theme.matchAll(/@font-face\s*\{[^}]*?font-weight:\s*(\d+)/g)].map((m) => m[1]),
  );
  assert.deepEqual([...drawn].sort(), ['400', '600'],
    'the shipped weights have changed — this test and the stylesheets need to agree again');

  for (const [path, css] of sources()) {
    const asked = new Set([
      ...[...css.matchAll(/font-weight:\s*([^;}]+)/g)].map((m) => m[1].trim()),
      // `font: 600 11px/1 var(--font-ui)` — the weight slot of the shorthand.
      ...[...css.matchAll(/font:\s*(\d{3})\s/g)].map((m) => m[1]),
    ]);
    for (const w of asked) {
      assert.ok(drawn.has(w), `${path} asks for font-weight ${w}, which is not a weight `
        + `shared/fonts draws. font-synthesis is none, so it will not be faked — it will `
        + `quietly render as ${[...drawn].join(' or ')} instead. Say which.`);
    }
  }
});

test('nothing is faked, so nothing has to be un-faked later', () => {
  const theme = stripComments(read(THEME));
  assert.match(theme, /font-synthesis:\s*none/,
    'without this, a weight nobody drew is smeared out of the one next to it');
  assert.match(theme, /font-variant-numeric:\s*tabular-nums/,
    'chapter numbers and page counts sit in columns; proportional digits make them dance');
});

test('the reader keeps the system stack', () => {
  // Not an oversight — a constraint. reader.css is a content script in someone
  // else's document: it cannot @import, and a webfont would need
  // web_accessible_resources plus a CSP argument with every scan site.
  const css = read('extension/content/reader.css');
  assert.doesNotMatch(css, /@font-face|\.woff2?\b|IBM Plex/,
    'reader.css cannot load a font from inside a stranger\'s page');
  assert.match(css, /system-ui/, 'the reader has lost the stack it is meant to keep');
});

test('the fonts reach every client that links the theme', () => {
  // theme.css resolves url("fonts/…") against itself, so the fonts have to sit
  // beside every copy of it. scripts/sync-shared.mjs pairs the two; this is the
  // assertion that says why it has to.
  const declared = declaredFiles();
  for (const dir of ['extension/shared', 'web/shared', 'mobile/www/shared']) {
    const here = readdirSync(join(root, dir));
    assert.ok(here.includes('theme.css'), `${dir} has no theme.css`);
    const fonts = readdirSync(join(root, dir, 'fonts'));
    for (const f of declared) {
      assert.ok(fonts.includes(f), `${dir}/fonts is missing ${f} — run \`npm run sync:shared\``);
    }
  }
});
