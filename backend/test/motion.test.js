// Movement, and the promise that it can be switched off.
//
// The redesign lists ten animations and no more (redesign.md §6). The list is
// short on purpose, and the things left off it — card lift, shimmering
// skeletons, staggered grid entrances, parallax, page-curl, spring physics — are
// left off because each one is a page telling you it is busy. A test cannot
// stop someone adding an eleventh, but it can stop the excluded ones coming
// back, and it can hold the one rule that has an accessibility setting behind
// it: a stylesheet that moves something must say what it does when the reader
// has asked the system for less motion.
//
// "Reduce" is a request about movement, not a request to be told less. So the
// second half of this file checks the other direction — that no reduced-motion
// block hides anything, collapses anything, or zeroes an opacity that was one.
// A reader who turns motion down and loses a toast, a status chip or a whole
// panel has been given a worse application, not a calmer one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

/** Every stylesheet this repository ships, found rather than listed. */
function stylesheets(dir = root, out = []) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      // node_modules is not ours; ios/Generated is a build output, byte for
      // byte a copy of extension/content/reader.css (ios/Scripts/bundle-assets.sh)
      // and git-ignored, so testing it would be testing `cp`.
      if (['node_modules', '.git', 'ios', 'android', 'coverage'].includes(item.name)) continue;
      stylesheets(full, out);
    } else if (item.name.endsWith('.css')) {
      out.push(relative(root, full).split(sep).join('/'));
    }
  }
  return out;
}

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** A sheet split into what it declares normally and what it declares under reduce. */
function sheet(path) {
  const css = stripComments(read(path));
  const at = css.indexOf('@media (prefers-reduced-motion: reduce)');
  if (at === -1) return { path, css, normal: css, reduced: '' };
  // The block runs to its matching brace, counting depth: it contains rules of
  // its own, so the first `}` is never the end of it.
  let depth = 0;
  let end = at;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) { end = i + 1; break; }
  }
  return { path, css, normal: css.slice(0, at) + css.slice(end), reduced: css.slice(at, end) };
}

const SHEETS = stylesheets();
const moves = (block) => /(^|[\s;{])(transition|animation)(-[a-z]+)?\s*:/m.test(block);

// --- the rule with a setting behind it --------------------------------------

test('the sweep finds the stylesheets it is supposed to be sweeping', () => {
  // A list that quietly matched nothing would make every test below vacuous.
  assert.ok(SHEETS.length >= 6, `only found ${SHEETS.length} stylesheets`);
  for (const expected of [
    'extension/content/reader.css', 'extension/popup/popup.css',
    'extension/welcome/welcome.css', 'web/styles.css', 'shared/theme.css',
    'mobile/www/app.css',
  ]) {
    assert.ok(SHEETS.includes(expected), `${expected} is not in the sweep`);
  }
});

test('every stylesheet that moves something says what it does under reduce', () => {
  const moving = SHEETS.filter((p) => moves(sheet(p).normal));
  assert.ok(moving.length >= 4, 'nothing in this repository animates, which cannot be right');
  for (const path of moving) {
    assert.ok(sheet(path).reduced,
      `${path} declares motion and no @media (prefers-reduced-motion: reduce) block`);
  }
});

test('no reduced-motion block takes anything away', () => {
  for (const path of SHEETS) {
    const { reduced } = sheet(path);
    if (!reduced) continue;
    for (const [pattern, why] of [
      [/display\s*:\s*none/, 'hides an element outright'],
      [/visibility\s*:\s*hidden/, 'makes an element invisible'],
      [/\bcontent\s*:\s*none/, 'drops generated content'],
      [/opacity\s*:\s*0\b(?!\.)/, 'holds something at zero opacity'],
      [/max-height\s*:\s*0/, 'collapses something to nothing'],
    ]) {
      assert.doesNotMatch(reduced, pattern,
        `${path}: the reduced-motion block ${why} — reduce means less movement, not less information`);
    }
  }
});

test('every animation names a set of keyframes the same sheet defines', () => {
  // A typo in an animation name is silence: no error, no movement, nothing to
  // notice until someone looks for the animation that was supposed to be there.
  for (const path of SHEETS) {
    const { css } = sheet(path);
    const defined = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));
    const used = new Set([
      ...[...css.matchAll(/animation-name\s*:\s*([\w-]+)/g)].map((m) => m[1]),
      ...[...css.matchAll(/animation\s*:\s*([\w-]+)/g)].map((m) => m[1]),
    ].filter((n) => !['none', 'inherit', 'initial', 'unset'].includes(n)));
    for (const name of used) {
      assert.ok(defined.has(name), `${path} runs @keyframes ${name}, which nothing defines`);
    }
  }
});

// --- the ten, where they are supposed to be ---------------------------------

test('the reader keeps its four movements and adds the fifth', () => {
  const { normal, reduced } = sheet('extension/content/reader.css');
  // 1, 6, 7, 9 existed; 10 is the end-of-chapter panel.
  assert.match(normal, /\.pf-chrome \{[^}]*transition: transform \.2s ease, opacity \.2s ease/);
  assert.match(normal, /\.pf-progress-fill \{[^}]*transition: width \.12s linear/);
  assert.match(normal, /\.pf-wrow \{[^}]*transition: color \.12s ease/);
  assert.match(normal, /\.pf-toast \{[^}]*transition: opacity \.2s ease/);
  assert.match(normal, /\.pf-end \{[^}]*transition: opacity \.16s ease, transform \.16s ease/);

  // Under reduce the chrome fades and does not slide (§6, animation 1), and
  // the panel fades and does not rise (animation 10). Both keep their fade,
  // because in a reader with the controls hidden the fade is the only signal
  // that anything happened at all.
  assert.match(reduced, /\.pf-chrome \{ transition: opacity \.2s ease; \}/);
  assert.doesNotMatch(reduced.match(/\.pf-chrome \{[^}]*\}/)[0], /transform/,
    'the chrome still animates a translate for a reader who asked it not to');
  assert.match(reduced, /\.pf-end \{[^}]*transform: translate\(-50%, 0\)/);
  assert.match(reduced, /\.pf-end \{[^}]*transition: opacity \.16s ease/);
});

test('the reader never animates a page turn', () => {
  // Deliberately discarded (§6): a 200 ms slide on every page is felt as
  // latency by anyone reading quickly. It may come back as a setting that is
  // off by default; it may not come back as a stylesheet rule.
  const { css } = sheet('extension/content/reader.css');
  const stage = css.match(/#panelflow-reader \.pf-zoomwrap \{[^}]*\}/)?.[0] ?? '';
  assert.doesNotMatch(stage, /transition/, 'the page turn has grown an animation');
});

test('the web app moves five things, at the durations the redesign fixed', () => {
  const { normal } = sheet('web/styles.css');
  // 2 — the cover, faded in once it has decoded. No scale: a cover that grows
  // into place moves the card out from under the pointer.
  assert.match(normal, /\.cover \{[^}]*transition: opacity 150ms ease/);
  assert.match(normal, /\.cover\.ready \{ opacity: 1; \}/);
  assert.doesNotMatch(normal.match(/\.cover \{[^}]*\}/)[0], /scale|translate/);
  // 3 — the hover affordance, and all of it.
  assert.match(normal, /\.card \{[^}]*transition: border-color 80ms ease/);
  // 4 — the view change.
  assert.match(normal, /\.view-enter \{ animation: pf-fade-rise 120ms ease-out; \}/);
  // 5 — the card leaving a filtered shelf.
  assert.match(normal, /\.card\.leaving \{[^}]*animation: pf-card-leave 180ms ease forwards/);
  // 8 — a row arriving in the updates feed.
  assert.match(normal, /\.feed-row \{[^}]*animation: pf-fade-rise 150ms ease/);
});

test('the card hover does not lift, grow or cast a shadow', () => {
  // The single most common library-card treatment on the web, and the reason
  // the redesign says no to it: a grid where every card jumps under the cursor
  // is a grid you cannot skim.
  const { css } = sheet('web/styles.css');
  for (const selector of ['.card:hover', '.card:hover .cover', '.feed-row:hover']) {
    const body = css.match(new RegExp(`${selector.replace(/[.:]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
    assert.doesNotMatch(body, /box-shadow/, `${selector} casts a shadow`);
    assert.doesNotMatch(body, /transform|scale|translate/, `${selector} moves`);
  }
});

test('nothing shimmers, and nothing enters in a cascade', () => {
  for (const path of SHEETS) {
    const { css } = sheet(path);
    assert.doesNotMatch(css, /@keyframes\s+\w*(shimmer|skeleton|pulse|shine|sweep)/i,
      `${path} has a shimmering placeholder`);
    // A stagger is an animation-delay that is a function of the item's index,
    // which in plain CSS means either nth-child or a custom property.
    assert.doesNotMatch(css, /animation-delay\s*:\s*(calc\(|var\()/,
      `${path} staggers an entrance`);
  }
});

test('the number on the Updates tab never animates', () => {
  // It is a count somebody is reading at the moment it changes, and §6 singles
  // it out for exactly that reason.
  const { css } = sheet('web/styles.css');
  const badge = css.match(/\.view-tab \.count \{([^}]*)\}/);
  assert.ok(badge, 'the count has no rule of its own any more');
  assert.doesNotMatch(badge[1], /transition|animation/, 'the count animates');
});

// --- the part the stylesheet cannot do on its own ---------------------------

test('the one place JavaScript waits for an animation asks first', () => {
  // The card leaving a filtered shelf is the only animation the page has to
  // wait on rather than draw, and a reader who asked for less motion must not
  // be made to wait for motion they are not getting.
  const js = read('web/app.js');
  assert.match(js, /matchMedia\?\.\('\(prefers-reduced-motion: reduce\)'\)/);
  assert.match(js, /!REDUCED\?\.matches/, 'the wait ignores the setting it is named after');
  assert.match(js, /await settle\(180 - \(Date\.now\(\) - began\)\)/,
    'the page waits the whole animation again on top of the round trip');
});

test('the cover is revealed by the page, or it is never revealed at all', () => {
  // `.cover` starts at zero opacity, so the class that reveals it is not
  // decoration — an image that loads and never gets it is an invisible hole.
  const js = read('web/app.js');
  assert.match(js, /const reveal = \(\) => img\.classList\.add\('ready'\);/);
  assert.match(js, /img\.decode\(\)\.then\(reveal, reveal\)/,
    'a cover that fails to decode is left invisible');
  assert.match(js, /img\.addEventListener\('load', \(\) => \{/,
    'decode() is called outside a load handler, which starts the fetch and undoes loading="lazy"');
});
