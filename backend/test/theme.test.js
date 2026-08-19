// One palette, in one file, and no way back.
//
// Before shared/theme.css there were four palettes: the web app on a cool
// indigo, the popup and the welcome page and the phone shell on a warm stone
// ramp with identical token names, and the reader on forty-odd hex literals
// borrowed from both. Nothing was wrong with any of them on its own. What was
// wrong is that they had already drifted — the same green was #6fdc8c on one
// surface and #6cc08b on another, in two files copied from each other — and
// nothing in the repo could say so.
//
// A colour written in a stylesheet is how that starts again, so this test says
// where colours may be written: shared/theme.css, and the reader's two token
// blocks, which cannot link it. Everything else names a token.
//
// The reader is the interesting case. It is injected into a stranger's page, so
// it may not touch `:root` and cannot @import; the values are therefore
// repeated on `#panelflow-reader` itself. Repetition is fine when it is
// checked, which is what the last test here does — the reader's --pf-* set has
// to equal theme.css's --dark-* set exactly, and its light override the
// --light-* set.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const THEME = 'shared/theme.css';

// Hand-written only. extension/shared, web/shared and mobile/www/shared are
// copies made by scripts/sync-shared.mjs and are covered by the sync test.
const STYLESHEETS = [
  'web/styles.css',
  'extension/popup/popup.css',
  'extension/welcome/welcome.css',
  'mobile/www/app.css',
];

// Pages that carry their palette in a <style> block instead of a file. They are
// small enough that a stylesheet of their own would be ceremony, which is
// exactly why they were the last two still on the old indigo.
const INLINE = ['extension/options/options.html', 'extension/offline/offline.html'];

/** CSS with its comments removed, so a hex named in prose is not a violation. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const styleBlocks = (html) =>
  [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');

// #abc, #aabbcc, #aabbccdd, rgb(…), rgba(…), hsl(…), hsla(…). Not `transparent`
// or `currentColor`, which name no value and cannot drift.
const LITERAL = /#[0-9a-fA-F]{3,8}\b(?![\w-])|\b(?:rgba?|hsla?)\s*\(/g;

test('no stylesheet writes a colour except the one that owns them', () => {
  const sources = [
    ...STYLESHEETS.map((p) => [p, read(p)]),
    ...INLINE.map((p) => [p, styleBlocks(read(p))]),
  ];
  for (const [path, css] of sources) {
    const found = [...stripComments(css).matchAll(LITERAL)].map((m) => m[0]);
    assert.deepEqual(found, [], `${path} writes ${found.join(', ')} itself. `
      + `Colours live in ${THEME}; this file should name a token, or ask for a new one.`);
  }
});

test('the reader writes colours only where it declares its own tokens', () => {
  // It has no choice about declaring them; it has a choice about using a
  // literal for a shadow or a border further down, which is how the drift this
  // file exists to stop would start again in the one file least able to notice.
  const css = stripComments(read('extension/content/reader.css'));
  const body = css.replace(/#panelflow-reader\.pf-follow-system\s*\{[^}]*\}/g, '')
    .replace(/#panelflow-pill,\s*\n#panelflow-reader\s*\{[^}]*\}/g, '');
  const found = [...body.matchAll(LITERAL)].map((m) => m[0]);
  assert.deepEqual(found, [], `reader.css writes ${found.join(', ')} outside its token blocks.`);
});

test('the two dark blocks in the theme say exactly the same thing', () => {
  // CSS cannot put a media query and an attribute selector in one rule, so
  // "the system says dark" and "you said dark" are two blocks with one body.
  // Editing one and not the other gives a theme that is right until someone
  // picks it by hand — a bug nobody hits while developing, because the
  // developer's system is already dark.
  const css = read(THEME);
  const media = css.match(/@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\)\s*\{([\s\S]*?)\n  \}/);
  const attr = css.match(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.ok(media && attr, 'one of the two dark blocks is no longer where this test looks');
  const normalise = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  assert.equal(normalise(media[1]), normalise(attr[1]),
    'the two dark blocks have drifted apart');
});

/** `--name: value;` pairs declared inside `css`. */
function tokens(css) {
  return Object.fromEntries(
    [...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]),
  );
}

test('the reader repeats the theme rather than reinventing it', () => {
  const theme = tokens(stripComments(read(THEME)));
  const reader = stripComments(read('extension/content/reader.css'));

  const dark = tokens(reader.match(/#panelflow-pill,\s*\n#panelflow-reader\s*\{([^}]*)\}/)[1]);
  const light = tokens(reader.match(/#panelflow-reader\.pf-follow-system\s*\{([^}]*)\}/)[1]);

  // Dark is the reader's default and declares the whole set; the light override
  // only redeclares what changes, so --pf-unread appears once and on purpose.
  assert.equal(dark['--pf-unread'], theme['--unread'],
    'the reader disagrees with the shelf about what "unread" looks like');
  assert.ok(!('--pf-unread' in light),
    '"unread" is information, not atmosphere — it may not change with the theme');

  for (const [name, value] of Object.entries(dark)) {
    if (name === '--pf-unread') continue;
    const key = name.replace('--pf-', '--dark-');
    assert.equal(value, theme[key], `reader.css ${name} is ${value}, ${THEME} ${key} is ${theme[key]}`);
  }
  for (const [name, value] of Object.entries(light)) {
    const key = name.replace('--pf-', '--light-');
    assert.equal(value, theme[key], `reader.css light ${name} is ${value}, ${THEME} ${key} is ${theme[key]}`);
  }
  // Not asserted the other way round: the theme has --danger, --ok and --warn
  // and the reader has nothing to say with them — no failed save, no sync
  // state, nothing expiring. Forcing it to declare tokens it never reads would
  // be four more values to keep in step for no colour on any screen. The loops
  // above already fail on a value that has moved, which is the drift that hurts.
});
