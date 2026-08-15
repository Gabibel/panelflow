// A read-only view of the local database, over a copy of it.
//
// Two things make this safe rather than merely careful:
//
//   1. It never opens `backend/data/panelflow.db`. On startup it copies the
//      file (and its -wal/-shm siblings, or a WAL-mode snapshot would be half a
//      database) into the OS temp directory and opens that. The original is not
//      held open, not locked, and not reachable from here.
//   2. The copy is opened `readOnly`, so the driver itself refuses a write —
//      the SQL filter below is the second line of defence, not the only one.
//
// Production is deliberately absent. Reaching Turso would mean putting its auth
// token in `.mcp.json`, which is a committed file; the answer to "what is in
// production" is a read through the API or a `turso db shell`, not a secret in
// the repo.
//
// Node's own `node:sqlite` does the work, so this adds no dependency.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = process.env.PANELFLOW_DB ?? join(root, 'backend', 'data', 'panelflow.db');
const MAX_ROWS = 200;

let db = null;
let copiedAt = null;

/** Copy the database aside and open the copy. Returns the path opened. */
function openCopy() {
  if (!existsSync(SOURCE)) throw new Error(`no database at ${SOURCE} — start the backend once to create it`);
  const dir = mkdtempSync(join(tmpdir(), 'panelflow-ro-'));
  const target = join(dir, basename(SOURCE));
  copyFileSync(SOURCE, target);
  // WAL holds writes that are not in the main file yet. Missing siblings are
  // normal (a cleanly closed database has none), so absence is not an error.
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(SOURCE + ext)) copyFileSync(SOURCE + ext, target + ext);
  }
  db?.close();
  db = new DatabaseSync(target, { readOnly: true });
  copiedAt = new Date().toISOString();
  return target;
}

/** Statements that only read. Anything else is refused before it reaches SQLite. */
function readOnlySql(sql) {
  const text = String(sql ?? '').trim().replace(/;\s*$/, '');
  if (!text) throw new Error('empty statement');
  if (text.includes(';')) throw new Error('one statement at a time');
  if (!/^(select|with|pragma|explain)\b/i.test(text)) {
    throw new Error('read-only: statements must begin with SELECT, WITH, PRAGMA or EXPLAIN');
  }
  return text;
}

const TOOLS = [
  {
    name: 'tables',
    description: 'List the tables in the local PanelFlow database, with their row counts.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'schema',
    description: 'Show the CREATE statements for one table, or for every table when no name is given.',
    inputSchema: {
      type: 'object',
      properties: { table: { type: 'string', description: 'Table name; omit for all.' } },
    },
  },
  {
    name: 'query',
    description: `Run one read-only statement (SELECT, WITH, PRAGMA, EXPLAIN) against a copy of the local database. At most ${MAX_ROWS} rows come back.`,
    inputSchema: {
      type: 'object',
      properties: { sql: { type: 'string', description: 'A single read-only statement.' } },
      required: ['sql'],
    },
  },
  {
    name: 'refresh',
    description: 'Take a fresh copy of the database, picking up anything written since this server started.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function call(name, args = {}) {
  if (!db) openCopy();
  if (name === 'refresh') {
    openCopy();
    return `Re-copied at ${copiedAt}.`;
  }
  if (name === 'tables') {
    const rows = db.prepare(
      "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name",
    ).all();
    return rows.map((r) => {
      const { n } = db.prepare(`select count(*) as n from "${r.name}"`).get();
      return `${r.name} (${n} rows)`;
    }).join('\n') || '(no tables)';
  }
  if (name === 'schema') {
    const rows = args.table
      ? db.prepare("select sql from sqlite_master where name = ?").all(args.table)
      : db.prepare("select sql from sqlite_master where sql is not null order by name").all();
    if (!rows.length) throw new Error(args.table ? `no such table: ${args.table}` : 'empty database');
    return rows.map((r) => r.sql).join(';\n\n');
  }
  if (name === 'query') {
    const rows = db.prepare(readOnlySql(args.sql)).all();
    if (!rows.length) return '(no rows)';
    const shown = rows.slice(0, MAX_ROWS);
    const note = rows.length > MAX_ROWS ? `\n\n(${rows.length} rows, first ${MAX_ROWS} shown)` : '';
    return JSON.stringify(shown, null, 1) + note;
  }
  throw new Error(`unknown tool: ${name}`);
}

// --- JSON-RPC over stdio, newline-delimited -------------------------------

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, message) => send({ jsonrpc: '2.0', id, error: { code: -32000, message } });

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'panelflow-db-readonly', version: '1.0.0' },
    });
  }
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const text = call(params?.name, params?.arguments ?? {});
      return reply(id, { content: [{ type: 'text', text: String(text) }] });
    } catch (err) {
      // An error the model should read and correct, not a transport failure.
      return reply(id, { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true });
    }
  }
  if (id !== undefined) fail(id, `unknown method: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let cut;
  while ((cut = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, cut).trim();
    buffer = buffer.slice(cut + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { /* a malformed line is not worth dying over */ }
  }
});
process.stdin.on('end', () => process.exit(0));
