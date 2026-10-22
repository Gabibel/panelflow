// A tracker's grade and dates, kept as the tracker holds them.
//
// AniList lets each reader pick how they grade: out of 100, out of 10 with a
// decimal, out of 10, five stars or three faces. Every request here used to ask
// for `score(format: POINT_10)`, which AniList answers by rounding, so a reader
// who gave 85/100 got a 9 in PanelFlow, saw "9/10" on the phone, and would have
// got 90 back on AniList had it ever been sent. MyAnimeList has one scale,
// whole numbers from 1 to 10, and keeps it.
//
// Dates are the other half of the same promise: a start date a reader only
// half remembers ("March 2024") is a date on both trackers, and it has to come
// back as written, whatever the time zone of the machine doing the copying.
//
// Owner's iPhone report, 2026-10-22 (point 3).
process.env.TZ = 'Pacific/Kiritimati'; // UTC+14: any trip through UTC moves the day

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, addEntry, newUser, shutdown, base } from '../test-support/harness.js';
import { db } from '../src/db.js';
import * as Prefs from '../src/prefs.js';

const scoreIn = (...a) => Prefs.scoreIn(...a);
const scoreOf = (...a) => Prefs.scoreOf(...a);

after(async () => { globalThis.fetch = realFetch; await shutdown(); });

const realFetch = globalThis.fetch;
let outbound = null;
globalThis.fetch = async (input, init) => {
  const url = String(input?.url ?? input);
  if (url.startsWith(base)) return realFetch(input, init);
  if (!outbound) throw new Error(`unexpected outbound fetch: ${url}`);
  return outbound(url, init);
};

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

const connect = (userId, service, user = null) => db.prepare(`
  INSERT INTO trackers (user_id, service, access_token, refresh_token, expires_at, remote_user)
  VALUES (?, ?, 'tok', NULL, NULL, ?)
`).run(userId, service, user);

/**
 * What AniList answers for `score(format: X)`: the grade it stores is always
 * the 0-100 one, and any other format is that number converted, rounded the
 * way AniList rounds. With no format, the reader's own.
 */
function asFormat(raw, format) {
  switch (format) {
    case 'POINT_100': return raw;
    case 'POINT_10_DECIMAL': return raw / 10;
    case 'POINT_10': return Math.round(raw / 10);
    case 'POINT_5': return Math.round(raw / 20);
    case 'POINT_3': return raw === 0 ? 0 : raw <= 35 ? 1 : raw <= 60 ? 2 : 3;
    default: throw new Error(`no such format ${format}`);
  }
}

/** One reader's AniList account, answering whatever is asked of it. */
function anilistAccount({ format, rows }) {
  const calls = { saved: [] };
  outbound = async (url, init) => {
    assert.equal(url, 'https://graphql.anilist.co');
    const { query, variables } = JSON.parse(init.body);
    const wanted = /score\(format: (\w+)\)/.exec(query)?.[1] ?? format;
    const row = (r) => ({
      status: r.status, progress: r.progress, repeat: 0,
      score: asFormat(r.raw, wanted),
      startedAt: r.startedAt, completedAt: r.completedAt,
    });
    if (query.includes('SaveMediaListEntry')) {
      calls.saved.push({ query, variables });
      return json({ data: { SaveMediaListEntry: { id: 1 } } });
    }
    const data = {};
    if (/\bViewer\b/.test(query)) data.Viewer = { id: 7, mediaListOptions: { scoreFormat: format } };
    if (/\bUser\(/.test(query)) data.User = { id: 7, mediaListOptions: { scoreFormat: format } };
    if (query.includes('MediaListCollection')) {
      data.MediaListCollection = {
        lists: [{
          entries: rows.map((r) => ({
            ...row(r),
            media: {
              siteUrl: `https://anilist.co/manga/${r.id}`, status: 'RELEASING', countryOfOrigin: 'JP',
              title: { romaji: r.title }, coverImage: {},
            },
          })),
        }],
      };
    }
    if (query.includes('Media(id:')) data.Media = { mediaListEntry: null };
    if (query.includes('Page(')) {
      // The catalogue: the reader's own row rides along with each hit, or
      // none once they have taken the series off their list.
      data.Page = {
        media: rows.map((r) => ({
          id: r.id, synonyms: [], title: { romaji: r.title, english: null, native: null },
          mediaListEntry: r.gone ? null : row(r),
        })),
      };
    }
    return json({ data });
  };
  return calls;
}

const library = async (token) => (await api('GET', '/api/library', undefined, token)).body;
const prefs = async (token) => (await api('GET', '/api/prefs', undefined, token)).body.prefs;

const MARCH_FIRST = { year: 2024, month: 3, day: 1 };
const MARCH = { year: 2024, month: 3, day: null };

// --- (a) out of 100 ----------------------------------------------------------

test('an 85/100 on AniList is 85 in PanelFlow, and goes back as 85', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist', 'reader100');
  const rows = [{
    id: 30002, title: 'Ao no Hako', status: 'CURRENT', progress: 12, raw: 85,
    startedAt: MARCH_FIRST, completedAt: MARCH,
  }];
  anilistAccount({ format: 'POINT_100', rows });
  const r = await api('POST', '/api/import/anilist/account', {}, u.token);
  assert.equal(r.status, 200);

  const [entry] = await library(u.token);
  const format = (await prefs(u.token)).scoreFormat;
  assert.equal(format, 'POINT_100', 'the reader grades out of 100, and the account now says so');
  assert.equal(scoreIn(entry.score, format), 85, 'shown as 85, not 9 or 8.5');

  // The sheet reads the tracker's own row with the same grade.
  const sheet = await api('GET', '/api/trackers/entry?title=Ao%20no%20Hako', undefined, u.token);
  assert.equal(sheet.body.scoreFormat, 'POINT_100');
  assert.equal(scoreIn(sheet.body.entries[0].score, 'POINT_100'), 85);

  // Taken off AniList, then put back from PanelFlow: the same grade arrives.
  rows[0].gone = true;
  const calls = anilistAccount({ format: 'POINT_100', rows });
  const added = await api('POST', `/api/trackers/anilist/add/${entry.id}`, {}, u.token);
  assert.equal(added.body.added, true, JSON.stringify(added.body));
  assert.equal(calls.saved.at(-1).variables.scoreRaw, 85);
});

// --- (b) out of 10, with a decimal --------------------------------------------

test('a 7.5 out of 10 survives the import, the screen and the trip back', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist', 'reader10dec');
  const rows = [{
    id: 30003, title: 'Blue Lock', status: 'CURRENT', progress: 3, raw: 75,
    startedAt: MARCH_FIRST, completedAt: { year: null, month: null, day: null },
  }];
  anilistAccount({ format: 'POINT_10_DECIMAL', rows });
  await api('POST', '/api/import/anilist/account', {}, u.token);

  const [entry] = await library(u.token);
  assert.equal(entry.score, 7.5, 'not rounded to 8');
  assert.equal(scoreIn(entry.score, 'POINT_10_DECIMAL'), 7.5);

  rows[0].gone = true;
  const calls = anilistAccount({ format: 'POINT_10_DECIMAL', rows });
  await api('POST', `/api/trackers/anilist/add/${entry.id}`, {}, u.token);
  assert.equal(calls.saved.at(-1).variables.scoreRaw, 75);

  // And a grade typed on the phone in that format is stored as typed.
  const put = await api('PUT', `/api/library/${entry.id}`, { score: scoreOf(6.5, 'POINT_10_DECIMAL') }, u.token);
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.equal(put.body.score, 6.5);
});

test('each AniList format reads and writes its own numbers', () => {
  // [format, what the reader sees, what is stored out of 10]
  for (const [format, shown, stored] of [
    ['POINT_100', 85, 8.5], ['POINT_100', 7, 0.7],
    ['POINT_10_DECIMAL', 7.5, 7.5], ['POINT_10', 8, 8],
    ['POINT_5', 4, 8], ['POINT_3', 3, 8.5], ['POINT_3', 2, 6], ['POINT_3', 1, 3.5],
  ]) {
    assert.equal(scoreOf(shown, format), stored, `${format} ${shown}`);
    assert.equal(scoreIn(stored, format), shown, `${format} ${stored}`);
  }
  assert.equal(scoreIn(null, 'POINT_100'), null);
  assert.equal(scoreOf(101, 'POINT_100'), null);
  assert.equal(scoreOf(7.55, 'POINT_10_DECIMAL'), null, 'one decimal, as AniList has');
});

// --- (c) dates, both ways -----------------------------------------------------

test('dates come back from AniList as written, a month-only one included, and go back the same', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist', 'readerdates');
  const rows = [{
    id: 30004, title: 'Kingdom', status: 'COMPLETED', progress: 800, raw: 90,
    startedAt: MARCH_FIRST, completedAt: MARCH,
  }];
  anilistAccount({ format: 'POINT_10', rows });
  await api('POST', '/api/import/anilist/account', {}, u.token);

  const [entry] = await library(u.token);
  assert.equal(entry.startDate, '2024-03-01');
  assert.equal(entry.finishDate, '2024-03', 'March 2024 is a date AniList holds, not no date');

  const backup = (await api('GET', '/api/export', undefined, u.token)).body;
  const [saved] = backup.library;
  assert.equal(saved.startDate, '2024-03-01');
  assert.equal(saved.finishDate, '2024-03');

  rows[0].gone = true;
  const calls = anilistAccount({ format: 'POINT_10', rows });
  await api('POST', `/api/trackers/anilist/add/${entry.id}`, {}, u.token);
  const { variables } = calls.saved.at(-1);
  assert.deepEqual(variables.startedAt, MARCH_FIRST);
  assert.deepEqual(variables.completedAt, MARCH);
});

test('dates from MyAnimeList, partial ones too, survive the account, the file and the trip back', async () => {
  const u = await newUser();
  await connect(u.id, 'mal');
  outbound = async () => json({
    data: [{
      node: { id: 2, title: 'Berserk', main_picture: {}, status: 'currently_publishing' },
      list_status: {
        status: 'reading', num_chapters_read: 370, score: 7, num_times_reread: 0,
        start_date: '2024-03-01', finish_date: '2024-03',
      },
    }],
    paging: {},
  });
  await api('POST', '/api/import/mal/account', {}, u.token);
  const [entry] = await library(u.token);
  assert.equal(entry.startDate, '2024-03-01');
  assert.equal(entry.finishDate, '2024-03');

  // The MAL file writes the missing day as 00, and reading it back gives the
  // month again rather than nothing.
  const xml = await (await realFetch(`${base}/api/export/mal`, {
    headers: { Authorization: `Bearer ${u.token}` },
  })).text();
  assert.match(xml, /<my_start_date>2024-03-01<\/my_start_date>/);
  assert.match(xml, /<my_finish_date>2024-03-00<\/my_finish_date>/);
  const other = await newUser();
  outbound = null;
  const back = await realFetch(`${base}/api/import/mal`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${other.token}`, 'Content-Type': 'text/xml' },
    body: xml,
  });
  assert.equal(back.status, 200, await back.clone().text());
  const [copy] = await library(other.token);
  assert.equal(copy.startDate, '2024-03-01');
  assert.equal(copy.finishDate, '2024-03');
});

test('a partial date is a date the library accepts from any client', async () => {
  const u = await newUser();
  const e = await addEntry(u.token, { title: 'Vagabond' });
  for (const [start, finish] of [['2024', '2024-03'], ['2024-03-01', '2024-03-01']]) {
    const r = await api('PUT', `/api/library/${e.id}`, { startDate: start, finishDate: finish }, u.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.startDate, start);
    assert.equal(r.body.finishDate, finish);
  }
  for (const bad of ['2024-13', '2024-02-30', '0000', '24-03']) {
    const r = await api('PUT', `/api/library/${e.id}`, { startDate: bad }, u.token);
    assert.equal(r.status, 400, bad);
  }
});

// --- (d) MyAnimeList stays whole ----------------------------------------------

test('MyAnimeList keeps its whole numbers out of 10, both ways', async () => {
  const u = await newUser();
  await connect(u.id, 'mal');
  const e = await addEntry(u.token, {
    title: 'Vinland Saga', score: 8.5, startDate: '2024-03-01', finishDate: '2024-03',
  });
  const patched = [];
  outbound = async (url, init) => {
    if (init?.method === 'PATCH') {
      patched.push(Object.fromEntries(new URLSearchParams(init.body)));
      return json({});
    }
    if (url.includes('/v2/manga?')) {
      return json({ data: [{ node: { id: 642, title: 'Vinland Saga', alternative_titles: {}, main_picture: {} } }] });
    }
    return json({});
  };
  const r = await api('POST', `/api/trackers/mal/add/${e.id}`, {}, u.token);
  assert.equal(r.body.added, true, JSON.stringify(r.body));
  assert.equal(patched.at(-1).score, '9', 'MAL takes a whole number, the nearest one');
  assert.equal(patched.at(-1).start_date, '2024-03-01');
  assert.equal(patched.at(-1).finish_date, '2024-03');

  const xml = await (await realFetch(`${base}/api/export/mal`, {
    headers: { Authorization: `Bearer ${u.token}` },
  })).text();
  assert.match(xml, /<my_score>9<\/my_score>/);
});

// --- the device keeps the format -----------------------------------------------

test('the sheet lookup leaves the format on the device, for every score it draws', async () => {
  const { bootCore, json: reply } = await import('../test-support/core.js');
  const { hub, storage } = bootCore({
    storage: { authToken: 't', accountPrefs: { theme: 'dark' } },
    fetch: async (url) => (String(url).includes('/api/trackers/entry')
      ? reply({ title: 'Ao no Hako', connected: ['anilist'], entries: [], errors: [], scoreFormat: 'POINT_100' })
      : reply({})),
  });
  const answer = await hub({ type: 'trackerEntry', title: 'Ao no Hako' });
  assert.equal(answer.scoreFormat, 'POINT_100');
  assert.deepEqual(storage().accountPrefs, { theme: 'dark', scoreFormat: 'POINT_100' },
    'kept beside the account’s other answers, which are untouched');
});
