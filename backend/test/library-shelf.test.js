// What the library card says, and how it says it — the R2 shelf.
//
// Three things about a card are load-bearing enough that changing them by
// accident is worth a failing test rather than a bug report:
//
//   1. The state is not carried by colour alone. A dot told the reader that a
//      series was behind; it could not tell them by how much, and it asked them
//      to remember what orange meant. The line now says the number out loud and
//      keeps the dot — belt and braces, for anyone who cannot separate warm
//      orange from warm grey at eight pixels.
//   2. The toolbar wraps. Five buttons and a sentence are wider than a phone,
//      and a flex row that will not wrap does not shrink gracefully — it cuts
//      the labels off, which is the part of a button worth having.
//   3. The card is drawn with a rule rather than filled. That is the whole
//      visual idea of R2, and it is the reason a hover or an unread state can
//      recolour an edge instead of adding one — a border that appears from
//      nothing moves every card under it by a pixel.
//
// The grading rule itself is not tested here. It lives in shared/library-view.js
// and belongs to backend/test/read-state.test.js; R2 was not allowed to move a
// line of it, and the last test in this file is what says so.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** The body of the first rule whose selector list starts with `selector`. */
function rule(css, selector) {
  const re = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm');
  const m = stripComments(css).match(re);
  assert.ok(m, `no rule for ${selector}`);
  return m[2];
}

test('how far behind is said in words, not only in colour', () => {
  const js = read('web/app.js');
  // newChapters and not chaptersBehind: B3 made the sentence say what is news
  // rather than what the arithmetic measures, so a series the reader filed under
  // Completed stops claiming to be behind on chapters it was never going to read.
  assert.match(js, /PanelFlowView\.newChapters\(entry, prog, categories\)/,
    'the card works out the distance itself instead of asking the shared rule');
  assert.match(js, /chapter\$\{behind === 1 \? '' : 's'\} behind/,
    'the distance is not written on the card, or is written without its plural');
  // The dot stays. It is the thing that is readable without reading, and the
  // sentence was added beside it rather than in place of it.
  assert.match(js, /className = 'state-dot'/, 'the dot has gone with the sentence');
  assert.ok(read('web/styles.css').includes('.card .behind'),
    'the sentence has no rule, so it is the colour of the line around it');
});

test('a series with nothing behind it says nothing', () => {
  // Zero and `> 0` together: a series with no bookmark, one whose latest chapter
  // has no number in its label, and one in a folder nobody is following all have
  // no distance to report — and "0 chapters behind" on a caught-up card is noise
  // on every card that is fine.
  const js = read('web/app.js');
  assert.match(js, /newChapters\(entry, prog, categories\);\n\s*if \(behind > 0\)/);
});

test('the library toolbar wraps rather than shrinks', () => {
  const css = read('web/styles.css');
  assert.match(rule(css, '.library-actions'), /flex-wrap:\s*wrap/,
    'five buttons and a status line will run off the side of a phone');
  // And the sentence takes the row to itself once it is a whole line's worth.
  assert.match(stripComments(css), /@media \(max-width: 480px\) \{\s*#check-status \{ flex: 1 0 100%; \}/,
    'the check status no longer takes its own line on a narrow screen');
  // Empty until a check has run: an empty flex item still claims its gap.
  assert.match(stripComments(css), /#check-status:empty \{ display: none; \}/);
});

test('the toolbar is styled by where a button sits, not by its name', () => {
  // #export-open was never in the id list this rule used to be, so one button in
  // five rendered as a raw browser control. A list of ids is a list somebody has
  // to remember to add to; a structural selector cannot forget a sixth button.
  const css = read('web/styles.css');
  const body = rule(css, '.library-actions button:not(.primary)');
  assert.match(body, /border:\s*1px solid var\(--line\)/);
  assert.match(body, /padding:/, 'the buttons keep the browser default height');

  // And nothing in the toolbar is addressed by id for its box any more, so
  // adding a button cannot quietly leave it unstyled.
  const html = read('web/index.html');
  const toolbar = html.match(/<div class="library-actions">[\s\S]*?<\/div>/)[0];
  const ids = [...toolbar.matchAll(/<button id="([\w-]+)"(?![^>]*class="primary")/g)].map((m) => m[1]);
  // Three since R3 took "Check for new chapters" up to the view it fills. This
  // floor is only here so the sweep below cannot pass by matching nothing.
  assert.ok(ids.length >= 3, 'the toolbar has lost its buttons');
  for (const id of ids) {
    assert.doesNotMatch(stripComments(css), new RegExp(`#${id}\\s*[,{][\\s\\S]{0,80}?border:`),
      `#${id} is given a box of its own, which is how one of them came to be forgotten`);
  }
});

test('the card is drawn with a rule, and states recolour it', () => {
  const css = read('web/styles.css');
  assert.match(rule(css, '.card'), /border:\s*1px solid var\(--line\)/,
    'the card has no edge to recolour, so a state has to add one — and adding one reflows the grid');
  for (const [selector, why] of [
    ['.card:hover', 'hover'],
    ['.card.is-unread', 'the unread state'],
  ]) {
    assert.match(rule(css, selector), /border-color:/, `${why} changes something other than the edge`);
    assert.doesNotMatch(rule(css, selector), /(^|[^-])border:\s/,
      `${why} replaces the whole border shorthand, which can change its width`);
  }
});

test('the fallback cover is a letter on a tint the title decides, not a gradient', () => {
  const js = read('web/app.js');
  assert.match(js, /function hashOf\(title\)/, 'the tint is not derived from the title');
  assert.match(js, /setProperty\('--tint'/, 'the tint never reaches the stylesheet');
  assert.match(js, /setProperty\('--tint-weight'/,
    'one knob is six shades of the same orange — the strength has to move too');

  const css = read('web/styles.css');
  const fallback = rule(css, '.cover-fallback');
  assert.doesNotMatch(fallback, /gradient/,
    'every coverless series is the same rectangle again');
  // Both come with a fallback value in the var(): a `.cover-fallback` drawn
  // before app.js has set them is a warm rectangle, not a transparent hole.
  assert.match(fallback, /var\(--tint,/, 'the stylesheet ignores the tint the title hashed to');
  assert.match(fallback, /var\(--tint-weight,/, 'and ignores how strongly it asked for it');
  assert.match(fallback, /var\(--font-cond\)/, 'the letter is not set in the condensed face');
});

test('the same title always draws the same rectangle', () => {
  // The point of hashing rather than picking at random: a shelf that reshuffles
  // its colours on every reload is a shelf you cannot learn.
  const js = read('web/app.js');
  const hashOf = new Function(js.match(/function hashOf\(title\)[\s\S]*?\n\}/)[0] + '\nreturn hashOf;')();
  assert.equal(hashOf('Berserk'), hashOf('Berserk'));
  assert.notEqual(hashOf('Berserk'), hashOf('Vinland Saga'));
  for (const title of ['', 'A', 'Berserk', 'ワンピース', 'x'.repeat(400)]) {
    const h = hashOf(title);
    assert.ok(Number.isInteger(h) && h >= 0, `${JSON.stringify(title)} hashed to ${h}`);
  }
  // And it spreads. A hash that put half a shelf on one rectangle would be
  // worse than no hash at all, because it would look deliberate.
  const titles = ['Berserk', 'Vinland Saga', 'Blame!', 'Oyasumi Punpun', 'ワンピース',
    'Vagabond', 'Monster', 'Pluto', 'Dorohedoro', '20th Century Boys',
    'Solanin', 'Nausicaa', 'Akira', 'Homunculus', 'Gantz', 'Uzumaki'];
  const drawn = new Set(titles.map((t) => {
    const h = hashOf(t);
    // The two knobs fallbackCover turns, in the same words it turns them.
    return `${h % 101}/${(h >>> 9) % 19}`;
  }));
  assert.equal(drawn.size, titles.length, 'two of sixteen titles drew the same rectangle');
});

test('the buttons on a card are drawings, not emoji', () => {
  // An emoji is a different picture on every platform, keeps its own colour
  // whatever the button's is, and sits on a baseline of its own.
  const js = read('web/app.js');
  const html = read('web/index.html');
  // Every <use> in the page points at a <symbol> the same page defines, and
  // every icon app.js stamps is one of those symbols. A typo in either is an
  // empty square, which no browser reports.
  const defined = new Set([...html.matchAll(/<symbol id="(i-[\w-]+)"/g)].map((m) => m[1]));
  assert.ok(defined.size >= 8, 'the sprite has shrunk to almost nothing');
  for (const [, id] of html.matchAll(/<use href="#(i-[\w-]+)"/g)) {
    assert.ok(defined.has(id), `index.html points at #${id}, which nothing defines`);
  }
  // The argument is a literal or a ternary of two — `icon(on ? 'bell' : 'bell-off')`.
  const stamped = new Set(
    [...js.matchAll(/\bicon\(([^)]*)\)/g)]
      .flatMap((m) => [...m[1].matchAll(/'([\w-]+)'/g)].map((q) => q[1])),
  );
  for (const id of stamped) {
    assert.ok(defined.has('i-' + id), `app.js stamps #i-${id}, which the sprite does not define`);
  }
  // The five the shelf itself needs.
  for (const name of ['close', 'pencil', 'plus', 'bell', 'bell-off']) {
    assert.ok(stamped.has(name), `nothing on the shelf asks for the ${name} icon`);
  }
});

test('the grading rule did not move for any of this', () => {
  // R2 was a repaint. shared/library-view.js decides what "unread" means for
  // the web shelf, the popup and the phone at once, and a repaint that quietly
  // adjusted it would have changed all three.
  //
  // It has moved once since, on purpose and not in a repaint: B3 gave hasUnread
  // the account's own shelves, so a series filed under Completed stops counting
  // as news. The shape checked here is the shape after that — read-state.test.js
  // is where the meaning is tested, and this only guards against it drifting
  // while something else is being painted.
  const src = read('shared/library-view.js');
  assert.match(src, /if \(!progress \|\| !progress\.chapterUrl\) return UNREAD;/);
  assert.match(src, /if \(hasUnread\(entry, progress, categories\)\) return UNREAD;/);
  assert.match(src, /return partway\(progress\) \? READING : READ;/);
});
