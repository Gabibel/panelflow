// The server's curl fallback, for sites that answer Node's TLS with a wall.
//
// Two things were wrong with it (QA, P5). It never ran: its output marker
// began with a NUL byte, and Node refuses one in a process argument, so every
// site behind such a wall came back as a 502 from August on. And had it run,
// it let curl follow redirects itself (`-L`) and resolve names itself, so a
// public host could send it to a private address before anything looked.
// Played here against a stand-in for curl and for DNS: nothing leaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { curlFetch } from '../src/routes/meta.js';

const MARK = '\n<<panelflow-curl>>';

/** A curl that answers `plan` in order: `{ status, location }` or `{ body }`. */
function fakeCurl(plan) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push(args);
    const step = plan[Math.min(calls.length - 1, plan.length - 1)];
    return step.location
      ? { stdout: `${MARK}${step.status ?? 302} ${step.location}` }
      : { stdout: `${step.body ?? '<html>page</html>'}${MARK}200 ` };
  };
  return { run, calls, url: (i) => calls[i][calls[i].length - 1] };
}

test('the fallback can run at all: no argument carries a NUL byte', async () => {
  const curl = fakeCurl([{ body: '<html>the page</html>' }]);
  assert.equal(await curlFetch('http://1.1.1.1/series', { run: curl.run }), '<html>the page</html>');
  for (const arg of curl.calls[0]) {
    assert.ok(!arg.includes('\0'), `Node refuses ${JSON.stringify(arg)} as a process argument`);
  }
  assert.ok(!curl.calls[0].includes('-L') && !curl.calls[0].includes('-sL'), 'curl follows redirects on its own');
});

test('a redirect into a private address is refused before curl is sent there', async () => {
  // The Lambda runtime API listens on the loopback: a blind GET is enough.
  const curl = fakeCurl([{ location: 'http://127.0.0.1:9001/2018-06-01/runtime/invocation/next' }]);
  await assert.rejects(() => curlFetch('http://1.1.1.1/start', { run: curl.run }), (e) => e.status === 400);
  assert.equal(curl.calls.length, 1, 'the private hop was requested');
});

test('a public redirect is followed one hop at a time, and a loop stops', async () => {
  const curl = fakeCurl([{ location: 'http://8.8.8.8/there', status: 301 }, { body: 'arrived' }]);
  assert.equal(await curlFetch('http://1.1.1.1/start', { run: curl.run }), 'arrived');
  assert.deepEqual([curl.url(0), curl.url(1)], ['http://1.1.1.1/start', 'http://8.8.8.8/there']);
  const loop = fakeCurl([{ location: 'http://8.8.8.8/again' }]);
  await assert.rejects(() => curlFetch('http://8.8.8.8/again', { run: loop.run }), (e) => e.status === 502);
  assert.ok(loop.calls.length <= 6, `${loop.calls.length} hops`);
});

test('a name is pinned to the addresses that were checked', async () => {
  const lookupAll = async (host) => (host === 'scan.test'
    ? [{ address: '93.184.216.34' }, { address: '2606:2800:220:1::1' }]
    : [{ address: '10.0.0.7' }]);
  const curl = fakeCurl([{ body: 'ok' }]);
  await curlFetch('https://scan.test/manga/x', { run: curl.run, lookupAll });
  const args = curl.calls[0];
  assert.equal(args[args.indexOf('--resolve') + 1], 'scan.test:443:93.184.216.34,[2606:2800:220:1::1]');
  // A name that answers with a private address is not asked at all, and
  // neither is one that does not resolve: curl would resolve it itself.
  const none = fakeCurl([{ body: 'never' }]);
  await assert.rejects(() => curlFetch('https://inside.test/', { run: none.run, lookupAll }), (e) => e.status === 400);
  await assert.rejects(() => curlFetch('https://gone.test/', {
    run: none.run, lookupAll: async () => { throw new Error('ENOTFOUND'); },
  }), (e) => e.status === 502);
  assert.equal(none.calls.length, 0);
});
