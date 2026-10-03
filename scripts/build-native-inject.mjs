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
import { minify_sync as minify } from 'terser';
import { catalogue } from './build-messages.mjs';
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
  // What an episode page is, for the detector's "Add to library": the same
  // answer the extension's video bar gives, so an anime added from the phone's
  // browser gets the same title and season as one added from the computer.
  'episode-page.js': join(root, 'shared', 'episode-page.js'),
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

/**
 * Once there is a document. Same list, same order, as the two native shells.
 *
 * No `video-speed.js` in any phone shell. The store apps follow what is
 * watched and never play it (docs/roadmap-medias.md §H0, "suivi seulement"):
 * a player bar on a streaming site is the one thing neither store accepts from
 * an app, and the extension, where it stays, is not an app store product.
 */
export const LATE = ['messages.js', 'i18n.js', 'series-match.js', 'site-rules.js',
  'episode-page.js', 'detect.js', 'library-modal.js', 'reader.js'];

/**
 * What a sub-frame gets: nothing late. The reader, the detector and the sheet
 * stay in the top document, and the one script that ran in frames — the
 * player's speed control — is not part of the phone apps any more. The early
 * set (the popup guard, the blocker) still runs in every frame: an advert's
 * iframe is exactly where it is needed.
 */
export const LATE_IN_FRAMES = [];

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
  ? pageMessages()
  : readFileSync(SOURCES[name], 'utf8'));

/**
 * The sentences a page script can ask for, and only those.
 *
 * The whole catalogue, both languages, was 96 kB of the bundle parsed into
 * every page the phone's browser opens, for the eighth of it the reader, the
 * detector and the sheet ever draw (October 2026, "pas de gros chargements").
 * A key is kept when one of those files names it in quotes anywhere, which
 * over-keeps rather than under-keeps, and a quoted prefix that ends in `_`
 * ('folder_' + id, 'medium_' + m) keeps its whole family. A key dropped by
 * mistake would show as its own name on a page, which inject-i18n.test.js
 * checks cannot happen.
 */
export function pageKeys(messagesByLang = catalogue()) {
  const known = Object.keys(messagesByLang.en);
  const keep = new Set();
  for (const name of LATE) {
    if (name === 'messages.js' || name === 'i18n.js') continue;
    const src = readFileSync(SOURCES[name], 'utf8');
    for (const [, word] of src.matchAll(/['"`]([A-Za-z][A-Za-z0-9_]*)['"`]/g)) {
      if (word.endsWith('_')) for (const k of known) { if (k.startsWith(word)) keep.add(k); }
      else if (word in messagesByLang.en) keep.add(word);
    }
  }
  return keep;
}

function pageMessages() {
  const all = catalogue();
  const keep = pageKeys(all);
  const subset = Object.fromEntries(Object.entries(all).map(([lang, entries]) => [
    lang, Object.fromEntries(Object.entries(entries).filter(([k]) => keep.has(k))),
  ]));
  return `globalThis.PanelFlowMessages = ${JSON.stringify(subset)};`;
}

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
const blockedHosts = () => {
  const entries = loadList().entries;
  return [
    `window.PanelFlowBlockedHosts=${JSON.stringify(entries.map((e) => e.host))};`,
    // The list's own second column, and it is not a detail. `images: false` —
    // 47 of the 72 hosts — means "block this host's scripts and frames, never
    // its images", which is what stops a blocker from erasing the panels of a
    // chapter served from a CDN that also carries something on the list. The
    // Chrome ruleset spells it `resourceTypes` and Safari's `load-type`; here
    // it is a second array, because the enforcement is in the page.
    `window.PanelFlowBlockedImageHosts=${JSON.stringify(
      entries.filter((e) => e.images).map((e) => e.host))};`,
  ].join('\n');
};

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
 * The same code without its comments and indentation, and nothing else
 * changed: no renaming, no rewriting (`compress` and `mangle` are off, so this
 * is the parse and the print, and a stack trace still names the functions).
 *
 * The sources are written to be read, and half their weight is the reading:
 * 507 kB went into every page the phone's browser opened, parsed before the
 * page could be read (owner's request, October 2026: "optimise le code"). It
 * is 282 kB this way. The version is pinned in package.json, so the same
 * sources print the same bundle on every machine and the drift check holds.
 */
const lean = (code) => minify(code, {
  compress: false,
  mangle: false,
  format: { comments: false },
}).code;

/**
 * The module, as `[{ path, content }]` — the shape `scripts/sync-shared.mjs`
 * collects and `npm run sync:shared -- --check` compares against disk.
 *
 * JSON and not a template literal: these are 240 kB of somebody else's
 * JavaScript, containing backticks and `${`, and an escaping bug here would be a
 * syntax error nobody sees until a phone loads a page.
 */
export function generated() {
  const entries = loadList().entries;
  const body = [
    '// Generated by scripts/build-native-inject.mjs — do not edit.',
    '// The extension\'s content scripts, baked in for the React Native shell.',
    `export const early = ${JSON.stringify(lean(`${blockedHosts()}
${concat(EARLY)}`))};`,
    `export const late = ${JSON.stringify(lean(
      `if(window.top===window){\n${concat(LATE)}\n${styleInjector()}\n}${
        LATE_IN_FRAMES.length ? `else{\n${concat(LATE_IN_FRAMES)}\n}` : ''}`))};`,
    // The same list again, as data this time. The page enforces it from the
    // inside (`rn-adblock.js`); the shell needs it too, to refuse a whole
    // *navigation* to one of these hosts — which is the ad that renders nothing
    // at all, it simply takes the window somewhere else, and on a phone that
    // somewhere is often the App Store.
    `export const blockedHosts = ${JSON.stringify(entries.map((e) => e.host))};`,
    '',
  ].join('\n');
  return [{ path: join(root, 'native', 'generated', 'injected.js'), content: body }];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const { path, content } of generated()) {
    console.log(`${path} — ${(content.length / 1024).toFixed(0)} kB`);
  }
}
