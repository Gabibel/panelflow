// A tracker message cannot aim the reader's token at another route.
//
// The hub builds the path of a tracker call from what the message names: the
// tracker, and for a link the library id. Both went into the path as written,
// so `service: '../library?x='` turned "search AniList" into GET /api/library
// with the reader's token, and the library came back to whoever sent the
// message, as `hits` (QA, P5 H5). The extension and the app only take these
// messages from PanelFlow's own scripts, but the older shells pass any page's
// message on, so the rule lives in the hub itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bootCore, json } from '../test-support/core.js';

/** A signed-in device whose server records every path it is asked for. */
function device() {
  const asked = [];
  const boot = bootCore({
    storage: { authToken: 't', authUser: { id: 'u1' }, dataOwner: 'u1' },
    fetch: async (url, init) => {
      asked.push({ url: new URL(String(url)), method: init?.method || 'GET' });
      return json({ ok: true });
    },
  });
  return { ...boot, asked };
}

const HOSTILE_SERVICES = ['../library?x=', '..', 'anilist/../../me', 'AniList', 'mal?q=', 'mal#', '', null, 42, { a: 1 }];

test('a tracker name that is not one is refused before any request', async () => {
  for (const service of HOSTILE_SERVICES) {
    for (const type of ['trackerSearch', 'trackerConnect', 'trackerDisconnect', 'trackerPushAll', 'trackerPull',
      'trackerImport', 'trackerLink', 'trackerUnlink']) {
      const d = device();
      const r = await d.hub({ type, service, libraryId: 'lib-1', q: 'blue box' });
      assert.equal(r.error, 'unknown tracker', `${type} with ${JSON.stringify(service)}: ${JSON.stringify(r)}`);
      assert.deepEqual(d.asked, [], `${type} with ${JSON.stringify(service)} reached the server`);
    }
  }
});

test('a library id is one segment of the path, whatever it holds', async () => {
  for (const libraryId of ['../../library', 'a/b', 'x?y=1', '%2e%2e', 'lib-1']) {
    const d = device();
    await d.hub({ type: 'trackerLink', service: 'anilist', libraryId, remoteId: 5, state: 'linked' });
    const [call] = d.asked;
    assert.equal(call.method, 'PUT');
    // The path has exactly the four segments of the route, the id among them.
    const parts = call.url.pathname.split('/').filter(Boolean);
    assert.deepEqual(parts.slice(0, 4), ['api', 'trackers', 'anilist', 'link'], call.url.pathname);
    assert.equal(parts.length, 5, `${JSON.stringify(libraryId)} became ${call.url.pathname}`);
    assert.equal(decodeURIComponent(parts[4]), libraryId);
    assert.equal(call.url.search, '', 'a query smuggled in through the id');
  }
});

test('the real trackers still go where they always went', async () => {
  const d = device();
  await d.hub({ type: 'trackerSearch', service: 'mal', q: 'blue box', medium: 'manga' });
  await d.hub({ type: 'trackerConnect', service: 'anilist' });
  await d.hub({ type: 'trackerImport', service: 'anilist', dryRun: true });
  assert.deepEqual(d.asked.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`), [
    'GET /api/trackers/mal/search?q=blue%20box&medium=manga',
    'POST /api/trackers/anilist/connect',
    'POST /api/import/anilist/account?dryRun=1',
  ]);
});
