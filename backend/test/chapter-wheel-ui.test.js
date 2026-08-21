// The chapter picker's wheel: which row is in the middle, and what the keys do
// to it.
//
// The wheel is the one control in the reader that decides where the user *goes*
// rather than what they see, and it is built out of two things that fail
// quietly. The first is arithmetic against a scroll position — an index that is
// off by one opens the wrong chapter, and opening the wrong chapter looks like
// a mis-tap rather than like a bug, so nobody reports it. The second is a
// contract with the stylesheet: `centreOn` works out a scroll position from an
// index by multiplying by the row height, which is only the right answer while
// the wheel is padded by half its own height at both ends. Change the padding
// or the row count in the CSS and every one of these functions still runs,
// still returns a number, and points at the wrong row. Nothing throws. So the
// stylesheet is tested here too, as text, next to the code that depends on it.
//
// As in page-turn.test.js, the functions are lifted out of
// extension/content/reader.js rather than copied, and the DOM they reach for is
// replaced with a stub that records what they asked of it. What is exercised
// below is the shipping wheel.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, MESSAGES } from './helpers/i18n.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rjs = readFileSync(join(root, 'extension', 'content', 'reader.js'), 'utf8');
const rcss = readFileSync(join(root, 'extension', 'content', 'reader.css'), 'utf8');

/** The row height the stub reports, and the one the stylesheet declares. */
const ROW = 32;

/** A DOM node with exactly the surface the wheel touches, and no more. */
function node(cls = '') {
  const classes = new Set(cls.split(' ').filter(Boolean));
  const self = {
    children: [],
    dataset: {},
    attrs: {},
    parent: null,
    hidden: false,
    scrollTop: 0,
    // Every scroll the wheel asked for, so a test can tell "put it there" from
    // "glide there", and can tell one scroll from none at all.
    scrolls: [],
    offsetHeight: ROW,
    text: '',
    get className() { return [...classes].join(' '); },
    set className(v) {
      classes.clear();
      for (const c of String(v).split(' ')) if (c) classes.add(c);
    },
    classList: {
      add: (...c) => { for (const x of c) classes.add(x); },
      remove: (...c) => { for (const x of c) classes.delete(x); },
      contains: (c) => classes.has(c),
      toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); },
    },
    setAttribute: (k, v) => { self.attrs[k] = String(v); },
    getAttribute: (k) => (k in self.attrs ? self.attrs[k] : null),
    appendChild: (child) => { child.parent = self; self.children.push(child); return child; },
    querySelectorAll: (sel) => self.children.filter((c) => c.classList.contains(sel.slice(1))),
    scrollTo: ({ top, behavior }) => { self.scrolls.push({ top, behavior }); self.scrollTop = top; },
    closest: (sel) => {
      for (let n = self; n; n = n.parent) if (n.classList.contains(sel.slice(1))) return n;
      return null;
    },
    get textContent() { return self.text; },
    // Setting it to the empty string is how the wheel is emptied before a
    // rebuild, and in a real DOM that takes the children with it.
    set textContent(v) { self.text = String(v); if (self.text === '') self.children.length = 0; },
  };
  return self;
}

const lift = (names, inject) => {
  const from = '  /** Whether a row is the chapter on screen. */';
  const to = '  function gotoChapter(url) {';
  const a = rjs.indexOf(from);
  const b = rjs.indexOf(to);
  assert.ok(a !== -1 && b > a, 'the wheel is not where this test expects it in reader.js');
  const keys = Object.keys(inject);
  return new Function(...keys, `${rjs.slice(a, b)}
    return { ${names.join(', ')} };`)(...keys.map((k) => inject[k]));
};

const CHAPTERS = Array.from({ length: 9 }, (_, n) => ({
  label: `Chapitre ${n + 1}`,
  url: `https://scan.test/serie/ch-${n + 1}`,
}));

/**
 * A wheel on `chapters`, standing on chapter `here`, wired to a stub screen.
 * `read` is the set of URLs the history has answered with; `null` is the
 * history not having answered yet, which is a different thing from "none".
 */
function wheelOn({
  chapters = CHAPTERS,
  here = CHAPTERS[3].url,
  href = null,
  hideRead = false,
  read = null,
  open = true,
} = {}) {
  const chapwrap = node('pf-chapwrap');
  const wheel = chapwrap.appendChild(node('pf-wheel'));
  const chapbtn = chapwrap.appendChild(node('pf-chapbtn'));
  wheel.hidden = !open;

  const state = {
    root: {},
    meta: { chapterUrl: here },
    chapters,
    prefs: { hideRead },
    readChapters: read === null ? null : new Set(read),
    wheelIndex: 0,
  };

  const $ = (sel) => ({
    '.pf-wheel': wheel,
    '.pf-chapbtn': chapbtn,
    '.pf-wheel .pf-wrow': wheel.children[0],
  }[sel]);

  const listeners = [];
  const document = {
    createElement: () => node(),
    addEventListener: (type, fn, capture) => { listeners.push({ type, fn, capture }); },
    removeEventListener: (type, fn, capture) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
      if (i !== -1) listeners.splice(i, 1);
    },
  };

  const went = [];
  const api = lift(
    ['isHere', 'rowHeight', 'fillWheel', 'centreIndex', 'centreOn', 'markCentre',
      'onWheelAway', 'openWheel', 'onWheelKey', 'pickChapter'],
    { state, $, document, location: { href: href ?? here }, t, gotoChapter: (u) => went.push(u) },
  );

  return {
    ...api,
    state,
    wheel,
    chapbtn,
    chapwrap,
    listeners,
    went,
    rows: () => wheel.children,
    labels: () => wheel.children.map((r) => r.textContent),
    key: (k) => {
      let prevented = 0;
      let stopped = 0;
      const handled = api.onWheelKey({
        key: k,
        preventDefault: () => { prevented++; },
        stopPropagation: () => { stopped++; },
      });
      return { handled, prevented, stopped };
    },
    press: (target) => api.onWheelAway({ target }),
  };
}

test('every row can be brought to the centre, first and last included', () => {
  const w = wheelOn();
  w.fillWheel();
  assert.equal(w.rows().length, CHAPTERS.length);
  for (let i = 0; i < CHAPTERS.length; i++) {
    w.centreOn(i);
    assert.equal(w.centreIndex(), i, `row ${i} does not come back as row ${i}`);
  }
});

test('the row in the middle is the one marked, and only that one', () => {
  const w = wheelOn();
  w.fillWheel();
  w.centreOn(6);
  const on = w.rows().filter((r) => r.classList.contains('pf-on'));
  assert.equal(on.length, 1);
  assert.equal(on[0].textContent, 'Chapitre 7');
});

test('a scroll position between two rows resolves to the nearer one', () => {
  const w = wheelOn();
  w.fillWheel();
  // Just under half a row past row 2 is still row 2; just over is row 3. This
  // is the difference between a wheel that settles where you left it and one
  // that creeps a chapter every time you look at it.
  w.wheel.scrollTop = 2 * ROW + (ROW / 2 - 1);
  assert.equal(w.centreIndex(), 2);
  w.wheel.scrollTop = 2 * ROW + (ROW / 2 + 1);
  assert.equal(w.centreIndex(), 3);
});

test('an overscrolled wheel still names a real row', () => {
  const w = wheelOn();
  w.fillWheel();
  // Rubber-band scrolling hands back positions outside the range at both ends,
  // and `rows[i]` on either side of the list is undefined — which is Enter
  // doing nothing on a wheel that plainly has a row in the middle.
  w.wheel.scrollTop = -240;
  assert.equal(w.centreIndex(), 0);
  w.wheel.scrollTop = 99_999;
  assert.equal(w.centreIndex(), CHAPTERS.length - 1);
});

test('the chapter on screen is recognised through either of its two URLs', () => {
  // The page's own chapter list and the address bar do not always spell it the
  // same way; a trailing slash is the usual difference.
  const w = wheelOn({ here: CHAPTERS[3].url, href: `${CHAPTERS[3].url}/` });
  assert.ok(w.isHere(CHAPTERS[3].url));
  assert.ok(w.isHere(`${CHAPTERS[3].url}/`));
  assert.ok(!w.isHere(CHAPTERS[4].url));
  w.fillWheel();
  const here = w.rows().filter((r) => r.classList.contains('pf-here'));
  assert.equal(here.length, 1);
  assert.equal(here[0].textContent, 'Chapitre 4');
  assert.equal(w.state.wheelIndex, 3);
});

test('hiding read chapters keeps the one being read, and re-indexes on what is left', () => {
  const w = wheelOn({
    hideRead: true,
    here: CHAPTERS[3].url,
    read: [CHAPTERS[0].url, CHAPTERS[1].url, CHAPTERS[2].url, CHAPTERS[3].url],
  });
  w.fillWheel();
  // Three dropped, the fourth kept because it is the one on screen: a wheel
  // that opens with its current row missing looks like it jumped somewhere.
  assert.deepEqual(w.labels().slice(0, -1), [
    'Chapitre 4', 'Chapitre 5', 'Chapitre 6', 'Chapitre 7', 'Chapitre 8', 'Chapitre 9',
  ]);
  // wheelIndex counts the rows that exist, not the chapters that do.
  assert.equal(w.state.wheelIndex, 0);
  w.centreOn(w.state.wheelIndex);
  assert.equal(w.centreIndex(), 0);
  assert.equal(w.rows()[0].classList.contains('pf-here'), true);
});

test('the note says how many were hidden, in the words that ship, and cannot be opened', () => {
  const one = wheelOn({ hideRead: true, read: [CHAPTERS[0].url] });
  one.fillWheel();
  const singular = one.rows().at(-1);
  assert.ok(singular.classList.contains('pf-wnote'));
  assert.equal(singular.textContent, t('readerHiddenOne', ['1']));
  assert.notEqual(singular.textContent, 'readerHiddenOne');

  const many = wheelOn({ hideRead: true, read: [CHAPTERS[0].url, CHAPTERS[1].url, CHAPTERS[2].url] });
  many.fillWheel();
  const plural = many.rows().at(-1);
  assert.equal(plural.textContent, t('readerHiddenMany', ['3']));
  assert.ok(MESSAGES.readerHiddenOne && MESSAGES.readerHiddenMany);
  assert.notEqual(MESSAGES.readerHiddenOne.message, MESSAGES.readerHiddenMany.message);

  // It is a row of the wheel — it scrolls and can be centred like any other —
  // but it carries no url, so Enter on it goes nowhere rather than to `undefined`.
  assert.equal(plural.dataset.url, undefined);
  many.centreOn(many.rows().length - 1);
  const { handled } = many.key('Enter');
  assert.equal(handled, true);
  assert.deepEqual(many.went, []);
  assert.equal(many.wheel.hidden, false);
});

test('nothing is claimed about a chapter before the history has answered', () => {
  const w = wheelOn({ read: null });
  w.fillWheel();
  // readChapters is null until the lookup comes back. Colouring then would
  // flash a wheel of "unread" at someone who has read all of it.
  for (const row of w.rows()) {
    assert.ok(!row.classList.contains('pf-read'));
    assert.ok(!row.classList.contains('pf-unread'));
  }
  assert.equal(w.rows().filter((r) => r.classList.contains('pf-here')).length, 1);

  const answered = wheelOn({ read: [CHAPTERS[0].url] });
  answered.fillWheel();
  assert.ok(answered.rows()[0].classList.contains('pf-read'));
  assert.ok(answered.rows()[1].classList.contains('pf-unread'));
});

test('nothing is hidden when the preference is off, however much has been read', () => {
  const w = wheelOn({ hideRead: false, read: CHAPTERS.map((c) => c.url) });
  w.fillWheel();
  assert.equal(w.rows().length, CHAPTERS.length);
  assert.ok(!w.rows().some((r) => r.classList.contains('pf-wnote')));
});

test('rebuilding the wheel does not leave the old rows underneath', () => {
  const w = wheelOn();
  w.fillWheel();
  w.fillWheel();
  w.fillWheel();
  assert.equal(w.rows().length, CHAPTERS.length);
});

test('a wheel that is not on screen is not scrolled', () => {
  // Offsets are all zero while the element is hidden, so a scroll set now is
  // set against nothing and lands on row 0 when it opens.
  const w = wheelOn({ open: false, here: CHAPTERS[7].url });
  w.fillWheel();
  assert.equal(w.state.wheelIndex, 7);
  assert.equal(w.wheel.scrollTop, 0);
  assert.deepEqual(w.wheel.scrolls, []);
  // Opening it is what places it.
  w.openWheel(true);
  assert.equal(w.centreIndex(), 7);
});

test('opening and closing says so out loud, and opening centres on where you are', () => {
  const w = wheelOn({ open: false, here: CHAPTERS[5].url });
  w.fillWheel();
  w.openWheel(true);
  assert.equal(w.wheel.hidden, false);
  assert.equal(w.chapbtn.getAttribute('aria-expanded'), 'true');
  assert.equal(w.centreIndex(), 5);
  w.openWheel(false);
  assert.equal(w.wheel.hidden, true);
  assert.equal(w.chapbtn.getAttribute('aria-expanded'), 'false');
});

test('an evening of opening and closing the wheel leaves one listener, not a stack', () => {
  const w = wheelOn({ open: false });
  w.fillWheel();
  for (let n = 0; n < 20; n++) { w.openWheel(true); w.openWheel(false); }
  assert.deepEqual(w.listeners, []);
  w.openWheel(true);
  assert.equal(w.listeners.length, 1);
  // On the document and in the capture phase, because the press that closes it
  // is usually on the host page behind the reader.
  assert.equal(w.listeners[0].type, 'pointerdown');
  assert.equal(w.listeners[0].capture, true);
  // Opening an open wheel does not add a second.
  w.openWheel(true);
  assert.equal(w.listeners.length, 1);
});

test('a press inside the picker keeps it open, a press anywhere else closes it', () => {
  const w = wheelOn({ open: false });
  w.fillWheel();
  w.openWheel(true);
  w.press(w.rows()[2]);
  assert.equal(w.wheel.hidden, false, 'pressing a row of the wheel closed the wheel');
  w.press(w.chapbtn);
  assert.equal(w.wheel.hidden, false, 'pressing the button that opens it closed it');
  w.press(node('some-page-of-theirs'));
  assert.equal(w.wheel.hidden, true);
});

test('once the reader is gone the listener takes itself off the document', () => {
  const w = wheelOn({ open: false });
  w.fillWheel();
  w.openWheel(true);
  assert.equal(w.listeners.length, 1);
  // close() tears the reader out; this handler is on the document, which
  // survives it, so it has to notice on its own.
  w.state.root = null;
  w.press(node('anything'));
  assert.deepEqual(w.listeners, []);
});

test('the keys that search the wheel', () => {
  const w = wheelOn();
  w.fillWheel();
  w.centreOn(4);

  assert.equal(w.key('ArrowDown').handled, true);
  assert.equal(w.centreIndex(), 5);
  assert.equal(w.key('ArrowUp').handled, true);
  assert.equal(w.centreIndex(), 4);
  w.key('PageDown');
  assert.equal(w.centreIndex(), 8, 'PageDown does not move by five rows');
  w.key('PageUp');
  assert.equal(w.centreIndex(), 3);
  w.key('Home');
  assert.equal(w.centreIndex(), 0);
  w.key('End');
  assert.equal(w.centreIndex(), CHAPTERS.length - 1);

  // Every one of them glides rather than jumps: the wheel is being read while
  // it moves, and a jump loses the reader's place in the list.
  assert.ok(w.wheel.scrolls.length >= 6);
  assert.ok(w.wheel.scrolls.every((s) => s.behavior === 'smooth'));
});

test('the ends of the list are ends, not places to fall off', () => {
  const w = wheelOn();
  w.fillWheel();
  w.centreOn(1);
  w.key('PageUp');
  assert.equal(w.centreIndex(), 0);
  w.key('ArrowUp');
  assert.equal(w.centreIndex(), 0);
  w.centreOn(CHAPTERS.length - 2);
  w.key('PageDown');
  assert.equal(w.centreIndex(), CHAPTERS.length - 1);
  w.key('ArrowDown');
  assert.equal(w.centreIndex(), CHAPTERS.length - 1);
});

test('Enter opens the row in the middle; Escape closes without opening anything', () => {
  const w = wheelOn({ open: false });
  w.fillWheel();
  w.openWheel(true);
  w.centreOn(6);
  const enter = w.key('Enter');
  assert.equal(enter.handled, true);
  assert.equal(enter.prevented, 1);
  assert.equal(enter.stopped, 1);
  assert.deepEqual(w.went, [CHAPTERS[6].url]);

  const esc = wheelOn({ open: false });
  esc.fillWheel();
  esc.openWheel(true);
  assert.equal(esc.key('Escape').handled, true);
  assert.equal(esc.wheel.hidden, true);
  assert.deepEqual(esc.went, []);
  assert.deepEqual(esc.listeners, []);
});

test('picking the chapter already open closes the wheel instead of reloading the page', () => {
  // Navigating to where you already are throws away the reader's state and
  // your position in the chapter, to arrive at the same place.
  const w = wheelOn({ open: false, here: CHAPTERS[3].url, href: `${CHAPTERS[3].url}/` });
  w.fillWheel();
  w.openWheel(true);
  w.pickChapter(CHAPTERS[3].url);
  assert.deepEqual(w.went, []);
  assert.equal(w.wheel.hidden, true);

  // And by the other spelling of the same chapter, which is the one the address
  // bar holds when the page's list and the address bar disagree.
  const alt = wheelOn({ open: false, here: CHAPTERS[3].url, href: `${CHAPTERS[3].url}/` });
  alt.fillWheel();
  alt.openWheel(true);
  alt.pickChapter(`${CHAPTERS[3].url}/`);
  assert.deepEqual(alt.went, []);
  assert.equal(alt.wheel.hidden, true);
});

test('a key the wheel has no use for is handed back to the reader', () => {
  // The reader turns pages on ArrowRight and toggles things on letters. If the
  // wheel swallowed those, an open wheel would freeze the reader behind it.
  const w = wheelOn();
  w.fillWheel();
  w.centreOn(2);
  for (const k of ['ArrowRight', 'ArrowLeft', ' ', 'f', 'h', '?', 'Tab']) {
    const r = w.key(k);
    assert.equal(r.handled, false, `the wheel swallowed ${k}`);
    assert.equal(r.prevented, 0, `the wheel cancelled ${k}`);
  }
  assert.equal(w.centreIndex(), 2);
});

test('the row height is asked of the row, and the fallback matches the stylesheet', () => {
  const w = wheelOn();
  w.fillWheel();
  w.rows()[0].offsetHeight = 44;
  assert.equal(w.rowHeight(), 44, 'the wheel assumes a height instead of measuring one');
  // Zoomed, a taller row still centres: the arithmetic is index times measured
  // height, not index times 32.
  w.centreOn(3);
  assert.equal(w.wheel.scrollTop, 3 * 44);
  assert.equal(w.centreIndex(), 3);

  // Empty, there is nothing to measure and the CSS default is repeated in JS.
  const empty = wheelOn({ chapters: [] });
  empty.fillWheel();
  assert.equal(empty.rows().length, 0);
  assert.equal(empty.rowHeight(), ROW);
  assert.match(rcss, /--pf-row:\s*32px/,
    'reader.js falls back to 32px for a row; reader.css no longer says 32px');
});

test('the stylesheet still holds up the arithmetic that reads it', () => {
  const a = rcss.indexOf('#panelflow-reader .pf-wheel {');
  assert.ok(a !== -1, '.pf-wheel is not in reader.css');
  const wheel = rcss.slice(a, rcss.indexOf('\n}', a));

  // An even row count puts (rows - 1) / 2 on a half pixel, and the band across
  // the middle stops lining up with the row it is marking.
  const rows = Number(/--pf-rows:\s*(\d+)/.exec(wheel)?.[1]);
  assert.ok(Number.isInteger(rows) && rows % 2 === 1, `--pf-rows is ${rows}, which is not odd`);

  // centreOn() sets scrollTop to index * height and expects that to land the
  // row in the middle. That is only true while the wheel is padded by half its
  // visible height at both ends.
  assert.match(wheel, /padding:\s*calc\(var\(--pf-row\) \* \(var\(--pf-rows\) - 1\) \/ 2\) 0/,
    'the wheel is no longer padded by half its height, so centreOn() is off by that much');

  // The height has to mean the rows you see, whatever box-sizing the host page
  // has set on everything, plus the two border pixels.
  assert.match(wheel, /box-sizing:\s*border-box/);
  assert.match(wheel, /height:\s*calc\(var\(--pf-row\) \* var\(--pf-rows\) \+ 2px\)/);
  assert.match(wheel, /border:\s*1px solid/);

  // The band is painted at exactly the row the padding centres, and is exactly
  // one row tall — it is the only thing telling the user what Enter will open.
  const stops = [...wheel.matchAll(/\(var\(--pf-rows\) ([-+]) 1\) \/ 2/g)].map((m) => m[1]);
  assert.deepEqual(stops, ['-', '-', '-', '+', '+'],
    'the centre band no longer starts where the padding ends and stops one row later');

  assert.match(wheel, /scroll-snap-type:\s*y mandatory/);
  const b = rcss.indexOf('#panelflow-reader .pf-wrow {');
  const row = rcss.slice(b, rcss.indexOf('\n}', b));
  assert.match(row, /box-sizing:\s*border-box/);
  assert.match(row, /height:\s*var\(--pf-row\)/);
  assert.match(row, /scroll-snap-align:\s*center/);
});
