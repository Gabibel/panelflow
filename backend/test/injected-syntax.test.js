// Does every injected file actually compile?
//
// Nothing in this repository asked that until now, and the gap is bigger than
// it sounds. The tests around these files lift *fragments* out of them with
// `new Function`, so a broken line three hundred rows away never shows; Metro
// carries them as a string and never parses them; and the extension only finds
// out in a browser nobody has open.
//
// What made it matter: a backtick inside an HTML comment, inside a template
// literal, in reader.js. It ended the string, and the file stopped parsing from
// that point on. On a phone that is not "the reader has a bug" — the shells
// hand the whole late set to the WebView as one script, so a syntax error
// anywhere in it means detect.js, library-modal.js and reader.js never run at
// all. The reported symptom was that the reader stopped appearing on every site
// at once, and that "add to library" was always offered and did nothing: no
// detection had happened, and there was no listener left to answer the tap.
//
// A try/catch around each file does not help. Those catch what a file throws
// while running; a file that does not compile never starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EARLY, LATE, generated } from '../../scripts/build-native-inject.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

/** Compiles, or fails with the file and the line the parser stopped at. */
const compiles = (source, name) => {
  try {
    // Compiled, never run: these files touch a DOM that does not exist here.
    // Parsing is the whole question.
    new Script(source, { filename: name });
  } catch (e) {
    assert.fail(`${name} does not parse: ${e.message}`);
  }
};

test('every content script the browser injects compiles', () => {
  const dir = join(root, 'extension', 'content');
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 5, 'the content directory did not list its scripts');
  for (const file of files) compiles(read('extension', 'content', file), `extension/content/${file}`);
});

test('every file the phones inject compiles', () => {
  // The mobile-only layer: the shim, the failure reporter, the translator and
  // the two React Native ones. `messages.js` is generated beside them.
  const dir = join(root, 'mobile', 'inject');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    compiles(read('mobile', 'inject', file), `mobile/inject/${file}`);
  }
  for (const file of readdirSync(join(root, 'native', 'inject'))) {
    compiles(read('native', 'inject', file), `native/inject/${file}`);
  }
});

test('every shared module compiles', () => {
  const dir = join(root, 'shared');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    compiles(read('shared', file), `shared/${file}`);
  }
});

test('the two blobs a phone is handed compile as one script each', () => {
  // The end of the chain, and the only test here that reproduces what a WebView
  // is actually given: one string per injection point, wrapped and concatenated.
  // A file that parses alone can still break the blob it is glued into — an
  // unbalanced comment, a stray backtick — and this is where that shows.
  const [{ content }] = generated();
  const blob = (name) => {
    const m = new RegExp(`export const ${name} = (".*?");\\n`, 's').exec(content);
    assert.ok(m, `${name} is not in the generated module`);
    return JSON.parse(m[1]);
  };
  compiles(blob('early'), 'the early blob');
  compiles(blob('late'), 'the late blob');

  // And it really is everything, not an empty string that would pass trivially.
  assert.ok(blob('late').length > 200000, 'the late blob is too small to hold the reader');
  assert.ok(EARLY.length >= 4 && LATE.length >= 6, 'the injection lists shrank unexpectedly');
});
