// Importing the list of an account that is already connected.
//
// The file import asks the reader to go and export their list first; this one
// asks nothing, because the server already holds a token. What is checked here
// is mostly that the two roads arrive at the same place: the same `sourceUrl`
// for the same series, or importing by file after importing by account doubles
// the library instead of updating it.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { api, base, newUser, shutdown } from '../test-support/harness.js';
import { db } from '../src/db.js';

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

/** A live connection: a NULL expiry is one that never goes stale. */
const connect = (userId, service, { access = 'tok', user = null } = {}) =>
  db.prepare(`
    INSERT INTO trackers (user_id, service, access_token, refresh_token, expires_at, remote_user)
    VALUES (?, ?, ?, NULL, NULL, ?)
  `).run(userId, service, access, user);

const malItem = (id, title, status, chapters, extra = {}) => ({
  node: { id, title, main_picture: { large: `https://cdn.test/${id}.jpg` }, status: 'currently_publishing' },
  list_status: { status, num_chapters_read: chapters, score: 0, num_times_reread: 0, ...extra },
});

test('AniList imports the connected account without being told a username', async () => {
  const u = await newUser();
  await connect(u.id, 'anilist', { access: 'ani-tok', user: 'gabibel' });
  const seen = [];
  outbound = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
    return json({
      data: {
        MediaListCollection: {
          lists: [{
            entries: [{
              status: 'CURRENT', progress: 246, score: 9, repeat: 0,
              media: {
                siteUrl: 'https://anilist.co/manga/30002', status: 'RELEASING',
                countryOfOrigin: 'JP', title: { romaji: 'Blue Lock' }, coverImage: {},
              },
            }],
          }],
        },
      },
    });
  };
  try {
    const r = await api('POST', '/api/import/anilist/account', {}, u.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.added, 1);
    assert.equal(r.body.from, 'account');
    // The stored account name is what the query asks for — the reader never
    // typed it, and it is not asked for a second time.
    assert.equal(seen[0].body.variables.name, 'gabibel');
    // Signed, so a private list comes back too. This is the whole reason the
    // connected import is not the same thing as importing by username.
    assert.equal(seen[0].auth, 'Bearer ani-tok');
  } finally {
    outbound = null;
  }
});

test('MyAnimeList is read page by page, and lands on the same URLs as its export', async () => {
  const u = await newUser();
  await connect(u.id, 'mal', { access: 'mal-tok' });
  const seen = [];
  outbound = async (url, init) => {
    seen.push({ url, auth: init.headers.Authorization });
    if (seen.length === 1) {
      return json({
        data: [
          malItem(21, 'One Piece', 'reading', 1100),
          malItem(2, 'Berserk', 'on_hold', 370, { start_date: '2019-04-01', score: 9 }),
        ],
        paging: { next: 'https://api.myanimelist.net/v2/users/@me/mangalist?offset=100' },
      });
    }
    return json({ data: [malItem(3, 'Planned', 'plan_to_read', 0)], paging: {} });
  };
  try {
    const r = await api('POST', '/api/import/mal/account', {}, u.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.added, 3);
    assert.equal(seen.length, 2, 'the second page is followed');
    assert.equal(seen[1].auth, 'Bearer mal-tok');

    const rows = await db.prepare(
      'SELECT title, source_url, folder FROM library WHERE user_id = ? ORDER BY title',
    ).all(u.id);
    const by = Object.fromEntries(rows.map((x) => [x.title, x]));
    // `on_hold` from the API and `On-Hold` from the XML are the same shelf.
    assert.equal(by.Berserk.folder, 'paused');
    assert.equal(by.Planned.folder, 'plan');
    assert.equal(by['One Piece'].folder, 'reading');
    // The key the file import would produce for the same series.
    assert.equal(by['One Piece'].source_url, 'https://myanimelist.net/manga/21');
  } finally {
    outbound = null;
  }
});

test('the same series imported twice, once by account and once by file, stays one row', async () => {
  const u = await newUser();
  await connect(u.id, 'mal', { access: 'mal-tok' });
  outbound = async () => json({ data: [malItem(21, 'One Piece', 'reading', 1100)], paging: {} });
  try {
    await api('POST', '/api/import/mal/account', {}, u.token);
  } finally {
    outbound = null;
  }
  const xml = `<?xml version="1.0" ?><myanimelist><manga>
    <manga_mangadb_id>21</manga_mangadb_id>
    <manga_title><![CDATA[One Piece]]></manga_title>
    <my_status>Reading</my_status><my_read_chapters>1100</my_read_chapters>
  </manga></myanimelist>`;
  const resp = await fetch(`${base}/api/import/mal`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', Authorization: `Bearer ${u.token}` },
    body: xml,
  });
  const body = await resp.json();
  assert.equal(body.added, 0, 'the file import recognises what the account import wrote');
  const rows = await db.prepare('SELECT id FROM library WHERE user_id = ?').all(u.id);
  assert.equal(rows.length, 1);
});

test('a dry run says what it would do and writes nothing', async () => {
  const u = await newUser();
  await connect(u.id, 'mal', { access: 'mal-tok' });
  outbound = async () => json({ data: [malItem(21, 'One Piece', 'reading', 1100)], paging: {} });
  try {
    const r = await api('POST', '/api/import/mal/account?dryRun=1', {}, u.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.added, 1);
    assert.equal(r.body.dryRun, true);
  } finally {
    outbound = null;
  }
  const rows = await db.prepare('SELECT id FROM library WHERE user_id = ?').all(u.id);
  assert.equal(rows.length, 0);
});

test('nothing connected is answered as something to do, not as an error', async () => {
  const u = await newUser();
  const r = await api('POST', '/api/import/anilist/account', {}, u.token);
  assert.equal(r.status, 401);
  assert.match(r.body.error, /connect that tracker first/i);
});

test('a tracker with nothing to import is a 404, not an empty library', async () => {
  const u = await newUser();
  await connect(u.id, 'kitsu', { access: 'k' });
  const r = await api('POST', '/api/import/kitsu/account', {}, u.token);
  assert.equal(r.status, 404);
});

test('a refused token is reported as a connection to redo', async () => {
  const u = await newUser();
  await connect(u.id, 'mal', { access: 'stale' });
  outbound = async () => json({ error: 'invalid_token' }, 401);
  try {
    const r = await api('POST', '/api/import/mal/account', {}, u.token);
    assert.equal(r.status, 401);
    assert.match(r.body.error, /connect it again/i);
  } finally {
    outbound = null;
  }
});

test('importing an account is behind a login', async () => {
  const r = await api('POST', '/api/import/mal/account', {});
  assert.equal(r.status, 401);
});
