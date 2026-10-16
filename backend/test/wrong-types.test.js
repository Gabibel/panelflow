// A value of the wrong type is a 400 that names the field, never a 500.
//
// JSON can put an object or a list anywhere a client meant text, and the
// database driver cannot bind either. So a library entry whose title, site,
// note, language or chapter arrived as one went as far as the SQL and came back
// as a 500 that said "internal error" and named nothing; so did a reading
// session whose series id was one, a tracker link whose title was one, a move
// of a series, and signing up or in with a form that sent one. Each door now
// refuses the value by name, the way it already refused a score or a date it
// could not use, and before anything is written.
//
// The last test is the net under all of them: every write route a client
// calls, every field it reads, three shapes of wrong. A new field that reaches
// a statement unchecked fails there.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, base, newUser, addEntry, shutdown } from '../test-support/harness.js';
import { db } from '../src/db.js';

after(shutdown);

/** One request with its JSON body sent as written, for what JSON.stringify cannot spell. */
async function rawJson(method, path, text, token) {
  const resp = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: text,
  });
  return { status: resp.status, body: await resp.json().catch(() => null) };
}

const libraryOf = async (token) => (await api('GET', '/api/library', undefined, token)).body;

/** A series as a client adds it. */
const series = (n, extra = {}) => ({
  title: `Series ${n}`, sourceDomain: 'scans.test', sourceUrl: `https://scans.test/manga/${n}`, ...extra,
});

// The shapes JSON has that are not text: an object, a list, a list with text in
// it (which String() would have flattened into something that looked fine), a
// boolean and a number.
const NOT_TEXT = [{}, { x: 1 }, [], ['a'], true, 42];

// --- the library: what names a series --------------------------------------

test('a title or a site that is not text is refused by name, and nothing is stored', async () => {
  const u = await newUser();
  let n = 0;
  for (const value of NOT_TEXT) {
    for (const field of ['title', 'sourceDomain']) {
      const r = await api('POST', '/api/library', series(n++, { [field]: value }), u.token);
      assert.equal(r.status, 400, `${field}=${JSON.stringify(value)}`);
      assert.match(r.body.error, new RegExp(`${field} must be text`));
    }
  }
  assert.deepEqual(await libraryOf(u.token), []);

  // Missing is still missing, as it always was.
  const r = await api('POST', '/api/library', { sourceDomain: 'scans.test', sourceUrl: 'https://scans.test/x' }, u.token);
  assert.equal(r.status, 400);
  assert.match(r.body.error, /title, sourceDomain, sourceUrl required/);
});

test('an edit whose title is not text is refused, and the title stays', async () => {
  const u = await newUser();
  const e = await addEntry(u.token, { title: 'Silent Tide' });
  for (const title of NOT_TEXT) {
    const r = await api('PUT', `/api/library/${e.id}`, { title }, u.token);
    assert.equal(r.status, 400, JSON.stringify(title));
    assert.match(r.body.error, /title must be text/);
  }
  assert.equal((await libraryOf(u.token))[0].title, 'Silent Tide');
  // Sent as text, it is kept as written.
  const r = await api('PUT', `/api/library/${e.id}`, { title: 'Silent Tide (Remastered)' }, u.token);
  assert.equal(r.body.title, 'Silent Tide (Remastered)');
});

// --- the library: what the reader wrote ------------------------------------

test('a note or a language that is not text is refused like a bad score, on every door', async () => {
  const u = await newUser();
  const e = await addEntry(u.token, { note: 'keep me', language: 'fr' });
  for (const value of NOT_TEXT) {
    for (const field of ['note', 'language']) {
      const added = await api('POST', '/api/library', series(`${field}-${JSON.stringify(value)}`, { [field]: value }), u.token);
      assert.equal(added.status, 400, `POST ${field}=${JSON.stringify(value)}`);
      assert.match(added.body.error, new RegExp(`${field} must be text`));
      // Pinned again: the row already exists, and the same refusal comes first.
      const again = await api('POST', '/api/library', { ...series('x'), sourceUrl: e.sourceUrl, [field]: value }, u.token);
      assert.equal(again.status, 400, `re-pin ${field}=${JSON.stringify(value)}`);
      // With a valid score beside it: a refused edit lands no part of itself.
      const edited = await api('PUT', `/api/library/${e.id}`, { [field]: value, score: 7 }, u.token);
      assert.equal(edited.status, 400, `PUT ${field}=${JSON.stringify(value)}`);
    }
  }
  // "fr" is kept the stored way, as a name (src/languages.js).
  const [still] = await libraryOf(u.token);
  assert.deepEqual([still.note, still.language, still.score], ['keep me', 'French', null]);
  assert.equal((await libraryOf(u.token)).length, 1, 'a refused POST added a series');
});

test('a chapter may be text or a number, and nothing else', async () => {
  const u = await newUser();
  // A number is how some clients count, and it is stored as the text it reads as.
  assert.equal((await addEntry(u.token, { lastKnownChapter: 120 })).lastKnownChapter, '120');
  assert.equal((await addEntry(u.token, { lastKnownChapter: 'Chapitre 12.5' })).lastKnownChapter, 'Chapitre 12.5');

  const e = await addEntry(u.token, { lastKnownChapter: '55' });
  for (const lastKnownChapter of [{}, [], ['55'], true]) {
    const r = await api('PUT', `/api/library/${e.id}`, { lastKnownChapter }, u.token);
    assert.equal(r.status, 400, JSON.stringify(lastKnownChapter));
    assert.match(r.body.error, /lastKnownChapter must be text or a number/);
    const added = await api('POST', '/api/library', series(`ch-${JSON.stringify(lastKnownChapter)}`, { lastKnownChapter }), u.token);
    assert.equal(added.status, 400, JSON.stringify(lastKnownChapter));
  }
  // JSON spells 1e400, which parses to Infinity: not a chapter anybody wrote.
  const inf = await rawJson('PUT', `/api/library/${e.id}`, '{"lastKnownChapter":1e400}', u.token);
  assert.equal(inf.status, 400, JSON.stringify(inf.body));
  assert.equal((await libraryOf(u.token)).find((x) => x.id === e.id).lastKnownChapter, '55');
});

test('tags are a list of text: anything else is refused, and null empties the list', async () => {
  const u = await newUser();
  const e = await addEntry(u.token, { tags: ['romance'] });
  // A tag that is an object used to be stored, and then broke every client that
  // drew the shelf; a string where the list belongs wiped the tags on a re-pin.
  for (const tags of [{}, 'romance', [{}], [['a']], ['a', 1], [true]]) {
    const r = await api('PUT', `/api/library/${e.id}`, { tags }, u.token);
    assert.equal(r.status, 400, JSON.stringify(tags));
    assert.match(r.body.error, /tags must be a list of text/);
    const again = await api('POST', '/api/library', { ...series('t'), sourceUrl: e.sourceUrl, tags }, u.token);
    assert.equal(again.status, 400, `re-pin ${JSON.stringify(tags)}`);
  }
  assert.deepEqual((await libraryOf(u.token))[0].tags, ['romance']);

  const cleared = await api('PUT', `/api/library/${e.id}`, { tags: null }, u.token);
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.tags, []);
  // An empty list, not the word null: the import reads '[]' as "no tags yet".
  const row = await db.prepare('SELECT tags FROM library WHERE id = ?').get(e.id);
  assert.equal(row.tags, '[]');
});

test('a folder that is an object or a list is refused, as any folder that is not one', async () => {
  const u = await newUser();
  for (const folder of [{}, ['reading'], { id: 'reading' }]) {
    const r = await api('POST', '/api/library', series(`f-${JSON.stringify(folder)}`, { folder }), u.token);
    assert.equal(r.status, 400, JSON.stringify(folder));
    assert.match(r.body.error, /folder must be one of/);
  }
});

// --- moving a series ---------------------------------------------------------

test('a move refuses the same wrong types, one series at a time or many', async () => {
  const u = await newUser();
  const e = await addEntry(u.token, { title: 'Blue Box', lastKnownChapter: '10' });
  const to = { sourceUrl: 'https://new-scan.test/manga/blue-box', sourceDomain: 'new-scan.test' };
  for (const [field, value] of [['sourceDomain', {}], ['title', ['Blue Box']], ['lastKnownChapter', {}],
    ['tags', [{}]], ['chapterLabel', { n: 9 }]]) {
    const body = { ...to, chapterUrl: `${to.sourceUrl}/chapter-9`, [field]: value };
    const r = await api('POST', `/api/library/${e.id}/migrate`, body, u.token);
    assert.equal(r.status, 400, `${field}=${JSON.stringify(value)}: ${JSON.stringify(r.body)}`);
    assert.match(r.body.error, new RegExp(`${field} must be`));
  }
  const [still] = await libraryOf(u.token);
  assert.equal(still.sourceUrl, e.sourceUrl, 'a refused move moved the series');
  assert.deepEqual((await api('GET', '/api/progress', undefined, u.token)).body, []);

  // Many at once: an id that is not text names no series, and the rest of the
  // run is still reported item by item.
  const bulk = await api('POST', '/api/library/migrate-bulk', {
    items: [{ ...to, id: {} }, { ...to, id: ['x'] }, { ...to, id: e.id, title: {} }],
  }, u.token);
  assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
  assert.equal(bulk.body.moved, 0);
  assert.deepEqual(bulk.body.results.map((x) => x.error), ['not found', 'not found', 'title must be text']);
});

// --- the other write routes --------------------------------------------------

test('a reading session whose series id is not text is a 400', async () => {
  const u = await newUser();
  for (const libraryId of [{}, ['an-id'], { id: 'x' }, 42, true]) {
    const r = await api('POST', '/api/history',
      { libraryId, chapterUrl: 'https://scans.test/c/1', seconds: 60 }, u.token);
    assert.equal(r.status, 400, JSON.stringify(libraryId));
    assert.match(r.body.error, /libraryId must be text/);
  }
});

test('a tracker link whose title is not text is a 400, and a text one is kept', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  for (const remoteTitle of [{}, ['Ao no Hako'], true]) {
    const r = await api('PUT', `/api/trackers/anilist/link/${e.id}`, { remoteId: '12', remoteTitle }, u.token);
    assert.equal(r.status, 400, JSON.stringify(remoteTitle));
    assert.match(r.body.error, /remoteTitle must be text/);
  }
  const ok = await api('PUT', `/api/trackers/anilist/link/${e.id}`, { remoteId: '12', remoteTitle: 'Ao no Hako' }, u.token);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.remoteTitle, 'Ao no Hako');
});

test('a tracker link whose id is not text or a number is a 400, not "[object Object]"', async () => {
  // String() made a link out of anything, and the push then named a series
  // no tracker has on every chapter read.
  const u = await newUser();
  const e = await addEntry(u.token);
  for (const remoteId of [{}, { id: 12 }, ['12'], true]) {
    const r = await api('PUT', `/api/trackers/anilist/link/${e.id}`, { remoteId }, u.token);
    assert.equal(r.status, 400, JSON.stringify(remoteId));
    assert.match(r.body.error, /remoteId must be text or a number/);
  }
  const asNumber = await api('PUT', `/api/trackers/anilist/link/${e.id}`, { remoteId: 151807 }, u.token);
  assert.equal(asNumber.status, 200, JSON.stringify(asNumber.body));
  assert.equal(asNumber.body.remoteId, '151807');
});

test('a shelf whose name is not text is refused, and a backup\'s is skipped', async () => {
  // cleanName (shared/folders.js) makes a string of anything: an object sent
  // as the name became a shelf called "[object Object]" on every client.
  const u = await newUser();
  for (const name of [{}, ['Weekly'], true, 42]) {
    const r = await api('POST', '/api/categories', { name }, u.token);
    assert.equal(r.status, 400, JSON.stringify(name));
    // One reason, the true one: not also "must be 1-80 characters" after it.
    assert.equal(r.body.error, 'name must be text');
  }
  const made = await api('POST', '/api/categories', { name: 'Weekly' }, u.token);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const renamed = await api('PUT', `/api/categories/${made.body.id}`, { name: { x: 1 } }, u.token);
  assert.equal(renamed.status, 400);

  const restored = await api('POST', '/api/import/panelflow', {
    app: 'panelflow', version: 1, exportedAt: '2026-10-13T00:00:00.000Z',
    categories: [{ id: 'c1', name: { x: 1 }, status: 'reading' }, { id: 'c2', name: 'With my brother', status: 'plan' }],
    library: [],
  }, u.token);
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const names = (await api('GET', '/api/categories', undefined, u.token)).body.map((c) => c.name).sort();
  assert.deepEqual(names, ['Weekly', 'With my brother']);
});

test('signing up or in with fields that are not text is a refusal, not a crash', async () => {
  for (const value of [{}, ['a@b.test'], true, 12345678]) {
    const up = await api('POST', '/api/auth/register', { email: value, password: value }, null);
    assert.equal(up.status, 400, `register ${JSON.stringify(value)}`);
    assert.equal(up.body.code, 'bad_email', JSON.stringify(up.body));
    // The same answer as a wrong password: nothing about the form says more.
    const login = await api('POST', '/api/auth/login', { email: value, password: value }, null);
    assert.equal(login.status, 401, `login ${JSON.stringify(value)}`);
    assert.equal(login.body.error, 'invalid credentials');
  }
  // A real account, asked with its own address and a password that is not text.
  const u = await newUser();
  const r = await api('POST', '/api/auth/login', { email: u.email, password: ['password123'] }, null);
  assert.equal(r.status, 401);
});

// --- the net -------------------------------------------------------------------

test('no write route answers a field of the wrong type with a 500', async () => {
  const u = await newUser();
  const e = await addEntry(u.token);
  const routes = [
    ...['title', 'sourceDomain', 'note', 'language', 'lastKnownChapter', 'tags', 'folder', 'seriesStatus',
      'medium', 'coverUrl', 'score', 'rereads', 'startDate', 'finishDate'].flatMap((field) => [
      (v, n) => ['POST', '/api/library', series(`net-${n}`, { [field]: v })],
      (v) => ['POST', '/api/library', { ...series('net'), sourceUrl: e.sourceUrl, [field]: v }],
      (v) => ['PUT', `/api/library/${e.id}`, { [field]: v }],
    ]),
    ...['sourceDomain', 'title', 'lastKnownChapter', 'tags', 'chapterLabel', 'coverUrl', 'chapterUrl']
      .map((field) => (v, n) => ['POST', `/api/library/${e.id}/migrate`,
        { sourceUrl: `https://net.test/m/${n}`, sourceDomain: 'net.test', chapterUrl: `https://net.test/m/${n}/1`, [field]: v }]),
    (v) => ['POST', '/api/library/migrate-bulk', { items: [{ id: v, sourceUrl: 'https://net.test/b', sourceDomain: 'net.test' }] }],
    (v) => ['POST', '/api/library/match', { title: v, sourceUrl: v, altTitles: [v] }],
    ...['libraryId', 'chapterLabel', 'pages', 'seconds', 'day'].map((field) => (v) => ['POST', '/api/history',
      { libraryId: e.id, chapterUrl: 'https://net.test/c/1', [field]: v }]),
    ...['chapterUrl', 'chapterLabel', 'page', 'pageCount', 'scrollPos'].map((field) => (v) => ['PUT',
      `/api/progress/${e.id}`, { chapterUrl: 'https://net.test/c/1', [field]: v }]),
    ...['remoteId', 'remoteTitle', 'state'].map((field) => (v) => ['PUT', `/api/trackers/anilist/link/${e.id}`,
      { remoteId: '12', [field]: v }]),
    (v) => ['POST', '/api/categories', { name: v, status: v }],
    (v) => ['PUT', '/api/categories/order', { ids: [v] }],
    (v) => ['PUT', '/api/prefs', { prefs: { theme: v, uiLang: v } }],
    (v) => ['POST', '/api/news/seen', { items: [v, { libraryId: v, chapter: v }] }],
    (v) => ['POST', '/api/auth/register', { email: v, password: v }],
    (v) => ['POST', '/api/auth/login', { email: v, password: v }],
  ];
  const crashed = [];
  let n = 0;
  for (const route of routes) {
    for (const value of [{ x: 1 }, ['x'], true]) {
      const [method, path, body] = route(value, n++);
      const r = await api(method, path, body, u.token);
      if (r.status >= 500) crashed.push(`${method} ${path} ${JSON.stringify(body)} -> ${r.status}`);
    }
  }
  assert.deepEqual(crashed, []);
});
