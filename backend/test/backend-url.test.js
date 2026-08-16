// Where PanelFlow talks to, written down once.
//
// Every client ships a fallback backend URL, because a fresh install has no
// server of its own and one pointed at a dead port looks broken rather than
// signed out. That fallback was in seven files, in four languages, agreeing
// with each other by hand: Gradle reads its copy at compile time, the iOS plist
// at launch, NativeMessages when the plist is missing, worker.js when nothing
// came in on the query string, the options page as placeholder text, the deploy
// doc as prose, and the health check as the thing it probes.
//
// Seven copies is seven chances to be wrong, and being wrong here is quiet: the
// shorter `panelflow.vercel.app` is an unrelated project that answers 200 to
// anything, so a client pointed at it does not error — it just never finds a
// library. (That is not hypothetical; a stale ios/Generated/ in this repo still
// has it.) So: the two files that can import the value now do, and this test
// covers the rest of the repo, including files nobody has written yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/panelflow-core.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

// Build output and dependencies are not ours to keep in step — ios/Generated in
// particular is a copy of files this test already checks at their source.
const SKIP = new Set(['node_modules', '.git', '.vercel', 'Generated', 'data', 'dist', '.claude']);
const TEXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.html', '.css',
  '.yml', '.yaml', '.kt', '.kts', '.swift', '.xml', '.sh', '.plist']);

/** Every `https://<host>.vercel.app` in the repo, as `path:line -> url`. */
function findAll(dir = '') {
  const hits = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) { hits.push(...findAll(path)); continue; }
    if (!TEXT.has(extname(entry.name))) continue;
    read(path).split(/\r?\n/).forEach((line, i) => {
      for (const m of line.matchAll(/https:\/\/[a-z0-9-]+\.vercel\.app/g)) {
        hits.push({ where: `${path}:${i + 1}`, url: m[0] });
      }
    });
  }
  return hits;
}

const hits = findAll();

test('nothing in the repo points at another vercel project', () => {
  const wrong = hits.filter((h) => h.url !== DEFAULTS.backendUrl);
  assert.deepEqual(wrong.map((h) => `${h.where} -> ${h.url}`), [],
    `the backend is DEFAULTS.backendUrl in shared/panelflow-core.js (${DEFAULTS.backendUrl})`);
});

test('the copies that cannot import it are still there', () => {
  // These four are read by a build system or a compiler, so they cannot reach
  // for a JavaScript constant. Losing the copy is as bad as diverging from it:
  // a shell with no fallback ships pointed at nothing.
  for (const file of [
    'android/app/build.gradle.kts',
    'ios/project.yml',
    'ios/Sources/NativeMessages.swift',
    'extension/options/options.html',
  ]) {
    assert.ok(hits.some((h) => h.where.startsWith(`${file}:`)),
      `${file} no longer carries the backend URL`);
  }
});

test('the copies that could be deleted were', () => {
  // worker.js loads shared/panelflow-core.js before itself, and health.mjs
  // imports the same value through the ESM face. Neither has an excuse.
  assert.doesNotMatch(read('mobile/www/worker.js'), /vercel\.app/);
  assert.match(read('mobile/www/worker.js'), /PanelFlowCore\.DEFAULTS\.backendUrl/);

  const health = read('scripts/health.mjs');
  assert.match(health, /import \{ DEFAULTS \}/);
  assert.match(health, /\$\{DEFAULTS\.backendUrl\}/);
  // The trap host is named in a comment there, deliberately, and must stay
  // nameable — hence the `https://` in the search above.
  assert.match(health, /panelflow\.vercel\.app` belongs to an unrelated project/);
});

test('the generated copies of the shared core were synced', () => {
  // shared/* is the source; extension/shared/* and mobile/www/shared/* are
  // written by `npm run sync:shared`. A stale copy is a client on an old host.
  for (const copy of ['extension/shared/panelflow-core.js', 'mobile/www/shared/panelflow-core.js']) {
    assert.ok(read(copy).includes(DEFAULTS.backendUrl), `${copy} is stale — run npm run sync:shared`);
  }
});
