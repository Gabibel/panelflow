// The injected content scripts, concatenated into one JavaScript module the
// React Native client can hand to a WebView.
//
// The twin of Gradle's `bundleWebAssets` + PageScripts.kt, and of
// `ios/Scripts/bundle-assets.sh` + PageScripts.swift, for the third shell. It
// exists for the same reason those do: `detect.js`, `reader.js` and
// `library-modal.js` are the extension's own files and are never forked — but a
// Metro bundle has no `assets/` directory to read them out of at runtime, so
// they have to arrive as a string that was baked in at build time.
//
// Two blobs, the same split both native shells make:
//   `early`  runs before the page's own scripts (popup guard, chrome shim)
//   `late`   runs once there is a document to look at (the engine, the reader)
//
// Ordering is not cosmetic — see PageScripts.kt, which says why — so the lists
// below are checked against the Kotlin and Swift ones by
// `backend/test/native-shell.test.js`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generated as messages } from './build-messages.mjs';
import { loadList } from './build-adblock.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Where a bare script name in the lists below actually lives. */
const SOURCES = {
  // Native-only: the bridge that turns `PanelFlowNative.post` into a
  // react-native-webview message. The counterpart of the `@JavascriptInterface`
  // Android adds and the `WKScriptMessageHandler` iOS registers — neither of
  // which exists here, so it is written in JavaScript instead.
  'rn-bridge.js': join(root, 'native', 'inject', 'rn-bridge.js'),
  // Native-only for the same reason: Chrome, Safari and Android all block a
  // request before it leaves, from a list compiled outside the page. React
  // Native's WebView offers no such hook, so the list has to be enforced from
  // inside the page — see the file itself, which says what that costs.
  'rn-adblock.js': join(root, 'native', 'inject', 'rn-adblock.js'),
  'report-failure.js': join(root, 'mobile', 'inject', 'report-failure.js'),
  'chrome-shim.js': join(root, 'mobile', 'inject', 'chrome-shim.js'),
  // The `t()` the three files below it cannot draw a single label without.
  // (`messages.js`, the catalogue it reads, has no path here on purpose — see
  // `read` below.)
  'i18n.js': join(root, 'mobile', 'inject', 'i18n.js'),
  'series-match.js': join(root, 'shared', 'series-match.js'),
  'site-rules.js': join(root, 'shared', 'site-rules.js'),
  'popup-guard.js': join(root, 'extension', 'content', 'popup-guard.js'),
  'detect.js': join(root, 'extension', 'content', 'detect.js'),
  'library-modal.js': join(root, 'extension', 'content', 'library-modal.js'),
  'reader.js': join(root, 'extension', 'content', 'reader.js'),
  'reader.css': join(root, 'extension', 'content', 'reader.css'),
};

/**
 * Before the page's own scripts.
 *
 * `rn-bridge.js` leads, because `report-failure.js` and `chrome-shim.js` both
 * look for a transport the moment they run and a shim that finds none is a shim
 * that silently answers `undefined` for the rest of the session.
 */
export const EARLY = ['rn-bridge.js', 'rn-adblock.js', 'report-failure.js',
  'popup-guard.js', 'chrome-shim.js'];

/** Once there is a document. Same list, same order, as the two native shells. */
export const LATE = ['messages.js', 'i18n.js', 'series-match.js', 'site-rules.js',
  'detect.js', 'library-modal.js', 'reader.js'];

/**
 * One injected file's source.
 *
 * `messages.js` is the exception, and deliberately: it is itself generated,
 * from `shared/_locales/`, by the script this one imports. Reading the copy on
 * disk would make this build depend on the order two generators happen to run
 * in — and the first run on a fresh clone would fail, because the file it wants
 * has not been written yet.
 */
const read = (name) => (name === 'messages.js'
  ? messages()[0].content
  : readFileSync(SOURCES[name], 'utf8'));

// What the catch does: tell the user, through report-failure.js. The fallback
// matters — this same clause guards report-failure.js itself, and a console line
// is all that is left when the reporter is what failed.
const report = (name) =>
  `if(window.PanelFlowFailed)window.PanelFlowFailed(${JSON.stringify(name)},e);` +
  `else console.warn('panelflow: ${name} failed',e)`;

// Each file is wrapped so a failure in one does not stop the next: a scan site
// that breaks detect.js must not also cost the user the reader.
const concat = (names) => names
  .map((name) => `try{\n${read(name)}\n}catch(e){${report(name)}}`)
  .join('\n');

/**
 * The blocked hosts, as one line the blocker reads.
 *
 * Written into the build rather than fetched at runtime because it has to be in
 * force before the page's first request, and a list that arrives a round trip
 * late has already let the popunder through. `/api/adblock` still updates the
 * other three surfaces without a release; this copy travels with the build,
 * which is the same trade the extension makes with its bundled ruleset.
 */
const blockedHosts = () =>
  `window.PanelFlowBlockedHosts=${JSON.stringify(loadList().entries.map((e) => e.host))};`;

// The extension gets reader.css from its manifest; here it has to be put in by
// hand, and idempotently — this runs again on every in-page navigation.
const styleInjector = () => `
try{
  if(!document.getElementById('panelflow-reader-css')){
    var s=document.createElement('style');
    s.id='panelflow-reader-css';
    s.textContent=${JSON.stringify(read('reader.css'))};
    (document.head||document.documentElement).appendChild(s);
  }
}catch(e){${report('reader.css')}}`;

/**
 * The module, as `[{ path, content }]` — the shape `scripts/sync-shared.mjs`
 * collects and `npm run sync:shared -- --check` compares against disk.
 *
 * JSON and not a template literal: these are 240 kB of somebody else's
 * JavaScript, containing backticks and `${`, and an escaping bug here would be a
 * syntax error nobody sees until a phone loads a page.
 */
export function generated() {
  const body = [
    '// Generated by scripts/build-native-inject.mjs — do not edit.',
    '// The extension\'s content scripts, baked in for the React Native shell.',
    `export const early = ${JSON.stringify(`${blockedHosts()}
${concat(EARLY)}`)};`,
    `export const late = ${JSON.stringify(`${concat(LATE)}\n${styleInjector()}`)};`,
    '',
  ].join('\n');
  return [{ path: join(root, 'native', 'generated', 'injected.js'), content: body }];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const { path, content } of generated()) {
    console.log(`${path} — ${(content.length / 1024).toFixed(0)} kB`);
  }
}
