import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, addEntry, newUser, shutdown } from '../test-support/harness.js';
import { db } from '../src/db.js';

after(shutdown);

const url = (n) => `https://example-manga-site.test/manga/${n}`;

test('create requires the three identifying fields', async () => {
  const u = await newUser();
  const full = { title: 'T', sourceDomain: 'd.test', sourceUrl: url('req') };
  for (const missing of ['title', 'sourceDomain', 'sourceUrl']) {
    const body = { ...full };
    delete body[missing];
    const r = await api('POST', '/api/library', body, u.token);
    assert.equal(r.status, 400, `missing ${missing}`);
    assert.match(r.body.error, /required/);
  }
  const ok = await api('POST', '/api/library', full, u.token);
  assert.equal(ok.status, 201);
});

test('a bare entry gets sane defaults', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  assert.equal(e.folder, 'reading');
  assert.equal(e.rereads, 0);
  assert.deepEqual(e.tags, []);
  assert.equal(e.coverUrl, null);
  assert.equal(e.lastKnownChapter, null);
  assert.equal(e.score, null);
  assert.equal(e.language, null);
  assert.equal(e.note, null);
  assert.equal(e.startDate, null);
  assert.equal(e.finishDate, null);
  assert.equal(e.seriesStatus, null);
  assert.ok(e.dateAdded, 'dateAdded is populated by the schema default');
  assert.ok(e.updatedAt);
  assert.ok(e.id);
});

test('tags survive the JSON round-trip', async () => {
  const u = await newUser();
  const tags = ['Action', 'Sci-Fi', 'école', '日本語', 'a"quote', "it's"];
  const e = await addEntry(u.token, { tags });
  assert.deepEqual(e.tags, tags);
  const list = await api('GET', '/api/library', undefined, u.token);
  assert.deepEqual(list.body[0].tags, tags);
});

test('unicode and long text are stored verbatim', async () => {
  const u = await newUser();
  const title = '転生したらスライムだった件 — Ch. 100 «test» 🐉';
  const note = 'x'.repeat(5000);
  const e = await addEntry(u.token, { title, note });
  assert.equal(e.title, title);
  assert.equal(e.note, note);
});

test('every detail field round-trips through POST', async () => {
  const u = await newUser();
  const e = await addEntry(u.token, {
    coverUrl: 'https://cdn.test/cover.jpg',
    tags: ['drama'],
    lastKnownChapter: '312.5',
    folder: 'paused',
    language: 'Français',
    score: 7,
    note: 'reprendre au tome 4',
    startDate: '2026-01-02',
    finishDate: '2026-03-04',
    rereads: 3,
    seriesStatus: 'ongoing',
  });
  assert.equal(e.coverUrl, 'https://cdn.test/cover.jpg');
  assert.equal(e.lastKnownChapter, '312.5');
  assert.equal(e.folder, 'paused');
  assert.equal(e.language, 'Français');
  assert.equal(e.score, 7);
  assert.equal(e.note, 'reprendre au tome 4');
  assert.equal(e.startDate, '2026-01-02');
  assert.equal(e.finishDate, '2026-03-04');
  assert.equal(e.rereads, 3);
  assert.equal(e.seriesStatus, 'ongoing');
});

test('score 0 is a real score, not an absent one', async () => {
  const u = await newUser();
  const e = await addEntry(u.token, { score: 0, rereads: 0 });
  assert.equal(e.score, 0, '0 must not be coerced to null by a falsy check');
  const put = await api('PUT', `/api/library/${e.id}`, { score: 0 }, u.token);
  assert.equal(put.body.score, 0);
});

test('every folder value is accepted, anything else is not', async () => {
  const u = await newUser();
  for (const folder of ['reading', 'paused', 'plan', 'completed', 'dropped']) {
    const e = await addEntry(u.token, { folder });
    assert.equal(e.folder, folder);
  }
  // Note the asymmetry with score/dates, where '' means "not supplied": an
  // empty folder is invalid input, not an omission, so it is a 400.
  for (const folder of ['READING', 'en cours', 'archived', '', 42, true, ['reading']]) {
    const r = await api('POST', '/api/library', {
      title: 'x', sourceDomain: 'd.test', sourceUrl: url(`bad-${folder}`), folder,
    }, u.token);
    assert.equal(r.status, 400, `folder=${JSON.stringify(folder)}`);
  }
  // Omitting it entirely is the only way to get the default.
  const omitted = await api('POST', '/api/library', {
    title: 'x', sourceDomain: 'd.test', sourceUrl: url('no-folder'),
  }, u.token);
  assert.equal(omitted.status, 201);
  assert.equal(omitted.body.folder, 'reading');
});

test('validation rejects out-of-range and malformed details', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  const bad = [
    // One decimal is a grade (an AniList 85/100 is 8.5); two is not one.
    { score: 11 }, { score: -1 }, { score: 3.55 }, { score: 'huit' },
    { rereads: -1 }, { rereads: 10000 }, { rereads: 1.5 },
    { startDate: '25/07/2026' }, { startDate: '2026-7-5' }, { startDate: 'yesterday' },
    { startDate: '2026-13' }, { startDate: '0000' },
    { finishDate: '2026/07/25' },
    { seriesStatus: 'hiatus' }, { seriesStatus: 'Ongoing' },
    { folder: 'nope' },
  ];
  for (const patch of bad) {
    const r = await api('PUT', `/api/library/${e.id}`, patch, u.token);
    assert.equal(r.status, 400, JSON.stringify(patch));
    assert.ok(r.body.error, 'a 400 must say what is wrong');
  }
  // The rejected writes must not have partially landed.
  const after = await api('GET', `/api/library`, undefined, u.token);
  const still = after.body.find((x) => x.id === e.id);
  assert.equal(still.score, null);
  assert.equal(still.folder, 'reading');
});

test('PUT keeps omitted keys and clears explicit nulls', async () => {
  const u = await newUser();
  const e = await addEntry(u.token, {
    score: 9, note: 'n', language: 'EN', startDate: '2026-01-01',
    finishDate: '2026-02-02', rereads: 2, seriesStatus: 'completed',
    coverUrl: 'https://cdn.test/a.jpg', lastKnownChapter: '10', tags: ['t'],
  });

  // Touch one field; everything else must survive.
  let r = await api('PUT', `/api/library/${e.id}`, { folder: 'dropped' }, u.token);
  assert.equal(r.body.folder, 'dropped');
  assert.equal(r.body.score, 9);
  assert.equal(r.body.note, 'n');
  // A code is stored as the English word every client writes (languages.js).
  assert.equal(r.body.language, 'English');
  assert.equal(r.body.startDate, '2026-01-01');
  assert.equal(r.body.finishDate, '2026-02-02');
  assert.equal(r.body.rereads, 2);
  assert.equal(r.body.seriesStatus, 'completed');
  assert.equal(r.body.coverUrl, 'https://cdn.test/a.jpg');
  assert.equal(r.body.lastKnownChapter, '10');
  assert.deepEqual(r.body.tags, ['t']);
  assert.equal(r.body.title, e.title, 'an omitted title keeps the stored one');

  // Explicit nulls clear.
  r = await api('PUT', `/api/library/${e.id}`, {
    score: null, note: null, language: null, startDate: null,
    finishDate: null, seriesStatus: null, coverUrl: null, lastKnownChapter: null,
  }, u.token);
  for (const k of ['score', 'note', 'language', 'startDate', 'finishDate',
                   'seriesStatus', 'coverUrl', 'lastKnownChapter']) {
    assert.equal(r.body[k], null, `${k} should be cleared`);
  }
  // ...except the two columns that are NOT NULL in the schema.
  assert.equal(r.body.folder, 'dropped', 'folder can never become null');
  assert.equal(r.body.rereads, 2, 'rereads can never become null');
});

test('PUT can empty the tag list', async () => {
  const u = await newUser();
  const e = await addEntry(u.token, { tags: ['a', 'b'] });
  const r = await api('PUT', `/api/library/${e.id}`, { tags: [] }, u.token);
  assert.deepEqual(r.body.tags, []);
});

test('deleting hides the entry but a re-pin revives it with its metadata', async () => {
  const u = await newUser();
  const e = await addEntry(u.token, {
    tags: ['action', 'magic'], score: 6, folder: 'paused',
    coverUrl: 'https://cdn.test/keep.jpg', lastKnownChapter: '55', note: 'keep me',
  });

  assert.equal((await api('DELETE', `/api/library/${e.id}`, undefined, u.token)).status, 204);
  assert.equal((await api('GET', '/api/library', undefined, u.token)).body.length, 0);

  // The extension re-syncs a bare local entry: same URL, no metadata of its own.
  const revived = await api('POST', '/api/library', {
    title: e.title, sourceDomain: 'example-manga-site.test', sourceUrl: e.sourceUrl,
  }, u.token);
  assert.equal(revived.status, 200);
  assert.equal(revived.body.id, e.id, 'same row, not a new one');
  assert.deepEqual(revived.body.tags, ['action', 'magic'], 'a bare re-pin must not wipe tags');
  assert.equal(revived.body.score, 6);
  assert.equal(revived.body.folder, 'paused');
  assert.equal(revived.body.coverUrl, 'https://cdn.test/keep.jpg');
  assert.equal(revived.body.lastKnownChapter, '55');
  assert.equal(revived.body.note, 'keep me');
  assert.equal((await api('GET', '/api/library', undefined, u.token)).body.length, 1);
});

test('a re-pin that carries data overwrites what it carries', async () => {
  const u = await newUser();
  const e = await addEntry(u.token, { tags: ['old'], score: 3, lastKnownChapter: '10' });
  const r = await api('POST', '/api/library', {
    title: 'Renamed', sourceDomain: 'example-manga-site.test', sourceUrl: e.sourceUrl,
    tags: ['new'], score: 9, lastKnownChapter: '20', folder: 'completed',
  }, u.token);
  assert.equal(r.body.id, e.id);
  assert.equal(r.body.title, 'Renamed');
  assert.deepEqual(r.body.tags, ['new']);
  assert.equal(r.body.score, 9);
  assert.equal(r.body.lastKnownChapter, '20');
  assert.equal(r.body.folder, 'completed');
});

test('the same source URL cannot produce two rows', async () => {
  const u = await newUser();
  const e = await addEntry(u.token, { sourceUrl: url('dupe') });
  for (let i = 0; i < 3; i++) {
    const r = await api('POST', '/api/library', {
      title: 'Dupe', sourceDomain: 'example-manga-site.test', sourceUrl: url('dupe'),
    }, u.token);
    assert.equal(r.body.id, e.id);
  }
  assert.equal((await api('GET', '/api/library', undefined, u.token)).body.length, 1);
});

test('two users can pin the same URL without colliding', async () => {
  const a = await newUser();
  const b = await newUser();
  const ea = await addEntry(a.token, { sourceUrl: url('shared'), score: 1 });
  const eb = await addEntry(b.token, { sourceUrl: url('shared'), score: 10 });
  assert.notEqual(ea.id, eb.id);
  assert.equal((await api('GET', '/api/library', undefined, a.token)).body[0].score, 1);
  assert.equal((await api('GET', '/api/library', undefined, b.token)).body[0].score, 10);
});

test('one user cannot read, edit or delete another user entry', async () => {
  const a = await newUser();
  const b = await newUser();
  const ea = await addEntry(a.token, { title: 'Private' });

  const list = await api('GET', '/api/library', undefined, b.token);
  assert.equal(list.body.length, 0, "B's library must not leak A's entry");

  const put = await api('PUT', `/api/library/${ea.id}`, { title: 'Hijacked' }, b.token);
  assert.equal(put.status, 404);

  const del = await api('DELETE', `/api/library/${ea.id}`, undefined, b.token);
  assert.equal(del.status, 404);

  const still = await api('GET', '/api/library', undefined, a.token);
  assert.equal(still.body[0].title, 'Private', 'A entry untouched');
});

test('unknown ids answer 404, not 500', async () => {
  const u = await newUser();
  assert.equal((await api('PUT', '/api/library/does-not-exist', { title: 'x' }, u.token)).status, 404);
  assert.equal((await api('DELETE', '/api/library/does-not-exist', undefined, u.token)).status, 404);
  // A value that looks like SQL rather than an id must be bound, not executed.
  const inj = await api('DELETE', "/api/library/' OR '1'='1", undefined, u.token);
  assert.equal(inj.status, 404);
});

test('a quoted source URL is bound, not interpolated', async () => {
  const u = await newUser();
  const nasty = "https://x.test/manga/'; DROP TABLE library; --";
  const e = await addEntry(u.token, { sourceUrl: nasty, title: "Robert'); DROP TABLE users;--" });
  assert.equal(e.sourceUrl, nasty);
  // The table is still there and still holds the row.
  const list = await api('GET', '/api/library', undefined, u.token);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].sourceUrl, nasty);
});

test('the library lists exactly the live entries', async () => {
  const u = await newUser();
  const made = [];
  for (let i = 0; i < 12; i++) made.push(await addEntry(u.token));
  let list = await api('GET', '/api/library', undefined, u.token);
  assert.equal(list.body.length, 12);
  assert.deepEqual(
    new Set(list.body.map((e) => e.id)),
    new Set(made.map((e) => e.id)),
  );

  await api('DELETE', `/api/library/${made[3].id}`, undefined, u.token);
  await api('DELETE', `/api/library/${made[7].id}`, undefined, u.token);
  list = await api('GET', '/api/library', undefined, u.token);
  assert.equal(list.body.length, 10);
  assert.ok(!list.body.some((e) => e.id === made[3].id || e.id === made[7].id));
});

test('an edited entry moves to the head of the list', async () => {
  const u = await newUser();
  const first = await addEntry(u.token);
  await addEntry(u.token);
  await addEntry(u.token);
  // updated_at has one-second resolution, so wait past the boundary rather
  // than race it — the ordering claim is what is under test.
  await new Promise((r) => setTimeout(r, 1100));
  await api('PUT', `/api/library/${first.id}`, { note: 'touched' }, u.token);
  const list = await api('GET', '/api/library', undefined, u.token);
  assert.equal(list.body[0].id, first.id, 'ORDER BY updated_at DESC');
});

test('one row with unreadable tags does not take the whole library down', async () => {
  // The column is NOT NULL DEFAULT '[]', but rows also arrive from imports and
  // from the migration script — and a bare JSON.parse here meant a single bad
  // value answered every GET /api/library with a 500.
  const u = await newUser();
  const good = await addEntry(u.token, { title: 'Readable' });
  const bad = await addEntry(u.token, { title: 'Broken tags' });
  await db.prepare('UPDATE library SET tags = ? WHERE id = ?').run('not json at all', bad.id);

  const list = await api('GET', '/api/library', undefined, u.token);
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 2);
  assert.deepEqual(list.body.find((e) => e.id === bad.id).tags, []);
  assert.deepEqual(list.body.find((e) => e.id === good.id).tags, []);
});

// --- one spelling for a language (QA It.7, n° 1 and 2) -----------------------

test('a language is stored one way, whichever client sent it', async () => {
  const { normalizeLanguage } = await import('../src/languages.js');
  assert.equal(normalizeLanguage('fr'), 'French');
  assert.equal(normalizeLanguage('FRENCH'), 'French');
  assert.equal(normalizeLanguage('zh'), 'Chinese (Simplified)');
  assert.equal(normalizeLanguage('zh-TW'), 'Chinese (Traditional)');
  assert.equal(normalizeLanguage('ja_JP'), 'ja_JP', 'a region code outside the table is kept as it came');
  assert.equal(normalizeLanguage('Thai'), 'Thai', 'a language a page declared is kept');
  assert.equal(normalizeLanguage('  '), null);
  assert.equal(normalizeLanguage(undefined), undefined, 'absent stays absent: PUT keeps what it is not sent');

  const u = await newUser();
  // Twenty characters, refused at every sync against a limit of sixteen: the
  // series never reached the account (QA It.7, n° 1).
  const e = await addEntry(u.token, { language: 'Chinese (Simplified)' });
  assert.equal(e.language, 'Chinese (Simplified)');
  // The website's code, and a row read back the same as the extension's.
  const r = await api('PUT', `/api/library/${e.id}`, { language: 'ko' }, u.token);
  assert.equal(r.body.language, 'Korean');
});

test('a reading that ends before it starts is refused', async () => {
  const u = await newUser();
  const e = await addEntry(u.token, {});
  const r = await api('PUT', `/api/library/${e.id}`, { startDate: '2026-01-15', finishDate: '2025-12-01' }, u.token);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /finishDate is before startDate/);
  const ok = await api('PUT', `/api/library/${e.id}`, { startDate: '2026-01-15', finishDate: '2026-01-15' }, u.token);
  assert.equal(ok.status, 200, 'a reading finished the day it started is a reading');
});

test('every client spells a language the way the server stores it', async () => {
  // Five copies of one table: the server's, the website's and the popup's
  // (shared/i18n.js), the extension pages' (extension/i18n.js), the phone's
  // pages' (mobile/inject/i18n.js) and the phone app's (native/src/i18n.js).
  // They drifted once — "fr" on one side, "French" on the other — and a
  // language was erased by the side that could not read it (QA It.7, n° 2).
  const { normalizeLanguage, LANGUAGE_NAMES } = await import('../src/languages.js');
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const load = (file) => {
    const scope = { chrome: undefined, navigator: { languages: ['en'] }, PanelFlowMessages: { en: {} } };
    const src = readFileSync(join(root, file), 'utf8');
    const document = {
      documentElement: { lang: '', setAttribute() {}, getAttribute: () => null },
      querySelectorAll: () => [],
      addEventListener() {},
    };
    // navigator is handed in like the rest: Node has one of its own only from 21.
    new Function('globalThis', 'self', 'window', 'chrome', 'localStorage', 'document', 'navigator', src)(
      scope, scope, scope, undefined, { getItem: () => null, setItem() {}, removeItem() {} }, document, scope.navigator);
    return scope.PanelFlowI18n;
  };
  const native = await import('../../native/src/i18n.js').catch(() => null);
  const keys = {
    'shared/i18n.js': load('shared/i18n.js').languageKey,
    'mobile/inject/i18n.js': load('mobile/inject/i18n.js').languageKey,
    ...(native ? { 'native/src/i18n.js': native.languageKey } : {}),
  };
  const samples = [...LANGUAGE_NAMES, 'fr', 'EN', 'ja', 'ko', 'zh', 'zh-TW', 'zh-hans', 'es', 'Thai', ' French '];
  for (const [file, key] of Object.entries(keys)) {
    for (const v of samples) assert.equal(key(v), normalizeLanguage(v), `${file} spells ${v} otherwise`);
  }
  // The extension's own copy reads chrome.i18n, so it is compared by its table.
  const ext = readFileSync(join(root, 'extension', 'i18n.js'), 'utf8');
  const shared = readFileSync(join(root, 'shared', 'i18n.js'), 'utf8');
  const table = (src) => src.match(/const LANGUAGE_CODES = \{[\s\S]*?\};\s*\/\/[^\n]*\n\s*const LANGUAGE_ALIASES = \{[\s\S]*?\};/)?.[0].replace(/\s+/g, ' ');
  assert.ok(table(ext), 'extension/i18n.js has no language table');
  assert.equal(table(ext), table(shared), 'extension/i18n.js has its own idea of the languages');
});
