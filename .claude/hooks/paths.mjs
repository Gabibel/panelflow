// Which files in this repo are output rather than source.
//
// Nothing here is a list: `scripts/sync-shared.mjs` already knows every copy it
// writes, and `build-adblock.mjs` knows the two lists it translates. Importing
// them means a new target in `TARGETS` is guarded the moment it is added, with
// nothing to remember here. (Importing is safe — sync-shared only acts when it
// is `process.argv[1]`.)
//
// The one thing they do not own is `ios/Generated/`, which comes out of
// `ios/Scripts/bundle-assets.sh`, so it is named by prefix below.
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(join(fileURLToPath(import.meta.url), '..', '..', '..'));

/**
 * Every file a generator owns, mapped to the source to edit instead, plus the
 * prefixes owned wholesale.
 *
 * The two kinds do not answer the question the same way. A copy is its source
 * under another name, so `extension/shared/foo.js` points at `shared/foo.js`.
 * The ad-block lists are translations — one list becomes Chrome's syntax and
 * Safari's — so both point back at the single list they came from.
 */
export async function generatedPaths() {
  const { copies } = await import('../../scripts/sync-shared.mjs');
  const { generated, listPath } = await import('../../scripts/build-adblock.mjs');
  const files = new Map();
  for (const { name, path } of copies()) files.set(resolve(path), rel(join(root, 'shared', name)));
  for (const { path } of generated()) files.set(resolve(path), rel(listPath));
  return { files, prefixes: [resolve(join(root, 'ios', 'Generated')) + sep] };
}

/** Is `file` under `shared/` — the hand-written side of the copies? */
export function isSharedSource(file) {
  return resolve(file).startsWith(resolve(join(root, 'shared')) + sep);
}

/** Repo-relative, forward-slashed, for messages. */
export function rel(file) {
  return resolve(file).slice(root.length + 1).replace(/\\/g, '/');
}
