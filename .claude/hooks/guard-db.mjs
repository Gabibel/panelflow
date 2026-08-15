// PreToolUse on Bash/PowerShell — what may reach the Turso production database.
//
// There are two databases and only one of them is replaceable.
// `backend/data/panelflow.db` is a local file, gitignored, rebuilt from the
// `SCHEMA` in backend/src/db.js the next time the server starts. Nothing here
// touches it: it is free to read, write, wipe and refill.
//
// Turso is the other one, and `db.js` reaches it from any process that merely
// has `TURSO_DATABASE_URL` in its environment — so a script written against
// "the database" hits production without ever naming it. Three answers rather
// than one:
//
//   read anything            → allowed. Knowing what is in there is never the risk.
//   write user data          → refused. `users` and `progress` are somebody's
//                              account and somebody's place in a chapter; there
//                              is no copy, and a wrong UPDATE is not a rollback
//                              away. Not a prompt to click through.
//   write anything else      → asked. Migrations, `news`, a backfill: legitimate,
//                              occasionally necessary, never routine.
const TOUCHES_PROD = /\bturso\b|libsql:\/\/|TURSO_DATABASE_URL|PANELFLOW_DATABASE_URL/i;

// Statements that change rows or shape, as an inventory rather than one pattern.
const MUTATING = ['insert', 'update', 'delete', 'drop', 'alter', 'truncate', 'replace into'];
const mutates = (cmd) => MUTATING.some((verb) => new RegExp(`\\b${verb}\\b`, 'i').test(cmd));

// The tables that hold what a user would lose. `news` is absent on purpose: it
// is the watcher's own output, regenerated on the next run.
const USER_DATA = [
  'users', 'progress', 'library', 'history', 'categories',
  'push_subs', 'trackers', 'tracker_links',
];
const namesUserData = (cmd) =>
  USER_DATA.filter((table) => new RegExp(`\\b${table}\\b`, 'i').test(cmd));

// Reads. Named so a `turso db shell` that carries a SELECT is judged by the
// statement it carries, not by the subcommand that carries it.
const READING = ['select', 'pragma', 'explain'];
const reads = (cmd) => READING.some((verb) => new RegExp(`\\b${verb}\\b`, 'i').test(cmd));

// `turso db shell <db>` with no statement is not a command, it is a prompt —
// every statement is reachable from it and none of them is visible here.
const opensAShell = (cmd) => /\bturso\s+db\s+shell\b/i.test(cmd) && !reads(cmd) && !mutates(cmd);

// Destroying the database takes the accounts with it, whatever the tables say.
const destroysTheDatabase = (cmd) => /\bturso\s+db\s+destroy\b/i.test(cmd);

const read = async () => {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};

const allow = () => process.exit(0);

const decide = (decision, reason) => console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: decision,
    permissionDecisionReason: reason,
  },
}));

try {
  const { tool_input: input = {} } = await read();
  const cmd = input.command ?? '';
  if (!cmd || !TOUCHES_PROD.test(cmd)) allow();
  if (!mutates(cmd) && !opensAShell(cmd) && !destroysTheDatabase(cmd)) allow();

  if (destroysTheDatabase(cmd)) {
    decide('deny',
      'This destroys the Turso production database, and every account and reading '
      + 'progress in it. Not something to confirm through a prompt — if the database '
      + 'really is meant to go, the user runs that themselves.');
    process.exit(0);
  }

  const tables = mutates(cmd) ? namesUserData(cmd) : [];
  if (tables.length) {
    decide('deny',
      `This writes to ${tables.join(', ')} on the Turso production database — real `
      + 'accounts and real reading progress, with no copy to restore from. Accounts and '
      + 'progress are not to be modified. Read them freely; to change them, work against '
      + 'backend/data/panelflow.db, or ask the user to run the statement themselves.');
  } else {
    decide('ask',
      'This can write to the Turso production database (migration, backfill, or a table '
      + 'this guard does not recognise). Confirm it is meant for production and not for '
      + 'backend/data/panelflow.db, which is free to change.');
  }
} catch {
  allow(); // A broken guard must not stop the session.
}
