// The in-app browser comes back when its page process dies (QA P6).
//
// On the emulator, the WebView's renderer died during a 150-chapter marathon
// and the browser stayed an empty grey frame with nothing to say: Android
// kills that process to free memory, iOS terminates a WKWebView's content
// process the same way, and react-native-webview only keeps the app alive.
// The decision is a pure function; the wiring is read from the screen, the
// way native-polish.test.js reads the app.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldRevive, REVIVE_WINDOW_MS, REVIVE_MAX } from '../../native/src/renderer-gone.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

test('a page whose process died is brought back, but not in a loop', () => {
  const now = 1_000_000;
  assert.equal(shouldRevive([], now), true);
  assert.equal(shouldRevive([now - 5000], now), true);
  // A page that kills its renderer at every load: twice, then no more.
  assert.equal(REVIVE_MAX, 2);
  assert.equal(shouldRevive([now - 5000, now - 1000], now), false);
  // An hour of reading with one loss now and then is not a loop.
  assert.equal(shouldRevive([now - REVIVE_WINDOW_MS - 1, now - REVIVE_WINDOW_MS - 10], now), true);
  assert.equal(shouldRevive(undefined, now), true);
});

test('the browser answers both platforms, with a fresh WebView on the page it showed', () => {
  const screen = read('native', 'src', 'screens', 'BrowserScreen.js');
  assert.match(screen, /onRenderProcessGone=\{\(e\) => revive\(/, 'Android: a lost renderer leaves a grey frame');
  assert.match(screen, /onContentProcessDidTerminate=\{\(\) => revive\(/, 'iOS: a terminated content process leaves an empty page');
  assert.match(screen, /key=\{life\}/, 'the same dead WebView would be kept');
  const body = screen.slice(screen.indexOf('const revive = (why) =>'), screen.indexOf('const revive = (why) =>') + 700);
  assert.match(body, /shouldRevive\(revivals\.current\)/, 'no guard against a reload loop');
  assert.match(body, /onClose\?\.\(\)/, 'past the guard, the browser must close rather than stay grey');
  assert.match(body, /go\(back\)/, 'the page it showed is not the one reloaded');
  assert.match(body, /setLife\(/);
  assert.match(body, /diagnostics\.note\('webview'/, 'a loss nobody can see in a report');
});
