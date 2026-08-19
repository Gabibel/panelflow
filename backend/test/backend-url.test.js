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
// has it.) So: the files that can import the value do, and this test covers the
// rest of the repo, including files nobody has written yet.
//
// It is written against `DEFAULTS.backendUrl` and not against `vercel.app`,
// because the day this moves to a domain of its own (roadmap A5) is exactly the
// day a test keyed to the old host would go quiet — passing while pointing at
// nothing, on the one change it exists to supervise. The `vercel.app` sweep
// stays as the other half: after the switch it is what names the files still on
// the old host.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/panelflow-core.js';
import { bootCore } from '../test-support/core.js';

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
  // These are read by a build system, a compiler or Chrome itself, so none can
  // reach for a JavaScript constant. Losing the copy is as bad as diverging
  // from it: a shell with no fallback ships pointed at nothing, and a manifest
  // whose `matches` misses the backend is a settings page on the web app that
  // silently cannot see the extension.
  for (const file of [
    'android/app/build.gradle.kts',
    'ios/project.yml',
    'ios/Sources/NativeMessages.swift',
    'extension/options/options.html',
    'extension/manifest.json',
  ]) {
    assert.ok(read(file).includes(DEFAULTS.backendUrl),
      `${file} no longer carries ${DEFAULTS.backendUrl}`);
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

test('a cleared field falls back to the default instead of pointing nowhere', async () => {
  // The options page shows the default as the box's placeholder, so an empty
  // box reads as "the default is in force" — and pressing Save writes that
  // emptiness over it. Kept as a setting, `backendUrl: ''` sends every client
  // to `'' + '/api/…'`, which is nowhere, while the URL it should be using goes
  // on showing, greyed out, in the very box that caused it. The popup reported
  // that as "the extension is still waking up", which it was not.
  const { core } = bootCore({ storage: { settings: { backendUrl: '   ' } } });
  assert.equal((await core.getSettings()).backendUrl, 'https://api.test');
  // And what Save hands back is what the next read will see.
  assert.equal((await core.setSettings({ backendUrl: '' })).backendUrl, 'https://api.test');
  // A field that was actually filled in is still the reader's, spaces and all.
  assert.equal((await core.setSettings({ backendUrl: 'https://mine.test' })).backendUrl,
    'https://mine.test');
});

test('the generated copies of the shared core were synced', () => {
  // shared/* is the source; extension/shared/* and mobile/www/shared/* are
  // written by `npm run sync:shared`. A stale copy is a client on an old host.
  for (const copy of ['extension/shared/panelflow-core.js', 'mobile/www/shared/panelflow-core.js']) {
    assert.ok(read(copy).includes(DEFAULTS.backendUrl), `${copy} is stale — run npm run sync:shared`);
  }
});
