// The report the tester sends: what is in it, and that it is only words.
//
// `reportLines` is the whole content of the mail, lifted out of the screen so
// it can be read here. What matters is that every fact a bug needs is on its
// own line and that nothing a tester would not want in a mail slips in: the
// events are cut short at the source (diagnostics.js), so a page URL with a
// token in it, or a stack, cannot fill the report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');

/** diagnostics.js as a module, with no phone around it. */
const diagnostics = (() => {
  const body = read('native/src/diagnostics.js').replace(/^export /gm, '');
  return new Function(`${body}\n return { note, sawPage, recent, lastPage, clear };`)();
})();

/** reportLines, lifted from the screen. */
const reportLines = (() => {
  const src = read('native/src/screens/settings/ReportPage.js');
  const a = src.indexOf('export function reportLines');
  const b = src.indexOf('\n}\n', a) + 3;
  return new Function(`${src.slice(a, b).replace('export ', '')}\n return reportLines;`)();
})();

test('the report leads with the build, then the phone, the page and the time', () => {
  const lines = reportLines({
    description: 'the reader did not open',
    url: 'https://scan.test/blue-box/ch-9/',
    events: [{ at: 't1', kind: 'refused', detail: 'script left the site: https://ad.example/' }],
    app: { version: '0.1.0', build: '14' },
    platform: { os: 'ios', version: '18.0' },
    now: '2026-09-18T12:00:00.000Z',
  });
  assert.equal(lines[0], 'PanelFlow 0.1.0 (build 14)');
  assert.equal(lines[1], 'ios 18.0');
  assert.equal(lines[2], 'Page: https://scan.test/blue-box/ch-9/');
  assert.equal(lines[3], 'Date: 2026-09-18T12:00:00.000Z');
  assert.ok(lines.includes('the reader did not open'));
  assert.ok(lines.includes('t1 refused: script left the site: https://ad.example/'));
});

test('a report with nothing noted says so, rather than hiding the section', () => {
  const lines = reportLines({ description: 'x', url: '', events: [], app: { version: '1', build: '2' }, platform: { os: 'ios', version: '1' }, now: 'n' });
  assert.ok(lines.includes('Page: (none)'));
  assert.equal(lines.at(-1), '(none)');
});

test('the notes are kept short and few', () => {
  diagnostics.clear();
  diagnostics.note('hub', 'x'.repeat(1000));
  assert.equal(diagnostics.recent()[0].detail.length, 200, 'a long detail was not cut');
  for (let i = 0; i < 100; i++) diagnostics.note('page', String(i));
  assert.equal(diagnostics.recent().length, 60, 'the buffer grows without bound');
  assert.equal(diagnostics.recent().at(-1).detail, '99', 'the newest note was dropped instead of the oldest');
  diagnostics.sawPage('https://scan.test/x');
  assert.equal(diagnostics.lastPage(), 'https://scan.test/x');
});

test('the events the screen shows are the ones the app writes to the console', () => {
  // The three places a tester's problem is first visible, each also noted.
  const browser = read('native/src/screens/BrowserScreen.js');
  assert.match(browser, /diagnostics\.note\('refused'/);
  assert.match(browser, /diagnostics\.note\('script'/);
  assert.match(browser, /diagnostics\.sawPage\(nav\.url\)/);
  assert.match(read('native/src/core.js'), /note\('hub'/);
  assert.match(read('native/src/screens/SettingsScreen.js'), /Page: ReportPage/);
});
