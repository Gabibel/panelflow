// Who owns a key press while the reader is open.
//
// The reader listens for keys on the document, in the capture phase, and
// cancels the ones it claims — `c`, `s`, `b`, `f`, `h`, `0`, `?`, the arrows
// and the space bar. A cancelled keydown never becomes a character, which is
// invisible until something inside the reader wants to be typed into: adding a
// custom tag from the library sheet came out as "oplay" for "cosplay", with no
// error and nothing on screen to suggest why.
//
// The sheet is a closed shadow root, so from this document every key pressed
// inside it is reported on its host element and the field itself cannot be
// reached — which is why the guard checks the host's id rather than looking for
// an <input>.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rjs = readFileSync(join(root, 'extension', 'content', 'reader.js'), 'utf8');

/** The reader's key handling, lifted out of the shipping file. */
function keys({ mode = 'vertical', wheelOpen = false } = {}) {
  const done = [];
  const state = { root: {}, mode, chromeVisible: true, prefs: {} };
  const stage = { scrollBy: () => done.push('scroll') };
  const $ = (sel) => ({
    '.pf-wheel': { hidden: !wheelOpen },
    '.pf-help': { hidden: true },
    '.pf-end': { hidden: true },
    '.pf-stage': stage,
  }[sel]);

  const from = '  /**\n   * Whether this key is being typed into something';
  const to = '  function updateCounter() {';
  const a = rjs.indexOf(from);
  const b = rjs.indexOf(to);
  assert.ok(a !== -1 && b > a, 'the reader\'s key handling is not where this test expects it');
  const inject = {
    state,
    $,
    onWheelKey: () => { done.push('wheel'); return true; },
    showHelp: () => done.push('help'),
    showEnd: () => done.push('end'),
    close: () => done.push('close'),
    openWheel: () => done.push('chapters'),
    togglePrefs: () => done.push('prefs'),
    toggleBreak: () => done.push('break'),
    toggleFullscreen: () => done.push('fullscreen'),
    setChrome: () => done.push('chrome'),
    resetTransform: () => done.push('reset'),
    applyTransform: () => {},
    isRtl: () => false,
    next: () => done.push('next'),
    prev: () => done.push('prev'),
    stopAutoplay: () => {},
    innerHeight: 800,
  };
  const names = Object.keys(inject);
  const { typingInto, onKey } = new Function(...names,
    `${rjs.slice(a, b)}\nreturn { typingInto, onKey };`)(...names.map((n) => inject[n]));

  return {
    done,
    typingInto,
    /** One key press at `target`, and whether the reader cancelled it. */
    press: (key, target = {}) => {
      let prevented = 0;
      onKey({ key, target, preventDefault: () => { prevented++; } });
      return prevented;
    },
  };
}

/** A node as an event reports it: an element, with a tag and maybe an id. */
const el = (tagName, extra = {}) => ({ nodeType: 1, tagName, ...extra });

test('the reader still owns the keys pressed at the reader', () => {
  // The guard must not cost the shortcuts their whole reason for existing, so
  // the ordinary case is pinned first: a key pressed with nothing focused is
  // the reader's, cancelled and acted on.
  const k = keys();
  for (const [key, act] of [['s', 'prefs'], ['b', 'break'], ['f', 'fullscreen'],
    ['h', 'chrome'], ['0', 'reset'], ['?', 'help']]) {
    const r = keys();
    assert.equal(r.press(key), 1, `${key} is no longer claimed by the reader`);
    assert.deepEqual(r.done, [act], `${key} no longer does anything`);
  }
  assert.equal(k.press('Escape'), 1);
  assert.deepEqual(k.done, ['close']);
});

test('a key typed into the library sheet is left alone', () => {
  // The bug as it was reported: half the letters of a tag never arrived. The
  // sheet is closed, so the target is its host and every key inside it looks
  // like this one.
  const sheet = el('DIV', { id: 'panelflow-libmodal' });
  for (const key of ['c', 'C', 's', 'S', 'b', 'B', 'f', 'F', 'h', 'H', '0', '?', ' ']) {
    const k = keys();
    assert.equal(k.press(key, sheet), 0, `the reader still swallows ${key} in the tag field`);
    assert.deepEqual(k.done, [], `${key} still triggers the reader from inside the sheet`);
  }
});

test('Escape in the library sheet closes the sheet, not the reader', () => {
  // The sheet has its own Escape. Ours firing as well would close the reader
  // out from under it and take the half-typed tag with it.
  const k = keys();
  assert.equal(k.press('Escape', el('DIV', { id: 'panelflow-libmodal' })), 0);
  assert.deepEqual(k.done, []);
});

test('Escape still leaves a field inside the reader itself', () => {
  // The reader's own panels have text fields too, and Escape is the only way
  // out of them from the keyboard — so the guard stops at the one key a field
  // has no use for.
  const k = keys();
  assert.equal(k.press('Escape', el('INPUT')), 1);
  assert.deepEqual(k.done, ['close']);
});

test('every kind of field is a field, including the ones without a tag name', () => {
  const k = keys();
  assert.equal(k.typingInto(el('INPUT')), true);
  assert.equal(k.typingInto(el('TEXTAREA')), true);
  assert.equal(k.typingInto(el('SELECT')), true);
  assert.equal(k.typingInto(el('DIV', { isContentEditable: true })), true);
  assert.equal(k.typingInto(el('DIV', { id: 'panelflow-libmodal' })), true);
  assert.equal(k.typingInto(el('DIV')), false);
  assert.equal(k.typingInto(el('BUTTON')), false);
  // A keydown can be reported on the document itself, which has no tagName.
  assert.equal(k.typingInto({ nodeType: 9 }), false);
  assert.equal(k.typingInto(null), false);
});

test('typing in a field does not reach the chapter wheel either', () => {
  // The wheel gets first refusal on keys, and it used to get it before anyone
  // asked whether the key was being typed — so up and down in the tag field
  // scrolled the chapter list behind the sheet.
  const k = keys({ wheelOpen: true });
  assert.equal(k.press('ArrowDown', el('DIV', { id: 'panelflow-libmodal' })), 0);
  assert.deepEqual(k.done, []);
  // With nothing focused it is still the wheel's key, which is the other half
  // of the same rule.
  const open = keys({ wheelOpen: true });
  open.press('ArrowDown');
  assert.deepEqual(open.done, ['wheel']);
});
