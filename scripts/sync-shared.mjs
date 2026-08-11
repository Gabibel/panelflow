// Copies the shared/ scripts each client needs into that client's own tree.
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

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SHARED_FILES = [
  'series-match.js', 'panelflow-core.js', 'compat.js', 'offline-store.js', 'folders.js',
  'site-rules.js',
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
 * `library-view.js` goes the other way: it is how a shelf is ordered and
 * narrowed, so the two clients that draw a shelf take it and the headless
 * mobile worker — whose UI is native — does not.
 *
 * `folders.js` goes everywhere, because everywhere has to agree that a series
 * filed under "cat:abc" is still, say, being read.
 *
 * `site-rules.js` follows the same rule for the same reason: which site a page
 * belongs to has to be one answer, whether it is being asked of a live DOM in a
 * content script or of raw markup on the server.
 */
export const TARGETS = [
  {
    dir: join(root, 'extension', 'shared'),
    files: ['series-match.js', 'panelflow-core.js', 'offline-store.js', 'library-view.js',
      'folders.js', 'site-rules.js'],
  },
  { dir: join(root, 'mobile', 'www', 'shared'), files: SHARED_FILES },
  { dir: join(root, 'web', 'shared'), files: ['library-view.js', 'folders.js'] },
];

export const sourcePath = (name) => join(root, 'shared', name);

/** Every generated copy, as `{ name, path }`. */
export function copies() {
  return TARGETS.flatMap((t) => t.files.map((name) => ({ name, path: join(t.dir, name) })));
}

/** Paths whose copy differs from the source; writes them unless `check`. */
export function sync({ check = false } = {}) {
  const stale = [];
  for (const { name, path } of copies()) {
    const src = readFileSync(sourcePath(name), 'utf8');
    if (existsSync(path) && readFileSync(path, 'utf8') === src) continue;
    stale.push(path.slice(root.length + 1).replace(/\\/g, '/'));
    if (!check) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, src);
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
