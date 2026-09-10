// A cover for a series whose own site never had one.
//
// The route exists because of a light novel: detected, added, and sitting on
// the shelf as a grey rectangle for ever. Its site has no og:image, so
// /api/meta/scrape can find nothing, and no amount of syncing invents one.
//
// The important property, and the reason this is not under /api/trackers: it is
// asked *without anybody's account*. AniList answers catalogue queries with no
// token, and needing a connected tracker to get a picture on a shelf would mean
// almost nobody gets one. So the test that matters most here is the one
// asserting no Authorization header goes out.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, shutdown, base } from '../test-support/harness.js';

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
});

/** Stand in for AniList, recording exactly what was sent to it. */
function anilist(media = []) {
  const sent = [];
  outbound = async (url, init) => {
    sent.push({ url, headers: init.headers, ...JSON.parse(init.body) });
    return json({ data: { Page: { media } } });
  };
  return sent;
}

const hit = (id, romaji, over = {}) => ({
  id,
  synonyms: [],
  title: { romaji, english: null, native: null },
  coverImage: { large: `https://cdn.anilist.co/${id}.jpg` },
  ...over,
});

test('a title comes back with a picture', async () => {
  const u = await newUser();
  const sent = anilist([hit(30002, 'Ao no Hako')]);

  const r = await api('GET', '/api/meta/cover?title=Ao%20no%20Hako', undefined, u.token);

  assert.equal(r.status, 200);
  assert.deepEqual(r.body, {
    hits: [{
      id: '30002',
      title: 'Ao no Hako',
      altTitles: [],
      coverUrl: 'https://cdn.anilist.co/30002.jpg',
    }],
  });
  assert.equal(sent[0].variables.q, 'Ao no Hako');
});

test('the catalogue is asked without anybody being signed in to it', async () => {
  // The whole point of the route. If this starts sending a token, a reader with
  // no tracker connected silently stops getting covers — and nothing else would
  // fail to say so.
  const u = await newUser();
  const sent = anilist([hit(30002, 'Ao no Hako')]);

  await api('GET', '/api/meta/cover?title=Ao%20no%20Hako', undefined, u.token);

  assert.equal(sent[0].url, 'https://graphql.anilist.co');
  assert.ok(!('Authorization' in sent[0].headers), 'a token was sent to a public search');
  // And it does not ask what this reader has on their list, because there is no
  // reader here — that half of the query needs the account this one refuses.
  assert.ok(!sent[0].query.includes('mediaListEntry'), 'the anonymous query asks for list state');
});

test('alternative titles travel too, so the client can match on them', async () => {
  // How a light novel is usually found: the shelf holds the English title the
  // site used, the catalogue's main title is the romaji one.
  const u = await newUser();
  anilist([hit(30002, 'Ao no Hako', {
    synonyms: ['Blue Box'],
    title: { romaji: 'Ao no Hako', english: 'Blue Box', native: null },
  })]);

  const r = await api('GET', '/api/meta/cover?title=Blue%20Box', undefined, u.token);

  assert.deepEqual(r.body.hits[0].altTitles, ['Blue Box', 'Blue Box']);
});

test('a one-letter title is refused before anything is fetched', async () => {
  const u = await newUser();
  outbound = async () => { throw new Error('the catalogue should not have been asked'); };

  assert.equal((await api('GET', '/api/meta/cover?title=a', undefined, u.token)).status, 400);
  assert.equal((await api('GET', '/api/meta/cover', undefined, u.token)).status, 400);
});

test('a catalogue that is down is a missing picture, not a broken shelf', async () => {
  const u = await newUser();
  // AniList reports a rate limit as HTTP 200 with an `errors` array, which is
  // exactly the shape that looks like success to code that does not know.
  outbound = async () => json({ errors: [{ message: 'Too Many Requests' }] });

  const r = await api('GET', '/api/meta/cover?title=Ao%20no%20Hako', undefined, u.token);
  assert.equal(r.status, 502);
  assert.match(r.body.error, /anilist/i);
});

test('the route needs an account, like its neighbours in /api/meta', async () => {
  assert.equal((await api('GET', '/api/meta/cover?title=Ao%20no%20Hako')).status, 401);
});
