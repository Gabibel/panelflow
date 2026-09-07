// The React Native client, checked the way the other two shells are.
//
// `mobile-shell.test.js` says why this kind of test exists: the phone apps
// cannot be compiled here, so what goes wrong silently is not a type error, it
// is drift — a file renamed in `extension/content/`, an injected script added to
// one shell and forgotten on another, a colour changed in the stylesheet and not
// in the copy of it React Native needs. Nothing fails at that moment. It fails
// on a device, weeks later, as a reader that does not open.
//
// This one has a real advantage over those: its shell is JavaScript, so the
// lists are imported rather than scraped out of Kotlin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EARLY, LATE, generated } from '../../scripts/build-native-inject.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

const androidPageScripts = read('android/app/src/main/java/dev/panelflow/PageScripts.kt');

/** The bare script names, in injection order, out of a Kotlin `listOf(...)`. */
function kotlinList(name) {
  const block = androidPageScripts.match(new RegExp(`${name} = listOf\\(([^)]*)\\)`, 's'));
  assert.ok(block, `${name} not found in PageScripts.kt`);
  return [...block[1].matchAll(/"inject\/([^"]+)"/g)].map((m) => m[1]);
}

// `rn-bridge.js` is the one file the other two shells have no equivalent of,
// because on those platforms the transport is native code: an
// `@JavascriptInterface` on Android, a `WKScriptMessageHandler` on iOS. Under
// React Native it is a script, so it is in the list — and nowhere else.
const NATIVE_ONLY = ['rn-bridge.js'];

test('the React Native shell injects what the other two shells inject', () => {
  // Order is not cosmetic: popup-guard.js has to land before the page can open
  // its first popunder, and chrome-shim.js before anything calls chrome.runtime.
  assert.deepEqual(EARLY.filter((n) => !NATIVE_ONLY.includes(n)), kotlinList('EARLY'));
  assert.deepEqual(LATE, kotlinList('LATE'));
});

test('the transport goes in before anything that might want to speak', () => {
  // report-failure.js and chrome-shim.js both look for a transport the moment
  // they run, and a shim that finds none answers `undefined` for the rest of
  // the session — a reader that never opens, with nothing in the log.
  assert.equal(EARLY[0], 'rn-bridge.js');
});

test('the injected bundle on disk is what the sources say it should be', () => {
  // The same guard the copies in `shared sources are in sync` get. This one is
  // a concatenation rather than a copy, and it is 260 kB of somebody else's
  // JavaScript — a stale build here is the reader from two weeks ago, running
  // on a phone, against a detection engine that has moved on.
  for (const { path, content } of generated()) {
    assert.ok(existsSync(path), `${path} is missing — run \`npm run sync:shared\``);
    assert.equal(readFileSync(path, 'utf8'), content,
      `${path} is stale — run \`npm run sync:shared\``);
  }
});

test('every script the shell claims to inject is really in the bundle', () => {
  const [{ content }] = generated();
  // Not a smoke test of the concatenation: `build-native-inject.mjs` writes
  // `throw new Error('missing from the build')` for nothing — a file it cannot
  // read throws at read time — but a file that is present and *empty* would
  // sail through and disable a script silently.
  for (const name of [...EARLY, ...LATE]) {
    assert.ok(content.includes(JSON.stringify(name).slice(1, -1)),
      `${name} is not named in the generated bundle`);
  }
  assert.ok(content.length > 200000, 'the bundle is too small to contain the reader');
});

test('the palette React Native draws with is the palette in the stylesheet', () => {
  // theme.js is the one duplication in that client a script does not maintain:
  // React Native has no CSS custom properties to read. So it is checked instead
  // — a colour changed in shared/theme.css and not there is how the four
  // surfaces once ended up with two palettes.
  const css = read('shared/theme.css');
  const js = read('native/src/theme.js');

  const cssValue = (name) => {
    const m = css.match(new RegExp(`--${name}:\\s*([^;]+);`));
    assert.ok(m, `--${name} is not in shared/theme.css`);
    return m[1].trim();
  };
  const jsValue = (block, key) => {
    const scope = js.match(new RegExp(`export const ${block} = \\{([^}]*)\\}`, 's'));
    assert.ok(scope, `${block} is not in native/src/theme.js`);
    const m = scope[1].match(new RegExp(`\\b${key}:\\s*'([^']+)'`));
    assert.ok(m, `${block}.${key} is not in native/src/theme.js`);
    return m[1].trim();
  };

  // The tokens both surfaces name. `surface-hi` is spelt surfaceHi there for
  // the same reason `--surface-hi` is spelt that way here: each language has
  // one way to write a name.
  const TOKENS = [
    ['bg', 'bg'], ['surface', 'surface'], ['surface-hi', 'surfaceHi'], ['line', 'line'],
    ['text', 'text'], ['muted', 'muted'], ['accent', 'accent'], ['danger', 'danger'],
    ['ok', 'ok'], ['warn', 'warn'], ['scrim', 'scrim'],
  ];
  for (const theme of ['dark', 'light']) {
    for (const [cssName, jsName] of TOKENS) {
      assert.equal(jsValue(theme, jsName), cssValue(`${theme}-${cssName}`),
        `${theme}.${jsName} has drifted from --${theme}-${cssName}`);
    }
  }
  // The one colour that is the same in both themes, because "you have something
  // to read" is information rather than atmosphere.
  assert.equal(js.match(/UNREAD = '([^']+)'/)[1], cssValue('unread'));
});

test('every sentence the client draws is in a directory the i18n scan reads', () => {
  // i18n.test.js scans `native/src`, and only that. A screen put anywhere else
  // in that tree would draw labels nobody checks against the locale files —
  // which is a blank button in French and nothing failing here.
  const app = read('native/App.js');
  assert.match(app, /\.\/src\//, 'native/App.js should hand straight over to src/');
  assert.ok(!/\bt\(/.test(app), 'native/App.js must not draw sentences of its own');
});
