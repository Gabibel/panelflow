// What a screen reader says for the pill: its words, not "open book emoji".
//
// The QA re-test of the third round (September 2026) found the book at the
// head of the pill's accessible name. It was moved into an aria-hidden span —
// and put straight back by the page-by-page walk, which rewrites the pill as it
// counts pages and used to restore it as one string, glyph included.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const detect = readFileSync(join(root, 'extension', 'content', 'detect.js'), 'utf8');

test('the pill is labelled in one place, with the book hidden from its name', () => {
  const at = detect.indexOf('function labelPill(pill)');
  assert.ok(at !== -1, 'labelPill is gone');
  const body = detect.slice(at, detect.indexOf('\n  }\n', at));
  assert.match(body, /glyph\.setAttribute\('aria-hidden', 'true'\)/);
  assert.match(body, /pill\.replaceChildren\(glyph, t\('pillReaderMode'\)\)/);
});

test('nothing writes the book back into the pill as text', () => {
  assert.doesNotMatch(detect, /pill\.textContent = `📖/);
  // Built, and restored after a walk: both through the one labeller.
  assert.ok((detect.match(/labelPill\(pill\)/g) || []).length >= 2);
});
