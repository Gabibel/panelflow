// What the phone does when an injected script does not survive.
//
// Both native shells wrap each injected file in its own try/catch, and both
// catches used to end in `console.warn` — on a device with no console anyone
// will ever open. The failure the user actually saw was a page where the Reader
// Mode pill never appeared, with nothing on screen saying why, and the same
// silence covered a file missing from the build entirely: Android substituted a
// comment for the asset it could not read, iOS dropped it from the array.
//
// The visible half of the fix is mobile/inject/report-failure.js, run here for
// real in a DOM small enough to fit in this file. The native half is four lines
// of Kotlin and Swift that cannot be compiled on this machine, so what is
// checked of them is what a reader would check: that the catch calls the
// reporter, that the reporter is injected first, and that a missing file is
// thrown rather than swallowed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const SRC = read('mobile', 'inject', 'report-failure.js');

// --- a page to be broken in --------------------------------------------------

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.handlers = {};
    this.attrs = {};
    this.id = '';
    this._text = '';
  }

  get textContent() { return this._text; }

  set textContent(v) { this._text = String(v); }

  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n.tagName === 'HTML';
  }

  appendChild(node) { node.parentNode = this; this.childNodes.push(node); return node; }

  remove() {
    if (this.parentNode) {
      this.parentNode.childNodes = this.parentNode.childNodes.filter((n) => n !== this);
    }
    this.parentNode = null;
  }

  setAttribute(k, v) { this.attrs[k] = String(v); }

  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }

  find(id) {
    if (this.id === id) return this;
    for (const n of this.childNodes) {
      const hit = n.find(id);
      if (hit) return hit;
    }
    return null;
  }

  /** Every button under this node, in the order they were added. */
  buttons(out = []) {
    if (this.tagName === 'BUTTON') out.push(this);
    for (const n of this.childNodes) n.buttons(out);
    return out;
  }
}

const fire = (el, type) => { for (const fn of el.handlers[type] || []) fn({}); };

/**
 * Load report-failure.js into a fresh page.
 * @param {object} [opts]
 * @param {boolean} [opts.body]  false = document-start, no <body> yet
 * @param {boolean} [opts.bridge]  false = no native transport on this window
 */
function boot({ body = true, bridge = true } = {}) {
  const html = new El('html');
  const bodyEl = new El('body');
  if (body) html.appendChild(bodyEl);

  const doc = {
    documentElement: html,
    get body() { return html.childNodes.includes(bodyEl) ? bodyEl : null; },
    createElement: (tag) => new El(tag),
    getElementById: (id) => html.find(id),
    handlers: {},
    addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); },
  };

  const posted = [];
  const reloads = [];
  const warned = [];
  const win = { __proto__: null };
  if (bridge) win.PanelFlowNative = { post: (s) => posted.push(s) };

  const sandbox = {
    window: win,
    document: doc,
    location: { reload: () => reloads.push(1) },
    console: { warn: (...a) => warned.push(a.join(' ')) },
    setTimeout,
    JSON,
    String,
    Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  return {
    win, doc, html, posted, reloads, warned, sandbox,
    /** Inject the file again, the way an SPA navigation does. */
    reinject: () => vm.runInContext(SRC, sandbox),
    box: () => html.find('panelflow-load-failure'),
    shown: () => html.find('panelflow-load-failure-text')?.textContent ?? null,
    ready: () => { html.appendChild(bodyEl); for (const fn of doc.handlers.DOMContentLoaded || []) fn(); },
  };
}

// --- the line on the screen --------------------------------------------------

test('a script that dies says so on the page, not only in the console', () => {
  const p = boot();
  p.win.PanelFlowFailed('inject/detect.js', new Error('site clobbered Array.from'));

  const shown = p.shown();
  assert.ok(shown, 'nothing was put on screen');
  // Both halves: which file, and what went wrong with it. The file name alone
  // is not enough to tell a build mistake from a hostile page.
  assert.match(shown, /inject\/detect\.js/);
  assert.match(shown, /site clobbered Array\.from/);
  // And still in the console, because that is what survives if the DOM half of
  // the reporter is itself what broke.
  assert.ok(p.warned.some((w) => w.includes('inject/detect.js')));
});

test('a file missing from the build reads as a failure, not as silence', () => {
  // This is the shape both shells now produce for an absent asset: a throw
  // inside the wrapper, so it comes out of the same pipe as a script that blew
  // up on the page.
  const p = boot();
  p.win.PanelFlowFailed('inject/reader.js', new Error('missing from the build'));
  assert.match(p.shown(), /inject\/reader\.js — missing from the build/);
});

test('two dead files make two lines, not two banners', () => {
  const p = boot();
  p.win.PanelFlowFailed('inject/detect.js', new Error('boom'));
  p.win.PanelFlowFailed('inject/reader.js', new Error('bang'));

  assert.equal(p.html.childNodes[0].childNodes.filter((n) => n.id === 'panelflow-load-failure').length, 1);
  assert.match(p.shown(), /detect\.js/);
  assert.match(p.shown(), /reader\.js/);
});

test('at document start there is no body, and the line waits for one', () => {
  // Appending to a bare <html> before the parser has run is how you get an
  // element the parser then throws away — the banner would exist and never be
  // seen, which is the bug this file is about, wearing a different hat.
  const p = boot({ body: false });
  p.win.PanelFlowFailed('inject/popup-guard.js', new Error('boom'));
  assert.equal(p.box(), null, 'the banner was attached before there was a body');

  p.ready();
  assert.match(p.shown(), /popup-guard\.js/);
});

test('the reader can get rid of it, and can ask for another try', () => {
  const p = boot();
  p.win.PanelFlowFailed('inject/detect.js', new Error('boom'));
  const [reload, hide] = p.box().buttons();

  fire(reload, 'click');
  assert.equal(p.reloads.length, 1, 'the first button is not the retry');

  fire(hide, 'click');
  assert.equal(p.box(), null, 'the banner would not go away');
});

test('the failure also goes out over the bridge', () => {
  // Fire-and-forget, as an `event` envelope: both shells route those through a
  // switch that ignores what it does not know, so it holds no request open.
  const p = boot();
  p.win.PanelFlowFailed('inject/detect.js', new Error('boom'));

  assert.equal(p.posted.length, 1);
  const sent = JSON.parse(p.posted[0]);
  assert.equal(sent.event, 'scriptFailed');
  assert.equal(sent.file, 'inject/detect.js');
  assert.match(sent.error, /boom/);
  assert.equal(sent.id, undefined, 'an id would make native wait for a reply that never comes');
});

test('no bridge is not a crash — the page still says what happened', () => {
  // Every one of these files is also loadable in a plain browser for debugging.
  const p = boot({ bridge: false });
  p.win.PanelFlowFailed('inject/detect.js', new Error('boom'));
  assert.match(p.shown(), /detect\.js/);
});

test('an SPA navigation re-injects the file without losing what already failed', () => {
  const p = boot();
  p.win.PanelFlowFailed('inject/detect.js', new Error('boom'));
  p.reinject();

  const listed = p.win.PanelFlowFailed.list();
  assert.equal(listed.length, 1, 'the second injection started a new list');
  assert.equal(listed[0].file, 'inject/detect.js');
  assert.match(p.shown(), /detect\.js/);
});

// --- the four lines of native that call it -----------------------------------

const kotlin = read('android', 'app', 'src', 'main', 'java', 'dev', 'panelflow', 'PageScripts.kt');
const swift = read('ios', 'Sources', 'PageScripts.swift');

test('both shells inject the reporter, and inject it first', () => {
  // It is what every other file's catch calls, including its own.
  assert.match(kotlin, /EARLY = listOf\(\s*"inject\/report-failure\.js"/);
  assert.match(swift, /early = \["report-failure"/);
});

test('neither shell answers a dead script with console.warn alone', () => {
  // Kotlin routes its catches through one `report()` helper, Swift writes the
  // clause inline; either way no catch may end at the console on its own.
  for (const m of kotlin.matchAll(/catch\s*\(e\)\s*\{([^}]*)/g)) {
    assert.match(m[1], /\$\{report\(|PanelFlowFailed/, `PageScripts.kt: a catch that only reaches the console`);
  }
  assert.match(kotlin, /fun report\([\s\S]*?PanelFlowFailed/, 'the Kotlin helper stops at the console');
  for (const m of swift.matchAll(/catch\s*\(e\)\s*\{([^}]*)/g)) {
    assert.match(m[1], /PanelFlowFailed/, 'PageScripts.swift: a catch that only reaches the console');
  }
  // The console line stays as the last resort — it is all that is left when the
  // reporter is the file that failed.
  assert.match(kotlin, /else console\.warn/);
  assert.match(swift, /else console\.warn/);
});

test('iOS names the file that failed', () => {
  // It used to report every one of them as "injected script failed", which is
  // true and useless: five files, one message, no way to tell them apart.
  assert.match(swift, /PanelFlowFailed\('\\\(name\)'/);
  assert.doesNotMatch(swift, /injected script failed/);
});

test('a missing asset is thrown, not commented out or dropped', () => {
  assert.match(kotlin, /ifEmpty \{ "throw new Error\('missing from the build'\);" \}/);
  assert.doesNotMatch(kotlin, /missing asset/);
  // The Swift side used to lose it to compactMap, which is why the shape
  // matters as much as the message: mapping keeps the entry, and the entry
  // throws.
  assert.match(swift, /throw new Error\('missing from the bundle'\);/);
  assert.doesNotMatch(swift, /compactMap/);
});

test('both builds actually ship the file', () => {
  // Gradle syncs the whole directory; the iOS script used to name chrome-shim.js
  // one file at a time, which is exactly how a new injected file gets left out
  // of the .ipa and nobody notices until a phone is in someone else's hand.
  assert.match(read('android', 'app', 'build.gradle.kts'), /from\("\$repoRoot\/mobile\/inject"\)/);
  assert.match(read('ios', 'Scripts', 'bundle-assets.sh'), /mobile\/inject\/"\*\.js/);
});
