// Stop — runs the suite before the turn is allowed to end.
//
// 615 tests in about nine seconds, and they are the only thing that checks the
// six copies of a behaviour still agree. Cheap enough to run every time rather
// than guess which file was related.
//
// Blocks once. If the suite still fails after Claude has been sent back to fix
// it, the second Stop passes `stop_hook_active` and this steps aside — a
// failing test the model cannot fix must not become a session that cannot end.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');

const read = async () => {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};

try {
  const { stop_hook_active: alreadyBlocked } = await read();
  if (alreadyBlocked) process.exit(0);

  // One string through the shell, not an argument list. `npm` is `npm.cmd` on
  // Windows and Node refuses to spawn a .cmd without a shell; passing args
  // *alongside* `shell: true` is the combination that warns, so there are none.
  const run = spawnSync('npm test --silent', { cwd: root, encoding: 'utf8', shell: true });
  if (run.status === 0) process.exit(0);

  // Never ran — no npm, no permission. That is not a red suite, and pretending
  // otherwise would block every turn on a machine that cannot run the tests.
  if (run.error || run.status === null) process.exit(0);

  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  const failures = output
    .split('\n')
    .filter((line) => /^\s*(not ok|✖|✗)|^\s*ℹ fail \d+/.test(line))
    .slice(0, 40)
    .join('\n');

  console.log(JSON.stringify({
    decision: 'block',
    reason: `\`npm test\` fails. Fix it before finishing.\n\n${failures || output.slice(-3000)}`,
  }));
} catch {
  process.exit(0); // A broken check must not trap the session.
}
