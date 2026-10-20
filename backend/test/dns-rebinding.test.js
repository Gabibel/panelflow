// DNS rebinding against the server's fetch.
//
// `safeFetch` used to check where a name resolved, then hand the URL to
// `fetch`, which resolved the name again on its own. A name that answers a
// public address to the first question and this machine to the second got
// the request through to the inside (QA, P5). Played here with a fake DNS
// that does exactly that, in front of a server on the loopback that counts
// what reaches it: the check now happens on the address the connection is
// actually made to.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { safeFetch } from '../src/safe-fetch.js';

/** A DNS whose first answer for `name` is public and every later one is the loopback. */
function rebindingDns(name) {
  const real = { lookup: dns.lookup, promises: dns.promises.lookup };
  let asked = 0;
  let inside = false;
  const answer = () => (++asked === 1 && !inside ? { address: '93.184.216.34', family: 4 } : { address: '127.0.0.1', family: 4 });
  dns.lookup = function lookup(host, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (host !== name) return real.lookup.call(dns, host, opts, cb);
    const a = answer();
    return process.nextTick(() => (opts?.all ? cb(null, [a]) : cb(null, a.address, a.family)));
  };
  dns.promises.lookup = async function lookup(host, opts = {}) {
    if (host !== name) return real.promises.call(dns.promises, host, opts);
    const a = answer();
    return opts?.all ? [a] : a;
  };
  syncBuiltinESMExports();
  return {
    asked: () => asked,
    alwaysInside: () => { inside = true; },
    restore() {
      dns.lookup = real.lookup;
      dns.promises.lookup = real.promises;
      syncBuiltinESMExports();
    },
  };
}

/** A server on the loopback that counts what reaches it. */
async function inside() {
  const server = http.createServer((_req, res) => { server.hits += 1; res.end('the inside'); });
  server.hits = 0;
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return server;
}

test('a name that answers public first and the loopback next reaches nothing inside', async () => {
  // The old guard asked once and let fetch ask again: the first answer passed
  // the check and the second was the one connected to.
  const server = await inside();
  const fake = rebindingDns('rebind.test');
  try {
    const outcome = await safeFetch(`http://rebind.test:${server.address().port}/secret`)
      .then(async (resp) => `answered ${resp.status}: ${await resp.text()}`, (e) => e);
    assert.equal(server.hits, 0, 'the request reached the server on the loopback');
    assert.ok(outcome instanceof Error, `fetched: ${outcome}`);
  } finally {
    fake.restore();
    server.close();
  }
});

test('the address is judged on the connection itself', async () => {
  // Every answer is the loopback: refused as not allowed (400) at the moment
  // of connecting, with nothing asked of DNS beforehand.
  const server = await inside();
  const fake = rebindingDns('inside.test');
  fake.alwaysInside();
  try {
    const err = await safeFetch(`http://inside.test:${server.address().port}/`).then(() => null, (e) => e);
    assert.equal(server.hits, 0);
    assert.equal(err?.status, 400, String(err?.message ?? err));
    assert.equal(fake.asked(), 1, 'the name was looked up before the connection as well');
  } finally {
    fake.restore();
    server.close();
  }
});
