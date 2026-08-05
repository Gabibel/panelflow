// The content scripts talk to each other through two globals — the detector
// hands the reader a chapter, the reader asks the detector for series meta and
// chapter links — and nothing checks that the calls and the exports agree.
// Neither side imports the other: they are separate <script> injections into
// someone else's page, so a name that drifts is not a build error, it is a
// TypeError inside a click handler on a stranger's site, where nobody sees it.
//
// That is not hypothetical: openText() was called by detect.js for a while
// before reader.js exported it, and the only symptom was a pill that did
// nothing when clicked.
//
// So: read both sides as text and check every name used is a name provided.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// Everything injected into a page, plus the mobile shim, which reaches for the
// same globals from native's side.
const CALLERS = [
  'extension/content/detect.js',
  'extension/content/reader.js',
  'extension/content/library-modal.js',
  'extension/content/popup-guard.js',
  'mobile/inject/chrome-shim.js',
];

const GLOBALS = [
  { name: 'PanelFlowReader', provider: 'extension/content/reader.js' },
  { name: '__panelflowDetect', provider: 'extension/content/detect.js' },
];

/** The keys of `window.<global> = { … };` — plain, shorthand, or a getter. */
function exportsOf(src, global) {
  const m = src.match(new RegExp(`window\\.${global}\\s*=\\s*\\{([\\s\\S]*?)\\};`));
  assert.ok(m, `${global} is never assigned an object literal`);
  // The separator after the name is a lookahead, not a match: consuming it
  // would swallow the comma that introduces the next key, and every second
  // entry would go missing.
  return new Set(
    [...m[1].matchAll(/(?:^|[,{])\s*(?:get\s+)?([A-Za-z_$][\w$]*)\s*(?=[,:(}\n]|$)/g)]
      .map((k) => k[1]),
  );
}

/** Every `<global>.name` / `<global>?.name` read anywhere in a file. */
function usesOf(src, global) {
  const re = new RegExp(`${global}\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
  return [...src.matchAll(re)].map((m) => m[1]);
}

for (const { name, provider } of GLOBALS) {
  test(`every ${name} member used by a content script is exported`, () => {
    const provided = exportsOf(read(provider), name);
    for (const file of CALLERS) {
      for (const used of usesOf(read(file), name)) {
        assert.ok(provided.has(used), `${file} calls ${name}.${used}, which ${provider} `
          + `does not export (it has: ${[...provided].join(', ')}).`);
      }
    }
  });
}

// The same drift, one layer down: a content script reaches the worker by name
// too, only the name is a string in a message rather than a property. An
// unanswered `type` is not an error anywhere — the hub replies `unknown
// message` and the caller's `r?.chapters` quietly reads as undefined.

/** Every `{ type: 'x' }` a content script puts on the wire. */
function messagesSentBy(src) {
  return [...src.matchAll(/\btype:\s*'([a-zA-Z][\w]*)'/g)].map((m) => m[1]);
}

test('every message a content script sends is answered by somebody', () => {
  // Three places can answer, and the split is deliberate: the shared hub holds
  // what all three clients do, background.js holds what only Chrome can do, and
  // offline-store.js holds the saved-chapter messages.
  const answered = new Set();
  for (const [file, re] of [
    ['shared/panelflow-core.js', /case '([\w]+)':/g],
    // A handler is a property whose value is an async function; the depth it
    // sits at is not part of the contract, and offline-store.js's is nested one
    // IIFE deeper than background.js's anyway.
    ['extension/background.js', /^\s*([A-Za-z_$][\w$]*):\s*async\s*\(/gm],
    ['shared/offline-store.js', /^\s*([A-Za-z_$][\w$]*):\s*async\s*\(/gm],
  ]) {
    for (const m of read(file).matchAll(re)) answered.add(m[1]);
  }

  // The extension's own scripts only: the mobile shim speaks to the native
  // bridge, whose messages are a different vocabulary.
  for (const file of CALLERS.filter((f) => f.startsWith('extension/'))) {
    for (const type of messagesSentBy(read(file))) {
      assert.ok(answered.has(type),
        `${file} sends { type: '${type}' }, which nothing answers — add a case to `
        + 'shared/panelflow-core.js, or a handler to background.js\'s extras.');
    }
  }
});

test('every control in the settings panel has a default behind it', () => {
  // The panel's markup and DEFAULT_PREFS are two hand-kept lists of the same
  // thing. A control with no default starts undefined, which reads as off for a
  // checkbox and as an empty slider for a range — a setting that looks broken
  // rather than one that is missing.
  const src = read('extension/content/reader.js');
  const defaults = src.match(/const DEFAULT_PREFS = \{([\s\S]*?)\n  \};/);
  assert.ok(defaults, 'DEFAULT_PREFS is not where the guard expects it');
  // Comments first: half the keys in there are introduced by a paragraph
  // explaining why, and a comma followed by prose is not whitespace.
  const body = defaults[1].replace(/\/\/[^\n]*/g, '');
  const known = new Set(
    [...body.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*):/g)].map((m) => m[1]),
  );

  const used = [...src.matchAll(/data-pref="([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(used.length >= 10, 'the panel lost most of its controls');
  for (const key of used) {
    assert.ok(known.has(key), `the panel has a control for "${key}", which DEFAULT_PREFS `
      + `does not define (it has: ${[...known].join(', ')}).`);
  }
});

test('the reader still exposes the three entry points the rest of the app needs', () => {
  // Named rather than inferred: open/openText are the two kinds of chapter
  // there are, and isOpen is what the popup and the mobile toolbar label their
  // button from. Losing one is a feature disappearing, not a rename.
  const provided = exportsOf(read('extension/content/reader.js'), 'PanelFlowReader');
  for (const fn of ['open', 'openText', 'close', 'isOpen']) {
    assert.ok(provided.has(fn), `PanelFlowReader.${fn} is gone`);
  }
});
