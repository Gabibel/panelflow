// PreToolUse — refuses an edit to a file that a generator owns.
//
// `extension/shared/panelflow-core.js` and `shared/panelflow-core.js` are the
// same file with the same name, and the wrong one is the easy one to open. The
// test suite catches it (`shared sources are in sync`), but only later, and by
// then the edit has to be redone in the right place. This says so at the moment
// of writing, and names the file to edit instead.
import { generatedPaths, rel, root } from './paths.mjs';
import { resolve } from 'node:path';

const read = async () => {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};

const allow = () => process.exit(0);

try {
  const { tool_input: input = {} } = await read();
  const file = input.file_path;
  if (!file) allow();

  const { files, prefixes } = await generatedPaths();
  const abs = resolve(root, file);
  const underBundle = prefixes.some((p) => abs.startsWith(p));
  if (!files.has(abs) && !underBundle) allow();

  // `ios/Generated/` is filled by bundle-assets.sh from several places at once,
  // so it can only name the script, not one file.
  const source = files.get(abs) ?? 'the source it was bundled from (ios/Scripts/bundle-assets.sh)';
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `${rel(abs)} is generated, not source — the edit would be overwritten by `
        + `\`npm run sync:shared\` and fail the "shared sources are in sync" test. `
        + `Edit ${source} instead; the copy is rewritten automatically.`,
    },
  }));
} catch {
  allow(); // A broken guard must not stop the session.
}
