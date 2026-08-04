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

test('the reader still exposes the three entry points the rest of the app needs', () => {
  // Named rather than inferred: open/openText are the two kinds of chapter
  // there are, and isOpen is what the popup and the mobile toolbar label their
  // button from. Losing one is a feature disappearing, not a rename.
  const provided = exportsOf(read('extension/content/reader.js'), 'PanelFlowReader');
  for (const fn of ['open', 'openText', 'close', 'isOpen']) {
    assert.ok(provided.has(fn), `PanelFlowReader.${fn} is gone`);
  }
});
