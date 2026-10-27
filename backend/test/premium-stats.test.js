// The detailed statistics of PanelFlow Premium (backend/src/advanced-stats.js).
//
// Two things are held here. The figures are right: weeks and months with
// their empty ones kept, hours on the reader's clock, a year's review, and
// "when will I have caught up" at the reader's recent pace. And they go to
// an account the server knows is Premium, and to nobody else, whatever the
// request says about itself.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, addEntry, shutdown } from '../test-support/harness.js';
import {
  catchUp, fillMonths, fillWeeks, tzOffset, weekOf, WEEKS, MONTHS,
} from '../src/advanced-stats.js';

const { db } = await import('../src/db.js');

after(shutdown);

const isoDay = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return isoDay(d);
};

async function makePremium(id) {
  await db.prepare('UPDATE users SET premium_until = ? WHERE id = ?')
    .run(new Date(Date.now() + 30 * 86400_000).toISOString(), id);
}

/** One history row, as the reader's device would have filed it. */
async function read(userId, libraryId, day, n, { at = `${day} 21:30:00`, seconds = 300 } = {}) {
  await db.prepare(`INSERT INTO history (user_id, library_id, chapter_url, day, chapter_label, pages, seconds, read_at)
    VALUES (?, ?, ?, ?, ?, 20, ?, ?)`).run(userId, libraryId, `https://scan.test/s/${libraryId}/${n}`, day, `Ch. ${n}`, seconds, at);
}

// --- the arithmetic ---------------------------------------------------------

test('a week starts on Monday, and every week and month is there, empty or not', () => {
  assert.equal(weekOf('2026-10-28'), '2026-10-26', 'a Wednesday');
  assert.equal(weekOf('2026-11-01'), '2026-10-26', 'a Sunday ends the week');
  assert.equal(weekOf('2026-10-26'), '2026-10-26');
  const weeks = fillWeeks([{ week: '2026-10-19', chapters: 4, seconds: 60 }], '2026-10-28');
  assert.equal(weeks.length, WEEKS);
  assert.equal(weeks.at(-1).week, '2026-10-26');
  assert.deepEqual(weeks.at(-2), { week: '2026-10-19', chapters: 4, seconds: 60 });
  assert.equal(weeks.at(-3).chapters, 0, 'a week with nothing read is a zero, not a missing bar');
  const months = fillMonths([], '2026-03-15');
  assert.equal(months.length, MONTHS);
  assert.equal(months.at(-1).month, '2026-03');
  assert.equal(months[0].month, '2024-04');
});

test('the clock offset is a whole number of minutes on Earth, or nothing', () => {
  assert.equal(tzOffset('60'), 60);
  assert.equal(tzOffset('-300'), -300);
  for (const bad of ['2000', 'abc', '1.5', undefined, "60 minutes'); DROP TABLE users; --"]) {
    assert.equal(tzOffset(bad), 0, String(bad));
  }
});

test('catching up is counted at the recent pace, and never invented', () => {
  const rows = [
    { id: 'a', title: 'Fast', latest: '120', at: 100, recent: 16 },   // 2 a week, 20 behind
    { id: 'b', title: 'Idle', latest: '50', at: 10, recent: 0 },      // no pace
    { id: 'c', title: 'Done', latest: '30', at: 30, recent: 5 },      // nothing to catch up
    { id: 'd', title: 'Odd', latest: 'Final', at: 3, recent: 2 },     // no number to count on
  ];
  const out = catchUp(rows);
  assert.deepEqual(out.map((r) => [r.id, r.behind, r.perWeek, r.weeks]), [['a', 20, 2, 10], ['b', 40, 0, null]]);
});

// --- who gets them ------------------------------------------------------------

test('an account that is not Premium gets today\'s statistics and nothing more', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  await read(u.id, e.id, daysAgo(1), 1);
  const s = await api('GET', '/api/history/stats?tz=60&premium=1&advanced=1', undefined, u.token);
  assert.equal(s.status, 200);
  assert.equal(s.body.premium, false);
  assert.equal(s.body.advanced, null);
  assert.equal(s.body.chapters, 1, 'the free figures are all still there');
  assert.ok('current' in s.body && 'topSeries' in s.body);
});

test('a lapsed subscription stops the detailed figures at once', async () => {
  const u = await newUser();
  await db.prepare('UPDATE users SET premium_until = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), u.id);
  const s = await api('GET', '/api/history/stats', undefined, u.token);
  assert.equal(s.body.advanced, null);
});

// --- what Premium gets --------------------------------------------------------

test('Premium gets the weeks, the months, the hours on its own clock and the weekdays', async () => {
  const u = await newUser();
  await makePremium(u.id);
  const e = await addEntry(u.token);
  // Three reads at 21:30 UTC, today and two days before; one three weeks ago.
  await read(u.id, e.id, daysAgo(0), 1);
  await read(u.id, e.id, daysAgo(2), 2);
  await read(u.id, e.id, daysAgo(2), 3);
  await read(u.id, e.id, daysAgo(21), 4);

  const s = await api('GET', '/api/history/stats?tz=120', undefined, u.token);
  assert.equal(s.body.premium, true);
  const a = s.body.advanced;
  assert.equal(a.weeks.length, WEEKS);
  assert.equal(a.weeks.reduce((n, w) => n + w.chapters, 0), 4);
  assert.equal(a.months.length, MONTHS);
  assert.equal(a.months.reduce((n, m) => n + m.chapters, 0), 4);
  // 21:30 UTC on a clock two hours east is 23:30.
  assert.equal(a.hours.length, 24);
  assert.equal(a.hours[23], 4);
  assert.equal(a.hours[21], 0);
  assert.equal(a.weekdays.length, 7);
  assert.equal(a.weekdays.reduce((n, d) => n + d, 0), 4);
  const wd = (day) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  assert.ok(a.weekdays[wd(daysAgo(2))] >= 2, 'Monday first, and the day the reader filed it on');
});

test('the year in review counts the year, its new series and its best month', async () => {
  const u = await newUser();
  await makePremium(u.id);
  const old = await addEntry(u.token, { title: 'Started long ago' });
  const fresh = await addEntry(u.token, { title: 'Started this year' });
  const thisYear = new Date().getUTCFullYear();
  const lastYearDay = `${thisYear - 1}-06-15`;
  await read(u.id, old.id, lastYearDay, 1);
  await read(u.id, old.id, daysAgo(0), 2);
  await read(u.id, fresh.id, daysAgo(0), 1);
  await read(u.id, fresh.id, daysAgo(1), 2);

  const a = (await api('GET', '/api/history/stats', undefined, u.token)).body.advanced;
  // Only the rows of this year count; daysAgo(1) may be last year on 1 January.
  const inYear = [daysAgo(0), daysAgo(0), daysAgo(1)].filter((d) => d.startsWith(String(thisYear))).length;
  assert.equal(a.year.year, thisYear);
  assert.equal(a.year.chapters, inYear);
  assert.equal(a.year.newSeries, 1, 'the series first read last year is not new this year');
  assert.equal(a.year.top[0].title, 'Started this year');
  assert.equal(a.lastYear.year, thisYear - 1);
  assert.equal(a.lastYear.chapters, 1 + (inYear === 3 ? 0 : 1));
  assert.ok(a.year.bestMonth && a.year.bestMonth.chapters >= 1);
  assert.ok(a.year.longestStreak >= 1);
});

test('catching up uses the bookmark and the site\'s latest chapter', async () => {
  const u = await newUser();
  await makePremium(u.id);
  const e = await addEntry(u.token, { title: 'Behind' });
  await db.prepare("UPDATE library SET last_known_chapter = '40', folder = 'reading' WHERE id = ?").run(e.id);
  await db.prepare(`INSERT INTO progress (user_id, library_id, chapter_url, chapter_label, furthest_num)
    VALUES (?, ?, ?, 'Ch. 20', 20)`).run(u.id, e.id, 'https://scan.test/behind/20');
  // Eight chapters in the last eight weeks: one a week, twenty behind.
  for (let i = 0; i < 8; i++) await read(u.id, e.id, daysAgo(i * 6), 12 + i);
  const a = (await api('GET', '/api/history/stats', undefined, u.token)).body.advanced;
  assert.deepEqual(a.catchUp.map((c) => [c.title, c.behind, c.perWeek, c.weeks]), [['Behind', 20, 1, 20]]);
});

test('one kind of work narrows the detailed figures too', async () => {
  const u = await newUser();
  await makePremium(u.id);
  const manga = await addEntry(u.token, { title: 'A manga' });
  const anime = await addEntry(u.token, { title: 'An anime', medium: 'anime' });
  await read(u.id, manga.id, daysAgo(0), 1);
  await read(u.id, anime.id, daysAgo(0), 1);
  const a = (await api('GET', '/api/history/stats?medium=anime', undefined, u.token)).body.advanced;
  assert.equal(a.months.reduce((n, m) => n + m.chapters, 0), 1);
  assert.deepEqual(a.year.top.map((t) => t.title), ['An anime']);
});

test('an account never sees another account\'s figures', async () => {
  const a = await newUser();
  const b = await newUser();
  await makePremium(a.id);
  const e = await addEntry(b.token);
  await read(b.id, e.id, daysAgo(0), 1);
  const s = (await api('GET', '/api/history/stats', undefined, a.token)).body.advanced;
  assert.equal(s.months.reduce((n, m) => n + m.chapters, 0), 0);
  assert.equal(s.catchUp.length, 0);
});

// --- the phone ----------------------------------------------------------------

test('the core sends the reader\'s clock with the statistics request', async () => {
  const { bootCore, json } = await import('../test-support/core.js');
  const asked = [];
  const { hub } = bootCore({
    storage: { authToken: 'tok', authUser: { id: 'u', email: 'r@example.test' }, dataOwner: 'u' },
    fetch: async (url) => { asked.push(String(url)); return json({ chapters: 0 }); },
  });
  await hub({ type: 'getStats', medium: 'anime' });
  const url = asked.find((u) => u.includes('/api/history/stats'));
  assert.match(url, /\?medium=anime&tz=-?\d+$/);
});

test('the page draws the detailed part only from what the server sent', async () => {
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../../native/src/screens/settings/StatsPage.js', import.meta.url), 'utf8');
  // Drawn from `advanced`, in its own boundary; offered only to an account the
  // server said is not Premium (a device with no account has no `premium`).
  assert.match(page, /\{stats\.advanced && \(\s*<ErrorBoundary/);
  assert.match(page, /!stats\.advanced && stats\.premium === false/);
  assert.match(page, /onPage\('premium'\)/);
  const more = readFileSync(new URL('../../native/src/screens/settings/StatsMore.js', import.meta.url), 'utf8');
  assert.ok(!/premium/i.test(more.replace(/^\/\/.*$/gm, '')), 'the drawing decides nothing about who may see it');
});
