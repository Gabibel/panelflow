// What an account leaves on a phone when its data goes.
//
// "Delete my account", signing out with the data erased, and the server
// saying the account is gone all end in the core's `onForget` (shared/
// panelflow-core.js, forgetElsewhere). The extension passed one, which takes
// the saved chapters and the last bug report with it; the phone passed none,
// so its saved chapters stayed, and so did the last export, a copy of the
// whole account written to the app's cache for the share sheet (QA, P5 H14).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8').replace(/\r\n/g, '\n');

/** native/src/export-file.js over a cache that is a Map. */
function exportModule() {
  const files = new Map();
  class File {
    constructor(dir, name) { this.uri = `${dir.uri}/${name}`; }
    get exists() { return files.has(this.uri); }
    write(text) { files.set(this.uri, text); }
    delete() { files.delete(this.uri); }
  }
  const Paths = { cache: { uri: 'file:///cache' } };
  const src = read('native', 'src', 'export-file.js')
    .replace(/^import .*$/gm, '')
    .replace(/^export (const|function) /gm, '$1 ');
  const mod = new Function('File', 'Paths', `${src}\nreturn { exportFile, forgetExport };`)(File, Paths);
  return { ...mod, files };
}

test('the export is written to the cache, and forgotten on demand', () => {
  const m = exportModule();
  m.exportFile().write('{"library":[]}');
  assert.deepEqual([...m.files.keys()], ['file:///cache/panelflow-export.json']);
  m.forgetExport();
  assert.equal(m.files.size, 0, 'the copy of the account stayed in the cache');
  // Nothing to forget is not an error.
  assert.doesNotThrow(() => m.forgetExport());
});

test('the phone takes its saved chapters and the export with the account', () => {
  const core = read('native', 'src', 'core.js');
  const opts = core.slice(core.indexOf('export const core = createCore({'), core.indexOf('const hub = createHub(core, {'));
  assert.ok(opts.length > 0, 'createCore is not where this test expects it');
  assert.match(opts, /onForget: async \(\) => \{\s*for \(const meta of await offline\.store\.list\(\)\) await offline\.store\.remove\(meta\.chapterUrl\);\s*forgetExport\(\);\s*\}/);
  assert.match(core, /^import \{ forgetExport \} from '\.\/export-file\.js';$/m);
  // And the account screen writes the export where forgetExport looks.
  assert.match(read('native', 'src', 'screens', 'AccountScreen.js'), /const file = exportFile\(\);/);
});
