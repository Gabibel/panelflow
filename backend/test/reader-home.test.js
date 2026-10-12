// The reader's home button (owner's request, October 2026): from a chapter
// straight to PanelFlow's library, instead of the scan site under the reader.
// On a phone the in-app browser closes onto the app's library; on a computer
// the website's library opens in a tab of its own, the chapter left open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');
const reader = read('extension', 'content', 'reader.js');

/** reader.js's goHome, with what it calls handed in. */
function goHomeWith({ shell, answer }) {
  const from = reader.indexOf('  async function goHome() {');
  const to = reader.indexOf('\n  }\n', from) + 4;
  const calls = [];
  const state = { root: {} };
  const fn = new Function('inShell', 'closeByUser', 'send', 'state',
    `${reader.slice(from, to)}; return goHome;`)(
    () => shell,
    () => { calls.push('close'); state.root = null; },
    async (msg) => { calls.push(msg.type); return answer; },
    state,
  );
  return { goHome: fn, calls };
}

test('the reader has a home button, named in the reader\'s language', () => {
  assert.match(reader, /data-act="home" title="\$\{t\('readerHome'\)\}" aria-label="\$\{t\('readerHome'\)\}">\$\{icon\('home'\)\}/);
  assert.match(reader, /\[data-act="home"\]'\)\.addEventListener\('click', goHome\)/);
  for (const lang of ['en', 'fr']) {
    assert.ok(JSON.parse(read('shared', '_locales', lang, 'messages.json')).readerHome?.message);
  }
});

test('on a phone the reading is written down, then the app goes home', async () => {
  const { goHome, calls } = goHomeWith({ shell: true, answer: { ok: true } });
  await goHome();
  assert.deepEqual(calls, ['close', 'goHome']);
});

test('on a computer the library opens beside the chapter, which stays open', async () => {
  const { goHome, calls } = goHomeWith({ shell: false, answer: { ok: true } });
  await goHome();
  assert.deepEqual(calls, ['goHome']);
});

test('a shell that does not know the way home still closes the reader', async () => {
  const { goHome, calls } = goHomeWith({ shell: false, answer: { error: 'unknown message' } });
  await goHome();
  assert.deepEqual(calls, ['goHome', 'close']);
});

test('the phone closes its browser onto the library, and the extension opens the website', () => {
  const core = read('native', 'src', 'core.js');
  assert.match(core, /case 'goHome':\s*shell\.goHome\?\.\(\);/);
  assert.match(core, /'goHome',/, 'a page may not ask to go home');
  assert.match(read('native', 'src', 'screens', 'BrowserScreen.js'), /goHome: onHome \|\| onClose,/);
  assert.match(read('native', 'src', 'Shell.js'), /onHome=\{\(\) => \{ setBrowsing\(null\); go\('library'\); store\.refresh\(\); \}\}/);
  assert.match(read('extension', 'background.js'), /goHome: async \(\) => \{[\s\S]*?chrome\.tabs\.create\(\{ url: `\$\{base\}\/` \}\)/);
});
