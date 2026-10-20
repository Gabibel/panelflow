// The test bench refuses to leave this machine (test-support/no-network.js).
//
// QA, P5 (OPS-30): a route that reads someone else's site went out for real
// whenever a test forgot to stub it. Checked here at the three ways a test
// reaches a socket: fetch to an address, a name that resolves elsewhere, and
// the loopback, which still works.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

test('the bench is loaded into this process', () => {
  assert.ok(process.execArgv.some((a) => a.includes('no-network')),
    'run the suite through `npm test`, which adds --import ./test-support/no-network.js');
});

test('an address that is not this machine is refused before anything is sent', async () => {
  const err = await fetch('http://93.184.216.34/').then(() => null, (e) => e);
  assert.ok(err, 'the request went out');
  assert.equal(err.cause?.code, 'ENETUNREACH', String(err.cause?.message ?? err));
});

test('a name is judged by where it resolves, and refused when that is elsewhere', async () => {
  const err = await new Promise((resolve) => {
    const req = http.get({ host: 'elsewhere.test', port: 80, lookup: (n, o, cb) => (o?.all
      ? cb(null, [{ address: '8.8.8.8', family: 4 }]) : cb(null, '8.8.8.8', 4)) });
    req.on('error', resolve);
    req.on('response', () => resolve(null));
  });
  assert.equal(err?.code, 'ENETUNREACH');
});

test('the loopback still answers', async () => {
  const server = http.createServer((_q, r) => r.end('here')).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(await res.text(), 'here');
    const named = await fetch(`http://localhost:${server.address().port}/`).catch(() => null);
    if (named) assert.equal(await named.text(), 'here');
  } finally { server.close(); }
});
