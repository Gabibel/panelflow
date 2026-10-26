// The in-app browser says so when a site has nothing to show (iPhone tests,
// 2026-10-22).
//
// Two pages left the reader in front of a black screen with no word on it:
// sushiscan.fr answered "504 Gateway Time-out", and asurascans.com, which was
// up, never became visible. The browser handled neither: no `onHttpError`, and
// nothing looked at whether the page showed anything once it had loaded, so
// the WebView's own background (the dark theme's) was all there was to see.
// asurascans.com sends its <body> with an inline `opacity:0` and relies on its
// stylesheet, or a three-second timer, to reveal it: a page that loads without
// either stays an almost black rectangle.
//
// The decision is a pure function; the wiring is read from the screen, the
// way renderer-gone.test.js reads it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

// Imported, not read: the test fails on a missing module the same way it fails
// on a wrong answer.
const helper = () => import('../../native/src/page-trouble.js');

const SHOWN = { readerOpen: false, text: 1200, media: 14, opacity: 1, hidden: false };

test('a 5xx on the page itself is a site that does not answer, with its code', async () => {
  const { trouble } = await helper();
  assert.deepEqual(trouble({ httpStatus: 504 }), { kind: 'server', status: 504 });
  assert.deepEqual(trouble({ httpStatus: 500 }), { kind: 'server', status: 500 });
  assert.deepEqual(trouble({ httpStatus: 503, probe: SHOWN }), { kind: 'server', status: 503 },
    'the gateway page has words on it, and it is still an error');
  // A 404 is the site's own page, with its own words and links back: shown.
  assert.equal(trouble({ httpStatus: 404, probe: SHOWN }), null);
  assert.equal(trouble({ httpStatus: 200, probe: SHOWN }), null);
});

test('a page that loads and shows nothing is not left black', async () => {
  const { trouble } = await helper();
  // asurascans.com: plenty of text, all of it under an opacity of 0.
  assert.deepEqual(trouble({ probe: { ...SHOWN, opacity: 0 } }), { kind: 'empty' });
  assert.deepEqual(trouble({ probe: { ...SHOWN, hidden: true } }), { kind: 'empty' });
  assert.deepEqual(trouble({ probe: { ...SHOWN, text: 0, media: 0 } }), { kind: 'empty' });
  // A gallery with no caption is a page; so is a text with no picture.
  assert.equal(trouble({ probe: { ...SHOWN, text: 0 } }), null);
  assert.equal(trouble({ probe: { ...SHOWN, media: 0 } }), null);
  // The reader covers the page on purpose: nothing to judge underneath.
  assert.equal(trouble({ probe: { readerOpen: true, text: 0, media: 0, opacity: 0, hidden: true } }), null);
  assert.equal(trouble({}), null, 'nothing known yet is not an error');
});

test('a load that fails outright says the site does not answer', async () => {
  const { trouble } = await helper();
  assert.deepEqual(trouble({ loadError: true }), { kind: 'unreachable' });
});

test('the messages say what happened, in French and in English', async () => {
  const fr = JSON.parse(read('shared', '_locales', 'fr', 'messages.json'));
  const en = JSON.parse(read('shared', '_locales', 'en', 'messages.json'));
  const { troubleText } = await helper();
  const say = (cat) => (key, subs) => (cat[key].message).replace(/\$([1-9])/g, (_, n) => subs[n - 1]);
  assert.equal(troubleText({ kind: 'server', status: 504 }, say(fr)).title, 'Le site ne répond pas (504)');
  assert.equal(troubleText({ kind: 'server', status: 504 }, say(en)).title, 'The site is not responding (504)');
  for (const kind of ['server', 'unreachable', 'empty']) {
    for (const cat of [fr, en]) {
      const said = troubleText({ kind, status: 502 }, say(cat));
      assert.ok(said.title && said.hint, `${kind}: a title and a line of explanation`);
    }
  }
  assert.equal(fr.actionRetry.message, 'Réessayer');
});

test('the browser listens for all three, and covers the black screen with a way out', () => {
  const screen = read('native', 'src', 'screens', 'BrowserScreen.js');
  assert.match(screen, /onHttpError=\{/, 'a 504 from the site is shown as if it were a page');
  assert.match(screen, /onError=\{/, 'a site that does not answer at all');
  assert.match(screen, /renderError=\{/, "react-native-webview's own English error view");
  assert.match(screen, /PROBE/, 'nothing looks at whether the page shows anything');
  assert.match(screen, /trouble\(/);
  assert.match(screen, /t\('actionRetry'\)/, 'no Retry button');
  assert.match(screen, /accessibilityRole="alert"/, 'VoiceOver is not told');
});
