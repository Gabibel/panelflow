// A cover that is not an http(s) address never costs a series its sync.
//
// The server refuses a whole entry over such a cover (src/http-url.js,
// bad_url), and a page can hand the detector one: an og:image written as
// data:, a path the page never made absolute. The core used to send it as it
// was, and the series never reached the account. It now sends no cover in its
// place, and on an edit leaves the server's own picture alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootCore, json, entryFixture } from '../test-support/core.js';

/** A signed-in device whose server answers every write, and keeps what it was sent. */
function device(library) {
  const sent = [];
  const boot = bootCore({
    storage: { authToken: 't', authUser: { id: 'u1' }, dataOwner: 'u1', library },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (init?.body) sent.push({ path, method: init.method, body: JSON.parse(init.body) });
      if (path === '/api/library' && init?.method === 'POST') return json({ id: 'r-new', ...JSON.parse(init.body) }, 201);
      if (path === '/api/library') return json([]);
      if (path === '/api/progress') return json([]);
      if (path === '/api/categories') return json([]);
      if (path === '/api/history/read') return json({ series: [] });
      return json({});
    },
  });
  return { ...boot, sent };
}

test('a series whose cover is not an address is pushed without one', async () => {
  for (const coverUrl of ['data:image/png;base64,iVBORw0KGgo=', '/wp-content/cover.jpg', 'javascript:alert(1)']) {
    const d = device([entryFixture({ coverUrl })]);
    await d.core.syncAll();
    const post = d.sent.find((s) => s.path === '/api/library' && s.method === 'POST');
    assert.ok(post, `${coverUrl}: the series was never sent`);
    assert.equal(post.body.coverUrl, null, coverUrl);
  }
  const good = device([entryFixture()]);
  await good.core.syncAll();
  assert.equal(good.sent.find((s) => s.method === 'POST').body.coverUrl, 'https://old-scan.test/cover.jpg');
});

test('merging duplicates leaves the server\'s cover alone when this one is not an address', async () => {
  const kept = entryFixture({ remoteId: 'r1', coverUrl: 'data:image/png;base64,iVBORw0KGgo=' });
  const twin = entryFixture({ id: 'other', remoteId: 'r2', sourceUrl: 'https://old-scan.test/manga/ao-no-hako/', coverUrl: null });
  const d = device([kept, twin]);
  await d.core.dedupeLibrary();
  const put = d.sent.find((s) => s.method === 'PUT' && s.path === '/api/library/r1');
  assert.ok(put, 'the copy kept was not written back');
  assert.equal('coverUrl' in put.body, false, 'a PUT with null would clear the server\'s cover');
  assert.equal(put.body.title, 'Ao no Hako');
});
