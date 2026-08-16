import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const remoteUrl = process.env.TURSO_DATABASE_URL ?? process.env.PANELFLOW_DATABASE_URL;

// Checked before the driver is chosen, not after. The lambda filesystem is
// read-only and wiped between invocations, so a local file here would silently
// lose every write — but the reason this runs *first* is the error message.
// Falling through to the file driver on Vercel crashes anyway, on a missing
// platform binary, and that error names none of the three things actually
// wrong. This one does.
if (!remoteUrl && process.env.VERCEL) {
  throw new Error('TURSO_DATABASE_URL is required on Vercel (see docs/deploy-vercel.md)');
}

// Which entry point, decided before anything is loaded.
//
// The default `@libsql/client` reads `file:` databases, and to do that it
// requires the native `libsql` package — a compiled binary shipped as one
// optional dependency per platform. npm only ever resolves the platform it
// installed on, so a lockfile written on Windows carries
// `@libsql/win32-x64-msvc` and nothing else, and a Linux build finds no binary
// to load. The function then dies on `require('libsql')` before serving a byte.
//
// `/web` is the same API spoken over HTTP with no binary at all. Nothing is
// given up: it drops `file:` support, and a lambda has no durable filesystem to
// point a file at in the first place — a remote database is the only kind it
// can have. It is also the smaller import, which a cold start pays for.
const { createClient } = remoteUrl
  ? await import('@libsql/client/web')
  : await import('@libsql/client');

// Two deployments, one client. On a server (or a laptop) the database is a
// SQLite file next to the code; on Vercel the filesystem is ephemeral and
// read-only, so the same SQL is spoken over the network to Turso. libsql is
// SQLite — the schema and every query below are identical either way.
function makeClient() {
  if (remoteUrl) {
    return {
      remote: true,
      client: createClient({
        url: remoteUrl,
        authToken: process.env.TURSO_AUTH_TOKEN ?? process.env.PANELFLOW_DATABASE_TOKEN,
      }),
    };
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

  -- Shelves the user invented, beyond the five built-in folders. status is the
  -- built-in folder the category stands for: everything that has to decide
  -- something about a series — watch it for new chapters? export it to MAL as
  -- what? — asks for that rather than for the folder itself (shared/folders.js).
  -- The name is NOCASE so "Weekly" and "weekly" cannot both exist and leave the
  -- user with two tabs they cannot tell apart.
  CREATE TABLE IF NOT EXISTS categories (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL COLLATE NOCASE,
    status     TEXT NOT NULL DEFAULT 'reading',
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, name)
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

  -- One row per chapter per day, not per reading session: switching mode or
  -- reopening a chapter ten seconds later is the same read, and rereading it
  -- next week is a different one. Seconds accumulate into the row, so the
  -- table stays proportional to what was read rather than to how often the
  -- reader happened to report.
  CREATE TABLE IF NOT EXISTS history (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    library_id    TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
    chapter_url   TEXT NOT NULL,
    day           TEXT NOT NULL,
    chapter_label TEXT,
    pages         INTEGER NOT NULL DEFAULT 0,
    seconds       INTEGER NOT NULL DEFAULT 0,
    read_at       TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, library_id, chapter_url, day)
  );

  CREATE INDEX IF NOT EXISTS history_recent ON history (user_id, read_at DESC);

  -- What the server-side watcher found while every client was closed. One row
  -- per chapter per account: the watcher writes it, the first client to wake up
  -- turns it into a notification and marks it seen. Keeping the row after that
  -- is what lets the web app show a "since you were away" list instead of only
  -- a notification nobody was there to see.
  CREATE TABLE IF NOT EXISTS news (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    library_id TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
    chapter    TEXT NOT NULL,
    found_at   TEXT NOT NULL DEFAULT (datetime('now')),
    seen       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, library_id, chapter)
  );

  CREATE INDEX IF NOT EXISTS news_unseen ON news (user_id, seen, found_at DESC);

  -- Where to reach a browser that is not currently running. The endpoint is the
  -- key rather than (user, device): it is what the push service issued, it is
  -- already unique, and re-subscribing on the same browser yields the same one —
  -- so a second sign-in on a shared machine moves the row to the new owner
  -- instead of leaving the previous account quietly notified about it.
  -- p256dh and auth are the browser's half of the encryption; the payload is
  -- sealed to them, so nothing readable is ever handed to the push service.
  CREATE TABLE IF NOT EXISTS push_subs (
    endpoint   TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_ok    TEXT
  );

  CREATE INDEX IF NOT EXISTS push_subs_user ON push_subs (user_id);

  -- last_error is the whole visibility story for pushing: a tracker refuses,
  -- and the only person who could act on it is reading a chapter and will never
  -- see the response. It is written when the answer changes, so the account
  -- screen can say "AniList stopped accepting this a week ago" instead of
  -- looking, forever, exactly like an account that is working.
  CREATE TABLE IF NOT EXISTS trackers (
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service       TEXT NOT NULL CHECK (service IN ('anilist','mal','kitsu')),
    access_token  TEXT NOT NULL,
    refresh_token TEXT,
    expires_at    TEXT,
    remote_user   TEXT,
    PRIMARY KEY (user_id, service)
  );

  -- Which work on the tracker one of our entries is, and how far we have told
  -- the tracker the user has read. Its whole reason for existing is that a
  -- scan site says "Chapitre 109 VF" and AniList says 30002 — resolving that
  -- costs a search request, and doing it on every page turn would be both slow
  -- and rude. The state column records what the last resolution concluded:
  --   linked     remote_id is the work; push progress to it
  --   unmatched  we searched and nothing was close enough to be sure. Not
  --              retried: the user links it by hand, otherwise a title that
  --              simply is not on the tracker gets searched forever
  --   muted      the user does not want this series on this tracker
  -- last_chapter is what the tracker was last told, so an already-sent chapter
  -- is not sent again, and re-reading does not walk the count backwards.
  CREATE TABLE IF NOT EXISTS tracker_links (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    library_id   TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
    service      TEXT NOT NULL CHECK (service IN ('anilist','mal','kitsu')),
    remote_id    TEXT,
    remote_title TEXT,
    state        TEXT NOT NULL DEFAULT 'unmatched',
    last_chapter REAL,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, library_id, service)
  );
`;

// Additive migrations. Kept out of the schema above so existing databases pick
// them up on boot without a separate migration step: `CREATE TABLE IF NOT
// EXISTS` is a no-op against a table that already exists, so a column added to
// SCHEMA alone would only ever appear on a database created after the change.
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
  // When the server-side watcher last looked at this series. A run takes the
  // oldest first, which is the whole reason consecutive runs rotate through the
  // library instead of one run trying to check all of it and timing out.
  checked_at:  'TEXT',
  // What the last successful watcher fetch of this URL was told to quote back.
  // Per URL rather than per account, like checked_at: one fetch serves every
  // account following the series, so there is only ever one answer to store.
  etag:          'TEXT',
  last_modified: 'TEXT',
  // JSON array of the sites this entry was read on before, newest last. Written
  // when a series is migrated from one scan site to another so the history —
  // and the old chapter links — are not simply overwritten.
  previous_sources: "TEXT NOT NULL DEFAULT '[]'",
};

// The same, for the tables that grew a column after they had users.
const COLUMNS = {
  library: LIBRARY_COLUMNS,
  trackers: {
    // Why the last push to this service failed, in the tracker's own words, or
    // NULL while it is working. Cleared by the first push that succeeds.
    last_error:    'TEXT',
    last_error_at: 'TEXT',
    // When progress last actually reached the service. "Connected" and "still
    // being listened to" are different claims and the second one is the one a
    // reader wants.
    last_push_at:  'TEXT',
  },
  tracker_links: {
    // The shelf the tracker had this on the last time we looked, as a PanelFlow
    // folder. Consulted for exactly one decision — may this push also move the
    // series to "reading"? — and re-read from the service whenever it says
    // something that would allow that, so a stale value can never promote a
    // series the reader has since finished.
    remote_status: 'TEXT',
  },
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
  const added = [];
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const info = await client.execute(`SELECT name FROM pragma_table_info('${table}')`);
    const existing = new Set(info.rows.map((c) => c.name));
    for (const [name, decl] of Object.entries(columns)) {
      if (existing.has(name)) continue;
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
      if (table === 'library') added.push(name);
    }
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
  // All-or-nothing. libsql runs a batch inside one transaction and rolls the
  // whole thing back if any statement fails, which is the only way to delete a
  // row and fold its contents into another without a window where both are gone.
  async batch(statements) {
    await dbReady();
    return client.batch(statements.map(({ sql, args = [] }) => ({ sql, args: bind(args) })), 'write');
  },
  async exec(sql) {
    await dbReady();
    return client.executeMultiple(sql);
  },
  // Tests need a clean slate without deleting the file out from under libsql.
  async close() { await client.close(); },
};

export const uid = () => crypto.randomUUID();
