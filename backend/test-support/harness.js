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

const { app } = await import('../src/index.js');

const server = app.listen(0);
await once(server, 'listening');

export const base = `http://localhost:${server.address().port}`;

export function shutdown() {
  server.close();
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* libsql may still hold the file on Windows */ }
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
