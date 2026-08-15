// PostToolUse — republishes the copies as soon as their source changes.
//
// The pair to guard-generated.mjs: that one keeps edits in `shared/`, this one
// makes editing `shared/` enough. Without it every change to a shared file
// leaves five stale copies behind until someone remembers the command.
//
// Silent when nothing was stale, so an edit to an unrelated file costs one
// no-op. Reports what it rewrote otherwise, because a single-line edit turning
// into six changed files is worth seeing before `git add`.
import { isSharedSource } from './paths.mjs';

const read = async () => {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};

try {
  const { tool_input: input = {}, tool_response: response = {} } = await read();
  const file = response.filePath ?? input.file_path;
  if (!file || !isSharedSource(file)) process.exit(0);

  const { sync } = await import('../../scripts/sync-shared.mjs');
  const stale = sync();
  if (!stale.length) process.exit(0);

  console.log(JSON.stringify({
    systemMessage: `sync:shared rewrote ${stale.length} file(s)`,
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext:
        `\`npm run sync:shared\` ran automatically and rewrote: ${stale.join(', ')}. `
        + 'These are generated copies — commit them with the change, do not edit them.',
    },
  }));
} catch (err) {
  console.error(`sync:shared hook failed: ${err.message}`);
  process.exit(0); // Never block an edit over a failed republish.
}
