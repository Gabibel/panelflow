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
// `rn-adblock.js` is native-only for a related reason: Chrome, Safari and
// Android all refuse a request before it is made, from a list compiled outside
// the page. React Native's WebView has no such hook, so the same list has to be
// enforced from inside the page — a weaker position, and the file says so.
const NATIVE_ONLY = ['rn-bridge.js', 'rn-adblock.js'];

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

test('the translator goes in before anything that draws a label', () => {
  // The bug this exists to prevent was total and silent. `extension/i18n.js` is
  // the first content script the manifest injects; the mobile shells omitted it
  // for months, so `t` was undefined on every page they browsed. detect.js
  // loaded, then died on `t('pillReaderMode')` — no Reader Mode pill, ever —
  // and reader.js and library-modal.js died the same way at their first label.
  // Nothing was missing at load time, so nothing said anything.
  const speaks = ['detect.js', 'library-modal.js', 'reader.js'];
  for (const name of speaks) {
    const source = read('extension/content', name);
    assert.match(source, /(^|[^A-Za-z0-9_$.])t\(/,
      `${name} no longer calls t() — this test is now guarding nothing`);
    assert.ok(LATE.indexOf('i18n.js') > -1 && LATE.indexOf('i18n.js') < LATE.indexOf(name),
      `${name} is injected before the t() it calls`);
  }
  // And the catalogue before the file that reads it out.
  assert.ok(LATE.indexOf('messages.js') < LATE.indexOf('i18n.js'));
});

test('a browsed page may ask for exactly what the reader asks for', () => {
  // A WebView has no isolated world: `chrome-shim.js` runs in the same
  // JavaScript world as the site, so every message the reader can send, the
  // site can send too. `native/src/core.js` answers that with a list — and a
  // list is only safe while it is complete. A message added to the reader and
  // not to the list is a reader that quietly stops working on the phone; the
  // reverse, a name left on the list after the reader stopped sending it, is a
  // door held open for nothing.
  //
  // Read as text because that module imports React Native and cannot be loaded
  // here — the same reason mobile-shell.test.js reads Kotlin as text.
  const core = read('native/src/core.js');
  const listed = new Set(
    [...core.matchAll(/const PAGE_TYPES = new Set\(\[([\s\S]*?)\]\)/g)]
      .flatMap((m) => [...m[1].matchAll(/'([a-zA-Z]+)'/g)].map((q) => q[1])),
  );
  assert.ok(listed.size > 20, 'PAGE_TYPES was not found — this test is guarding nothing');

  const sent = new Set();
  for (const name of ['detect.js', 'library-modal.js', 'reader.js']) {
    for (const m of read('extension/content', name).matchAll(/type: '([a-zA-Z]+)'/g)) {
      sent.add(m[1]);
    }
  }
  for (const type of sent) {
    assert.ok(listed.has(type),
      `the reader sends "${type}" and PAGE_TYPES does not allow it`);
  }

  // The three that matter most, named so that deleting one is deliberate.
  for (const shut of ['auth', 'logout', 'setSettings', 'setAccountPrefs', 'syncNow']) {
    assert.ok(!listed.has(shut), `a page must never be able to send "${shut}"`);
  }
});

test('the store keys a page may read do not include the account token', () => {
  const core = read('native/src/core.js');
  const reads = core.match(/const PAGE_READS = new Set\(\[([\s\S]*?)\]\)/);
  const writes = core.match(/const PAGE_WRITES = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(reads && writes, 'PAGE_READS/PAGE_WRITES were not found');
  // `authToken` sits in the same store as `readerPrefs`, one `chrome.storage`
  // call away from any page the reader opens. This is the line that keeps it
  // out, and it is worth a test of its own.
  for (const secret of ['authToken', 'authUser', 'library', 'progress', 'accountPrefs']) {
    assert.ok(!reads[1].includes(`'${secret}'`), `a page may read ${secret}`);
    assert.ok(!writes[1].includes(`'${secret}'`), `a page may write ${secret}`);
  }
  // The backend's address is readable (detect.js needs it) and never writable.
  assert.ok(reads[1].includes("'settings'"));
  assert.ok(!writes[1].includes("'settings'"));
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
