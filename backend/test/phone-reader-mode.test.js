// The phone opens chapters in vertical scroll (owner's report, October 2026).
//
// A chapter of a webtoon opened as a thin strip, one page at a time. The mode
// menu inside the reader used to write the phone's default, so a single manga
// switched to pages turned every chapter after it into pages. Now a mode
// picked there belongs to the series, the default is the settings page's, and
// what the old menu left behind is reset to vertical once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(join(root, ...p), 'utf8');

/** native/src/prefs.js's seedLocalDefaults, run on a fake store. */
function seeder(stored, account = {}) {
  const src = read('native', 'src', 'prefs.js');
  const from = src.indexOf('export async function seedLocalDefaults()');
  const to = src.indexOf('\n}\n', from) + 3;
  assert.ok(from !== -1 && to > from, 'seedLocalDefaults is not where this test expects it');
  const writes = [];
  const send = async (msg) => {
    if (msg.type === 'getAccountPrefs') return { prefs: account };
    if (msg.type === 'storageGet') return { values: Object.fromEntries(msg.keys.filter((k) => k in stored).map((k) => [k, stored[k]])) };
    if (msg.type === 'storageSet') { writes.push(msg.values); Object.assign(stored, msg.values); return { ok: true }; }
    throw new Error(`unexpected ${msg.type}`);
  };
  const fn = new Function('send', 'READER_DEFAULTS', 'AUTO_SHOW_DEFAULT',
    `${src.slice(from, to).replace('export async function', 'async function')}; return seedLocalDefaults;`)(
    send, { autoNext: true, hideRead: true, tapZones: 'sides', readerDark: true }, true);
  return { run: fn, writes, stored };
}

test('a phone left in pages by the old reader menu opens in vertical scroll, once', async () => {
  const s = seeder({ readerMode: 'ltr' });
  await s.run();
  assert.equal(s.stored.readerMode, 'vertical');
  assert.equal(s.stored.readerModeSettled, true);
  // Chosen again in the settings afterwards, it stays chosen.
  s.stored.readerMode = 'spread';
  await s.run();
  assert.equal(s.stored.readerMode, 'spread');
});

test('a mode picked inside the reader on a phone is the series\' own', () => {
  const reader = read('extension', 'content', 'reader.js');
  const handler = reader.slice(reader.indexOf("$('.pf-mode').addEventListener('change'"));
  assert.match(handler.slice(0, 1200),
    /if \(!state\.seriesPrefs && root\.classList\.contains\('pf-touch'\) && state\.meta\.sourceUrl\) \{\s*state\.seriesPrefs = seriesSnapshot\(\);/);
});

test('the phone\'s settings show the mode its reader will open in', () => {
  const prefs = read('native', 'src', 'prefs.js');
  assert.match(prefs, /readerMode: stored\?\.values\?\.readerMode \?\? prefs\.readerMode/);
});
