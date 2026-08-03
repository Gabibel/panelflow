import { createClient } from '@libsql/client';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Two deployments, one client. On a server (or a laptop) the database is a
// SQLite file next to the code; on Vercel the filesystem is ephemeral and
// read-only, so the same SQL is spoken over the network to Turso. libsql is
// SQLite — the schema and every query below are identical either way.
function makeClient() {
  const url = process.env.TURSO_DATABASE_URL ?? process.env.PANELFLOW_DATABASE_URL;
  if (url) {
    return {
      remote: true,
      client: createClient({
        url,
        authToken: process.env.TURSO_AUTH_TOKEN ?? process.env.PANELFLOW_DATABASE_TOKEN,
      }),
    };
  }
  if (process.env.VERCEL) {
    // The lambda filesystem is read-only and wiped between invocations; a local
    // file here would silently lose every write. Fail loudly instead.
    throw new Error('TURSO_DATABASE_URL is required on Vercel (see docs/deploy-vercel.md)');
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = process.env.PANELFLOW_DATA_DIR ?? join(here, '..', 'data');
  mkdirSync(dataDir, { recursive: true });
  // libsql wants a file: URL, and on Windows only pathToFileURL produces one
  // it can parse ("E:\a\b" is not a URL; "file:///E:/a/b" is).
  return { remote: false, client: createClient({ url: pathToFileURL(join(dataDir, 'panelflow.db')).href }) };
}

const { client, remote } = makeClient();

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    tier          TEXT NOT NULL DEFAULT 'free',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS library (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    cover_url     TEXT,
    source_domain TEXT NOT NULL,
    source_url    TEXT NOT NULL,
    tags          TEXT NOT NULL DEFAULT '[]',
    last_known_chapter TEXT,
    date_added    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    deleted       INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, source_url)
  );

  CREATE TABLE IF NOT EXISTS progress (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    library_id    TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
    chapter_url   TEXT NOT NULL,
    chapter_label TEXT,
    page          INTEGER NOT NULL DEFAULT 0,
    page_count    INTEGER,
    scroll_pos    REAL NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, library_id)
  );

  CREATE TABLE IF NOT EXISTS trackers (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service       TEXT NOT NULL CHECK (service IN ('anilist','mal','kitsu')),
    access_token  TEXT NOT NULL,
    refresh_token TEXT,
    expires_at    TEXT,
    remote_user   TEXT,
    PRIMARY KEY (user_id, service)
  );
`;

// Additive migrations. Kept out of the schema above so existing databases pick
// them up on boot without a separate migration step.
const LIBRARY_COLUMNS = {
  folder:      "TEXT NOT NULL DEFAULT 'reading'",
  language:    'TEXT',
  score:       'INTEGER',
  note:        'TEXT',
  start_date:  'TEXT',
  finish_date: 'TEXT',
  rereads:     'INTEGER NOT NULL DEFAULT 0',
  // 'ongoing' | 'completed' | NULL when the source page did not say.
  series_status: 'TEXT',
  // JSON array of the sites this entry was read on before, newest last. Written
  // when a series is migrated from one scan site to another so the history —
  // and the old chapter links — are not simply overwritten.
  previous_sources: "TEXT NOT NULL DEFAULT '[]'",
};

async function migrate() {
  if (!remote) {
    // WAL is a local-file concern; Turso manages its own storage. Foreign keys
    // are off by default in a local libsql file and on in the server.
    await client.execute('PRAGMA journal_mode = WAL');
    await client.execute('PRAGMA foreign_keys = ON');
  }
  await client.executeMultiple(SCHEMA);

  // pragma_table_info as a table-valued function rather than `PRAGMA ...`:
  // it is plain SQL, so it works identically against a file and against Turso.
  const info = await client.execute("SELECT name FROM pragma_table_info('library')");
  const existing = new Set(info.rows.map((c) => c.name));
  const added = [];
  for (const [name, decl] of Object.entries(LIBRARY_COLUMNS)) {
    if (existing.has(name)) continue;
    await client.execute(`ALTER TABLE library ADD COLUMN ${name} ${decl}`);
    added.push(name);
  }

  // Reading status used to live as a "status:<x>" tag (see README). Promote it
  // to the real column the first time that column appears, so nothing is lost.
  if (added.includes('folder')) {
    const FOLDERS = new Set(['reading', 'paused', 'plan', 'completed', 'dropped']);
    const rows = await client.execute("SELECT id, tags FROM library WHERE tags LIKE '%status:%'");
    for (const row of rows.rows) {
      let tags;
      try { tags = JSON.parse(row.tags); } catch { continue; }
      const tag = (Array.isArray(tags) ? tags : []).find((t) => String(t).startsWith('status:'));
      const folder = tag && String(tag).slice(7).toLowerCase();
      if (folder && FOLDERS.has(folder)) {
        await client.execute({ sql: 'UPDATE library SET folder = ? WHERE id = ?', args: [folder, row.id] });
      }
    }
  }
}

// One migration per process, awaited by every query. A serverless cold start
// gets it for free on the first request; warm invocations reuse the promise.
let ready = null;
export const dbReady = () => (ready ??= migrate());

// libsql rejects `undefined` bindings, and a boolean has no SQLite type.
// The old node:sqlite driver tolerated both, so normalise instead of
// auditing every call site for a value that is merely absent.
const bind = (args) =>
  args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

async function run(sql, args) {
  await dbReady();
  return client.execute({ sql, args: bind(args) });
}

// A thin stand-in for node:sqlite's DatabaseSync, with one difference that
// matters: every method is async. Keeping the prepare().get/all/run shape
// means the routes read the same as before — they just await.
export const db = {
  prepare(sql) {
    return {
      async get(...args) { return (await run(sql, args)).rows[0]; },
      async all(...args) { return (await run(sql, args)).rows; },
      async run(...args) {
        const r = await run(sql, args);
        // libsql calls it rowsAffected; the routes check `.changes`.
        return { changes: Number(r.rowsAffected), lastInsertRowid: r.lastInsertRowid };
      },
    };
  },
  async exec(sql) {
    await dbReady();
    return client.executeMultiple(sql);
  },
  // Tests need a clean slate without deleting the file out from under libsql.
  async close() { await client.close(); },
};

export const uid = () => crypto.randomUUID();
