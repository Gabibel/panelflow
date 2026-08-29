// Shared harness. Importing this module sets the environment *before* the app
// is loaded (db.js reads PANELFLOW_DATA_DIR and auth.js reads the JWT secret at
// module scope), then boots a server on an ephemeral port.
//
// Each test file runs in its own process under `node --test`, so each one gets
// a private database directory and cannot see another file's rows.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

export const dataDir = mkdtempSync(join(tmpdir(), 'panelflow-test-'));
process.env.PANELFLOW_DATA_DIR = dataDir;
process.env.PANELFLOW_JWT_SECRET = 'test-secret';
delete process.env.TURSO_DATABASE_URL;
delete process.env.VERCEL;

// The limits keyed on the *caller's address* are lifted, and only those. Every
// test in the suite comes from 127.0.0.1, so a per-address ceiling meant for
// one household is spent by the fourth test file and the rest fail on 429 —
// which would say nothing about the code under test.
//
// The limits keyed on an account or an email address are left exactly as
// production runs them, and are tested end to end in test/rate-limit.test.js:
// those are the ones that actually stop an attack, so they are the ones that
// must never be tested against numbers nobody deploys.
process.env.PANELFLOW_LIMIT_LOGIN_IP = '100000';
process.env.PANELFLOW_LIMIT_REGISTER = '100000';
process.env.PANELFLOW_LIMIT_FORGOT_IP = '100000';
process.env.PANELFLOW_LIMIT_RESET = '100000';
process.env.PANELFLOW_LIMIT_FETCH = '100000';

// Imported dynamically, and only here: a static import is hoisted above the
// environment above, and db.js reads PANELFLOW_DATA_DIR at module scope.
const { app } = await import('../src/index.js');
const { db } = await import('../src/db.js');

const server = app.listen(0);
await once(server, 'listening');

export const base = `http://localhost:${server.address().port}`;

// Close in the order the operating system cares about: no more requests, then
// no more database, then the files.
//
// Deleting the directory while libsql still had panelflow.db open was a flake
// nobody could pin down — every test in a file passed and the file was marked
// failed anyway, because the process itself came back non-zero on the way out.
// It was rare, it moved from file to file, and it only ever happened under the
// full parallel run: one process per test file, all of them racing to pull
// their own database out from under a native handle. db.close() is there for
// exactly this, and the harness was the one caller that never used it.
export async function shutdown() {
  server.close();
  // fetch() keeps its sockets alive, and close() waits for every one of them.
  server.closeAllConnections();
  await once(server, 'close');
  await db.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* Windows may still hold it */ }
}

/** One request. `token` null means "send no Authorization header". */
export async function api(method, path, body, token) {
  const resp = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  return { status: resp.status, body: parsed, headers: resp.headers };
}

let seq = 0;
/** Registers a fresh account and returns its token + id. */
export async function newUser() {
  const email = `u${Date.now()}-${seq++}@test.dev`;
  const r = await api('POST', '/api/auth/register', { email, password: 'password123' }, null);
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { email, token: r.body.token, id: r.body.user.id };
}

let entrySeq = 0;
/** Adds a library entry for `token` and returns the created entry. */
export async function addEntry(token, overrides = {}) {
  const n = entrySeq++;
  const r = await api('POST', '/api/library', {
    title: `Series ${n}`,
    sourceDomain: 'example-manga-site.test',
    sourceUrl: `https://example-manga-site.test/manga/series-${n}`,
    ...overrides,
  }, token);
  if (r.status !== 201 && r.status !== 200) {
    throw new Error(`addEntry failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body;
}
