// Copies the shared/ scripts each client needs into that client's own tree, and
// builds the per-platform ad-block lists out of shared/adblock-list.json.
//
// Chrome can only load content scripts from inside the extension directory, and
// a WebView can only load assets from inside the app bundle, so a file used by
// the server, the extension and the mobile shells has to exist several times.
// This script makes every copy generated rather than maintained, and
// `shared sources are in sync` in the backend test suite fails if one is stale.
//
//   npm run sync:shared
//   npm run sync:shared -- --check   (exit 1 instead of writing)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generated } from './build-adblock.mjs';
import { generated as messages } from './build-messages.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SHARED_FILES = [
  'series-match.js', 'panelflow-core.js', 'compat.js', 'offline-store.js', 'folders.js',
  'site-rules.js', 'prefs.js',
];

/**
 * The sentences, and the one tree that reads them as a document.
 *
 * Chrome resolves `__MSG_…__` in a manifest against `_locales/` at the root of
 * the extension and nowhere else, so the extension's copy has to be JSON, at
 * that path, spelt that way. The other two surfaces cannot fetch a document at
 * all before they need it — see scripts/build-messages.mjs — and take a
 * generated script instead.
 *
 * The source moved out of the extension when the website and the phone started
 * speaking too: three surfaces sharing one sentence is the same problem as
 * three surfaces sharing one palette, and `shared/` is where that is answered.
 */
export const LOCALE_FILES = [
  join('_locales', 'en', 'messages.json'),
  join('_locales', 'fr', 'messages.json'),
];

/**
 * The typeface, and the licence that has to travel with it.
 *
 * These are bytes, not text, and they are copied for the same reason the
 * scripts are: `theme.css` names them with a URL relative to itself, so every
 * tree that has a copy of `theme.css` needs them sitting next to it. Any target
 * that takes `theme.css` takes these — see `copies()`, which pairs them rather
 * than trusting three lists to be edited together.
 *
 * Three faces and no more: Plex Sans at 400 and 600, and Plex Sans Condensed at
 * 600 for cover letters and chapter numbers. `font-synthesis: none` in
 * theme.css means the browser never fakes a weight we did not ship, so adding a
 * fourth file is a decision to be made on purpose rather than by writing 700
 * somewhere.
 */
export const FONT_FILES = [
  'IBMPlexSans-Regular.woff2',
  'IBMPlexSans-SemiBold.woff2',
  'IBMPlexSansCondensed-SemiBold.woff2',
  // SIL Open Font License 1.1: the notice is part of the font, so it ships
  // wherever the font ships — including inside the .crx and the app bundle.
  'OFL.txt',
];

/**
 * Where each client keeps its generated copies, and which files it needs.
 * The extension's service worker `importScripts`es its three; the mobile worker
 * WebView loads all of them with <script> tags.
 *
 * `compat.js` is the one the extension does not take: it answers "would the
 * reader work here?" from markup alone, which only the mobile app needs — the
 * extension is already on the page and asks the DOM.
 *
 * `library-view.js` is how a shelf is ordered and narrowed, so every client
 * that draws one takes it — including the phone, which used to carry its own
 * copy of the arithmetic and grew its own idea of what "new" meant. It is not
 * in SHARED_FILES because the headless mobile worker has no shelf to draw; the
 * phone's UI WebView loads it from the same folder by name.
 *
 * `folders.js` goes everywhere, because everywhere has to agree that a series
 * filed under "cat:abc" is still, say, being read.
 *
 * `site-rules.js` follows the same rule for the same reason: which site a page
 * belongs to has to be one answer, whether it is being asked of a live DOM in a
 * content script or of raw markup on the server.
 *
 * `adblock.js` is the extension's alone, for now: it turns a filter list into
 * declarativeNetRequest rules, and the phones have no rule engine to feed —
 * Android matches hostnames by hand and Safari compiles its own list, both from
 * the generated files below.
 *
 * `theme.css` is not a script and goes everywhere a page is drawn. It is the
 * only place a colour is written, so a client that does not take it is a client
 * whose palette will drift — which is exactly how the four surfaces ended up
 * with two palettes before it existed. `theme.js` travels with it: it is the
 * one line of script that decides which of the two palettes in that file is
 * showing, and it has to run in <head> on every page that links it.
 */
export const TARGETS = [
  {
    dir: join(root, 'extension', 'shared'),
    files: ['series-match.js', 'panelflow-core.js', 'offline-store.js', 'library-view.js',
      'folders.js', 'site-rules.js', 'adblock.js', 'prefs.js', 'theme.css', 'theme.js'],
  },
  { dir: join(root, 'mobile', 'www', 'shared'),
    files: [...SHARED_FILES, 'library-view.js', 'theme.css', 'theme.js', 'i18n.js'] },
  { dir: join(root, 'web', 'shared'),
    files: ['library-view.js', 'folders.js', 'prefs.js', 'theme.css', 'theme.js', 'i18n.js'] },
  // Not `extension/shared`: `_locales` is a reserved name Chrome only looks for
  // beside the manifest.
  { dir: join(root, 'extension'), files: LOCALE_FILES },
];

export const sourcePath = (name) => join(root, 'shared', name);

// --- where the extension is allowed to run ----------------------------------
//
// The manifest used to say `<all_urls>`, which meant five content scripts on
// the bank, the mail and everything else, and an install prompt that says so.
// It runs on the sites the rules file names instead, and the code below is what
// turns those names into Chrome's own syntax — rather than a second list
// somebody has to remember to edit.
//
// `*://*.example.com/*` covers the apex as well as the subdomains, which is
// what survives a site moving to `ww6.` overnight — the same reason the rules
// file keys are written `*.example.com` in the first place.
//
// A site the rules file learns about later is not lost: the extension asks for
// it from the popup, one origin at a time, out of `optional_host_permissions`.
// That is the half of this that lets the rules file go on being updatable
// server-side while a manifest can only change by republishing.
const MANIFEST = join(root, 'extension', 'manifest.json');

/**
 * Every site the rules file names, as a Chrome match pattern, sorted.
 *
 * Both lists, because both are sites the extension has to run on — `domains`
 * for the reader, `videoDomains` for the speed control and the ad blocking. The
 * two are separate in the rules file and must stay so: an entry under `domains`
 * is worth `knownDomain: 100`, which on an episode page would put a Reader Mode
 * pill over a video. One manifest, two reasons to be there.
 *
 * Keys beginning with `_` are notes to whoever edits that file, not hostnames.
 */
export function hostMatches() {
  const rules = JSON.parse(readFileSync(join(root, 'shared', 'detection-rules.json'), 'utf8'));
  const named = [...Object.keys(rules.domains || {}), ...Object.keys(rules.videoDomains || {})];
  const hosts = named.filter((key) => !key.startsWith('_')).map((key) => key.replace(/^\*\./, ''));
  return [...new Set(hosts)].sort().map((h) => `*://*.${h}/*`);
}

/**
 * The manifest with its host lists rewritten from `hostMatches()`.
 *
 * A text rewrite and not a re-serialisation: the manifest is hand-formatted,
 * and running it through JSON.stringify would rewrite every line of a file
 * whose diffs are worth reading. Only the arrays are touched, and the entry
 * naming PanelFlow's own site is left alone — that one is a fixed origin, not a
 * scan site, and site-bridge.test.js is what guards it.
 */
export function manifestHosts() {
  const before = readFileSync(MANIFEST, 'utf8');
  const nl = before.indexOf('\r\n') === -1 ? '\n' : '\r\n';
  const list = hostMatches();
  const content = before.replace(
    /^([ \t]*)"(host_permissions|matches)": \[[^\]]*\]/gm,
    (whole, indent, key) => (/panelflow|localhost/.test(whole) ? whole : [
      `${indent}"${key}": [`,
      ...list.map((m, i) => `${indent}  ${JSON.stringify(m)}${i === list.length - 1 ? '' : ','}`),
      `${indent}]`,
    ].join(nl)));
  return { path: MANIFEST, content };
}

/** Every generated copy, as `{ name, path }`. */
export function copies() {
  return TARGETS.flatMap((t) => [
    ...t.files.map((name) => ({ name, path: join(t.dir, name) })),
    // A tree that draws a page needs the faces that page asks for; one that
    // only runs scripts does not.
    ...(t.files.includes('theme.css')
      ? FONT_FILES.map((f) => ({ name: join('fonts', f), path: join(t.dir, 'fonts', f) }))
      : []),
  ]);
}

/**
 * Everything this script owns: the verbatim copies above, plus the ad-block
 * lists, which are not copies but translations of one list into Chrome's and
 * Safari's syntaxes. Same contract either way — the file on disk is output, and
 * the only place to change it is the source.
 */
function outputs() {
  return [
    // Read as bytes: two of the copies are a typeface, and decoding a woff2 as
    // text would turn every byte it cannot read into the same replacement
    // character — which is how two different fonts compare equal.
    ...copies().map(({ name, path }) => ({ path, content: readFileSync(sourcePath(name)) })),
    ...generated(),
    // The same sentences again, as a script, for the two surfaces that cannot
    // read the documents above.
    ...messages(),
    // Not a copy either: the sites the extension may inject into, written into
    // the manifest in Chrome's syntax. Adding a domain to the rules file and
    // forgetting the manifest is how a site PanelFlow claims to support quietly
    // stops working.
    manifestHosts(),
  ];
}

/** Paths whose generated file differs from what it should be; writes them unless `check`. */
export function sync({ check = false } = {}) {
  const stale = [];
  for (const { path, content } of outputs()) {
    // `content` is a Buffer for the copies and a string for the generated
    // lists; Buffer.from() puts both on the same footing before comparing.
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    if (existsSync(path) && readFileSync(path).equals(bytes)) continue;
    stale.push(path.slice(root.length + 1).replace(/\\/g, '/'));
    if (!check) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
    }
  }
  return stale;
}

// Only when run as a command. The test suite imports the paths above to check
// the copies are current — importing must not quietly repair them, or the
// check would always pass.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const check = process.argv.includes('--check');
  const stale = sync({ check });
  if (check && stale.length) {
    console.error(`out of date: ${stale.join(', ')} — run \`npm run sync:shared\``);
    process.exit(1);
  }
  console.log(stale.length ? `synced ${stale.join(', ')}` : 'shared/ already in sync');
}
