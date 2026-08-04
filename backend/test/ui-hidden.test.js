// Every surface here hides things the same way: set the `hidden` attribute and
// let the browser's own `[hidden] { display: none }` do the rest. That rule is a
// bare attribute selector, so it loses to *any* class or id rule that sets
// `display` — and those are written all the time, for panels, sheets and views,
// which are exactly the elements that get toggled. The element then stays on
// screen with `hidden` set, and nothing in the JS looks wrong.
//
// It has already happened twice: the mobile entry sheet (`display: flex`) stayed
// up as a full-screen scrim that dimmed the app and swallowed every tap, and the
// web sign-in view had the same shape before a `!important` guard was added.
//
// The fix is one rule per stylesheet, so the next `display: flex` on a toggled
// element is safe without anyone remembering this. The test reads the HTML and
// its stylesheets as text and checks the rule is still there.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// The hand-written surfaces. `ios/Generated/www` and `extension/shared` are
// copies made by scripts/sync-shared.mjs and are covered by the sync test.
const PAGES = [
  'web/index.html',
  'mobile/www/index.html',
  'extension/popup/popup.html',
  'extension/options/options.html',
];

/** Every stylesheet that applies to a page: its <style> blocks and local <link>s. */
function stylesFor(page) {
  const html = read(page);
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
  for (const m of html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi)) {
    const href = m[0].match(/href=["']([^"']+)["']/i)?.[1];
    // A CDN would defeat the point of reading the file, but there are none here.
    if (!href || /^(https?:)?\/\//.test(href)) continue;
    css.push(readFileSync(resolve(join(root, dirname(page)), href), 'utf8'));
  }
  return css.join('\n');
}

test('every page that uses the hidden attribute enforces it in CSS', () => {
  for (const page of PAGES) {
    const html = read(page);
    // A page with nothing to hide needs no rule; all four currently hide things.
    if (!/\shidden(\s|>|=)/.test(html)) continue;

    const css = stylesFor(page);
    const guard = /(^|[\s,{}])\[hidden\]\s*\{[^}]*display\s*:\s*none\s*!important/m.test(css);
    assert.ok(guard, `${page}: no "[hidden] { display: none !important }" in its CSS. `
      + 'Without it a class rule setting display leaves hidden elements on screen.');
  }
});

test('no stylesheet works around the guard with a per-element hidden rule', () => {
  // Not style policing: a `.thing[hidden]` guard means someone hit the bug and
  // patched the one element they noticed, which reads as if the problem is
  // solved while every other toggled element in the file is still exposed.
  for (const page of PAGES) {
    const css = stylesFor(page);
    const patches = [...css.matchAll(/([#.][\w-]+)\[hidden\]/g)].map((m) => m[1]);
    assert.deepEqual(patches, [], `${page}: ${patches.join(', ')} guards itself against `
      + '[hidden]; the global rule already covers it.');
  }
});
