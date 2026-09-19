// The report the tester sends: what is in it, and that it is only words.
//
// `reportLines` is the whole content of the mail, in shared/report.js so the
// phone, the extension's options page and the web app write the same one.
// What matters is that every fact a bug needs is on its own line and that
// nothing a tester would not want in a mail slips in: the events are cut
// short at the source (the buffer), so a page URL with a token in it, or a
// stack, cannot fill the report.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');

import { createDiagnostics, fromTrail, mailto, reportLines, REPORT_TO } from '../src/report.js';

/** One buffer, the one the phone and the extension's worker each create. */
const diagnostics = createDiagnostics();

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

test('the three surfaces write the same report, from the same file', () => {
  // Each surface reaches for PanelFlowReport rather than carrying its own
  // lines: a fact added to the report lands in all three mails at once.
  assert.match(read('native/src/screens/settings/ReportPage.js'), /globalThis\.PanelFlowReport/);
  assert.match(read('native/src/diagnostics.js'), /PanelFlowReport\.createDiagnostics\(\)/);
  assert.match(read('extension/options/options.js'), /window\.PanelFlowReport/);
  assert.match(read('extension/options/options.html'), /shared\/report\.js/);
  assert.match(read('extension/background.js'), /'shared\/report\.js'/);
  assert.match(read('web/app.js'), /window\.PanelFlowReport/);
  assert.match(read('web/index.html'), /shared\/report\.js/);
  for (const surface of ['extension/options/options.js', 'web/app.js']) {
    assert.ok(!/mailto:/.test(read(surface)), `${surface} builds its own mailto instead of the shared one`);
  }
});

test("the extension's worker answers the options page with the last page and its notes", () => {
  const worker = read('extension/background.js');
  assert.match(worker, /diagnostics\.sawPage\(msg\.meta\.url\)/, 'the last detected page is not noted');
  assert.match(worker, /diagnostics: \(\) => \(\{/, 'no diagnostics message for the options page');
  assert.match(worker, /fromTrail\(self\.PanelFlowCore\.diag\.trail\(\)\)/, "the core's failed calls are left out of the report");
});

test("a failed hub call reads as an event, with its path and status, cut short like the others", () => {
  const events = fromTrail([{ at: 't', scope: 'hub:search', path: '/api/search', status: 502, message: 'x'.repeat(500) }]);
  assert.equal(events[0].kind, 'hub:search');
  assert.ok(events[0].detail.startsWith('/api/search → 502: xxx'));
  assert.equal(events[0].detail.length, 200);
});

test('events are printed in time order whichever buffer they came from', () => {
  const lines = reportLines({
    description: 'x', url: '', app: { version: '1', build: '2' }, platform: { os: 'o', version: 'v' }, now: 'n',
    events: [{ at: '2026-09-18T12:00:02Z', kind: 'b', detail: '' }, { at: '2026-09-18T12:00:01Z', kind: 'a', detail: '' }],
  });
  assert.ok(lines.indexOf('2026-09-18T12:00:01Z a: ') < lines.indexOf('2026-09-18T12:00:02Z b: '));
});

test('the mail address carries the whole report and goes to the operator', () => {
  const url = mailto(REPORT_TO, 'PanelFlow 1 (2)', ['line one', 'line two']);
  assert.ok(url.startsWith(`mailto:${REPORT_TO}?subject=PanelFlow%201%20(2)&body=`));
  assert.equal(decodeURIComponent(url.split('&body=')[1]), 'line one\nline two');
});
