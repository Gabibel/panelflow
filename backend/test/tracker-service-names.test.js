// Which names the server takes for a tracker.
//
// The routes looked the name up with `SERVICES[name]`, which also finds what
// every object inherits: `constructor`, `toString`, `__proto__` passed as
// trackers and got a tracker's answers (a 501 "needs your password", a
// callback page) instead of "no such service" (QA, P5, found while triaging
// Semgrep). Nothing came of it, and the same habit is how a lookup becomes a
// way in, so the name is now one of the services' own keys or it is refused.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, shutdown } from '../test-support/harness.js';

after(shutdown);

const INHERITED = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];

test('a name every object has is not a tracker', async () => {
  const u = await newUser();
  for (const name of INHERITED) {
    const routes = [
      ['POST', `/api/trackers/${name}/connect`, {}],
      ['GET', `/api/trackers/${name}/search?q=one+piece`],
      ['POST', `/api/trackers/${name}/push`, {}],
      ['POST', `/api/trackers/${name}/pull`, {}],
    ];
    for (const [method, path, body] of routes) {
      const r = await api(method, path, body, u.token);
      assert.equal(r.status, 404, `${method} ${path} answered ${r.status}`);
    }
    // The callback is public: the tracker's redirect carries no token.
    const cb = await api('GET', `/api/trackers/${name}/callback?error=access_denied`);
    assert.equal(cb.status, 404, `the callback took ${name} for a tracker`);
  }
});

test('the real trackers are still trackers', async () => {
  const cb = await api('GET', '/api/trackers/anilist/callback?error=access_denied');
  assert.equal(cb.status, 400, 'a refusal from AniList is a page saying so');
});
