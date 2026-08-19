// The "Move a whole site" dialog, and the counts it offers.
//
// The dialog names each site with how many series sit on it — "old.test (41)" —
// and that number is the only thing telling the reader whether the move they
// just ran actually took. It was read off the library once, when the dialog
// opened, and never again: the move finished, the dialog stayed open to report
// what happened, and the menu behind the report still said 41. Running the
// search a second time then searched a site that was already empty.
//
// The rebuild is lifted out of the shipping web/app.js with `new Function`, the
// way web-settings.test.js does it, so a test cannot pass against a page that
// does not do this.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'web', 'app.js'), 'utf8');

const FILL = (() => {
  const a = src.indexOf('function fillMigrateSources() {');
  const b = src.indexOf("$('migrate-open').addEventListener", a);
  assert.ok(a !== -1 && b > a, 'web/app.js no longer keeps the source list where this test looks');
  return src.slice(a, b);
})();

/**
 * A <select> that behaves the way the real one does about its value, because
 * that is the half of this the fix turns on: assigning a value no option
 * carries leaves a select showing nothing, and clearing the options drops the
 * selection to whatever is appended first.
 */
function select() {
  return {
    options: [],
    _value: '',
    set innerHTML(v) { if (v === '') { this.options = []; this._value = ''; } },
    get innerHTML() { return ''; },
    appendChild(o) { this.options.push(o); if (this.options.length === 1) this._value = o.value; },
    get value() { return this._value; },
    set value(v) { this._value = this.options.some((o) => o.value === v) ? v : ''; },
    get labels() { return this.options.map((o) => o.textContent); },
  };
}

/** `fillMigrateSources` over a stub select and a library we control. */
function build(rows) {
  const from = select();
  const document = { createElement: () => ({ value: '', textContent: '' }) };
  const library = rows.slice();
  const fill = new Function('$', 'document', 'library', `${FILL}\nreturn fillMigrateSources;`)(
    (id) => (id === 'm-from' ? from : assert.fail(`asked for #${id}`)), document, library);
  return { from, library, fill };
}

const on = (domain, n) => Array.from({ length: n }, (_, i) => ({ sourceDomain: domain, title: `${domain} ${i}` }));

test('every site is listed with its count, commonest first', () => {
  const { from, fill } = build([...on('a.test', 2), ...on('b.test', 3)]);
  fill();
  assert.deepEqual(from.labels, ['Every site (5 series)', 'b.test (3)', 'a.test (2)']);
  assert.equal(from.value, '', 'the dialog opens on "every site"');
});

test('a site emptied by the move drops out of the list', () => {
  // The bug, in one test: the counts are read again, so the site that has just
  // been emptied is gone and the one it moved to has grown.
  const { from, library, fill } = build([...on('old.test', 3), ...on('new.test', 1)]);
  fill();
  from.value = 'old.test';
  assert.deepEqual(from.labels, ['Every site (4 series)', 'old.test (3)', 'new.test (1)']);

  library.length = 0;
  library.push(...on('new.test', 4));
  fill();
  assert.deepEqual(from.labels, ['Every site (4 series)', 'new.test (4)']);
});

test('the site being moved from falls back to "every site" once it is empty', () => {
  // And not to a blank menu, which is what assigning a value no option carries
  // leaves behind — a dialog whose "from" field looks unset and searches
  // everything the next time the button is pressed.
  const { from, library, fill } = build([...on('old.test', 3), ...on('new.test', 1)]);
  fill();
  from.value = 'old.test';
  library.length = 0;
  library.push(...on('new.test', 4));
  fill();
  assert.equal(from.value, '');
  assert.equal(from.options[0].value, '', 'the fallback is not the first option');
});

test('a site that survives the move keeps the selection', () => {
  // A partial move — some series were not found on the new site — leaves the
  // old one still worth searching, and re-picking it by hand every time is the
  // thing the reader would notice second.
  const { from, library, fill } = build(on('old.test', 5));
  fill();
  from.value = 'old.test';
  library.length = 2;
  fill();
  assert.equal(from.value, 'old.test');
  assert.deepEqual(from.labels, ['Every site (2 series)', 'old.test (2)']);
});

test('the move rebuilds the list, after the library has been refetched', () => {
  // Order matters and cannot be checked by calling the function: refresh() is
  // what replaces `library`, and rebuilding before it would count the rows the
  // move already invalidated.
  const a = src.indexOf("$('m-run').addEventListener");
  const b = src.indexOf('} catch (err) {', a);
  assert.ok(a !== -1 && b > a, 'web/app.js no longer keeps the move where this test looks');
  const body = src.slice(a, b);
  const refreshed = body.indexOf('await refresh();');
  const rebuilt = body.indexOf('fillMigrateSources();');
  assert.ok(refreshed !== -1, 'the move no longer refetches the library');
  assert.ok(rebuilt !== -1, 'the move leaves the counts it just invalidated on screen');
  assert.ok(rebuilt > refreshed, 'the counts are rebuilt from a library the move has not landed in yet');
});

test('opening the dialog builds the list through the same function', () => {
  const a = src.indexOf("$('migrate-open').addEventListener");
  const b = src.indexOf("$('m-cancel')", a);
  const body = src.slice(a, b);
  assert.match(body, /fillMigrateSources\(\);/, 'the dialog builds its own list again');
  assert.ok(!body.includes('new Map()'), 'the dialog counts the library itself again');
});
