// The driver this picks is the difference between a working deployment and a
// function that dies before serving a byte.
//
// `@libsql/client` reaches for the native `libsql` package, whose binary ships
// as one optional dependency per platform. npm resolves only the platform it
// installed on, so a lockfile written on Windows names `@libsql/win32-x64-msvc`
// and no other — and a Linux build finds nothing to load:
//
//   Cannot find module '@libsql/linux-x64-gnu'
//   Require stack: /var/task/backend/node_modules/libsql/index.js
//
// That is a runtime failure on a build that reported success, which is the
// worst shape a bug can have. A unit test cannot reproduce a Linux lambda from
// Windows, but it can check the thing that actually decides the outcome:
// whether anything native is loaded at all when the database is remote.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const backend = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Import `db.js` in a fresh process and report every CJS module it pulled in.
 * A child process because the choice is made once, at module load, and this
 * process has already made it.
 */
function modulesLoadedBy(env) {
  const probe = `
    const Module = require('node:module');
    const seen = [];
    const load = Module._load;
    Module._load = function (request, ...rest) {
      seen.push(request);
      return load.call(this, request, ...rest);
    };
    import('./src/db.js')
      .then(() => console.log(JSON.stringify(seen)))
      .catch((e) => { console.log(JSON.stringify(['ERROR: ' + e.message])); });
  `;
  const out = execFileSync(process.execPath, ['-e', probe], {
    cwd: backend,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  // Separators normalised: ESM's CJS interop resolves a specifier to an
  // absolute path before `_load` sees it, so `require('libsql')` is recorded as
  // `...\node_modules\libsql\index.js` on Windows and `.../` elsewhere.
  return JSON.parse(out.trim().split('\n').pop()).map((m) => String(m).replace(/\\/g, '/'));
}

/** The native driver, however it happens to be spelled. */
const isNative = (m) =>
  m === 'libsql' ||
  m.includes('/node_modules/libsql/') ||
  /^@libsql\/(win32|linux|darwin)/.test(m);

test('a remote database loads no native binding', () => {
  // The URL is never dialled — migrations are lazy, so importing the module
  // only constructs a client. Nothing here touches the network.
  const loaded = modulesLoadedBy({
    TURSO_DATABASE_URL: 'libsql://example.invalid',
    TURSO_AUTH_TOKEN: 'not-a-real-token',
    PANELFLOW_JWT_SECRET: 'test-secret',
  });

  assert.ok(!loaded[0]?.startsWith('ERROR'), `db.js failed to import: ${loaded[0]}`);

  const native = loaded.filter(isNative);
  assert.deepEqual(native, [],
    `remote mode loaded native modules: ${native.join(', ')} — Vercel will crash on Linux`);
});

test('a local file database still gets the native driver', () => {
  // The other half of the trade: `/web` cannot open a file, so development and
  // the rest of this suite must keep the default entry point. If this ever
  // starts loading `/web` too, every local query fails instead.
  const loaded = modulesLoadedBy({
    TURSO_DATABASE_URL: '',
    PANELFLOW_DATABASE_URL: '',
    PANELFLOW_DATA_DIR: join(backend, 'data'),
  });
  assert.ok(loaded.some(isNative),
    'local mode should load the native driver — /web has no file: support');
});

test('a misconfigured Vercel deployment says what is missing', () => {
  // The failure this replaces was `Cannot find module '@libsql/linux-x64-gnu'`,
  // which names none of the three things actually wrong and sends whoever reads
  // it into the npm docs. The check has to run before the driver is chosen or
  // the useful message never gets a chance to be thrown.
  const loaded = modulesLoadedBy({
    VERCEL: '1',
    TURSO_DATABASE_URL: '',
    PANELFLOW_DATABASE_URL: '',
    PANELFLOW_JWT_SECRET: 'test-secret',
  });
  assert.ok(loaded[0]?.startsWith('ERROR'), 'a Vercel deployment with no database should refuse to boot');
  assert.match(loaded[0], /TURSO_DATABASE_URL is required on Vercel/);
  assert.deepEqual(loaded.filter(isNative), [],
    'the driver must not be loaded before the configuration is checked');
});

test('the two entry points are chosen by the same value db.js branches on', () => {
  // Guards the shape of the fix rather than its effect: an `await import` with
  // a literal specifier on each side is what lets a bundler trace both, and
  // what keeps the unused one from being executed.
  const source = readSource();
  assert.match(source, /await import\('@libsql\/client\/web'\)/);
  assert.match(source, /await import\('@libsql\/client'\)/);
  // Decided before either import, from the env — not from a request, and not
  // from anything that could differ between invocations of a warm lambda.
  assert.match(source, /const remoteUrl = process\.env\.TURSO_DATABASE_URL/);
});

function readSource() {
  return execFileSync(process.execPath, [
    '-e', "process.stdout.write(require('fs').readFileSync('src/db.js','utf8'))",
  ], { cwd: backend, encoding: 'utf8' });
}
