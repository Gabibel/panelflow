// The guard on where the server will open a connection.
//
// Two ways past the old hostname regex were reachable on /api/meta/scrape, and
// that route hands the fetched page back to the caller — so what the server
// read from inside came back out. Both are pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, publicUrl, safeFetch } from '../src/safe-fetch.js';

test('an address inside is recognised however it is spelled', () => {
  for (const ip of [
    '127.0.0.1', '127.1.2.3', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '169.254.169.254',   // the cloud metadata endpoint
    '0.0.0.0', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd00::abcd', 'ff02::1',
    '::ffff:127.0.0.1',  // IPv4 in IPv6 clothing, decimal…
    '::ffff:7f00:1',     // …and the same 32 bits in hex
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be refused`);
  }
});

test('a genuinely public address is not caught by the net', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '172.15.0.1',
    '2606:4700:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`);
  }
});

test('a nonsense address is refused rather than assumed public', () => {
  for (const junk of ['', 'not-an-ip', '999.1.1.1', 'localhost']) {
    assert.equal(isPrivateAddress(junk), true);
  }
});

test('only http(s) gets through', async () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'javascript:alert(1)', 'not-a-url']) {
    await assert.rejects(() => publicUrl(url), (e) => e.status === 400);
  }
});

test('a literal private address is refused, brackets and all', async () => {
  for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/']) {
    await assert.rejects(() => publicUrl(url), (e) => e.status === 400, url);
  }
});

// The first bypass: the guard read the hostname as *text*, and a public name is
// free to have a private A record. localtest.me is one such name and anyone can
// publish another, so no redirect was needed — the URL simply did not look like
// what it resolved to. Pinned without a DNS server by checking the resolved
// address directly, which is the step that was missing.
test('a name is judged by the address it resolves to, not by how it reads', async () => {
  assert.equal(isPrivateAddress('127.0.0.1'), true,
    'a public name resolving here must be refused on the address');
  // And a public literal, which needs no lookup at all, still goes through.
  assert.equal((await publicUrl('http://1.1.1.1/x')).hostname, '1.1.1.1');
});

/** A fetch that answers `plan` in order: a status+location, or a plain body. */
function stubFetch(plan) {
  const seen = [];
  const real = globalThis.fetch;
  let i = 0;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    const step = plan[Math.min(i++, plan.length - 1)];
    return step.location
      ? new Response(null, { status: step.status ?? 302, headers: { location: step.location } })
      : new Response(step.body ?? 'ok', { status: 200 });
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}

// The second bypass: `redirect: 'follow'` re-issued the request at the new
// address without anyone looking at it, so only hop one was ever checked.
test('a redirect into a private address is refused at the hop that takes it there', async () => {
  const f = stubFetch([{ location: 'http://127.0.0.1:8787/api/health' }]);
  try {
    await assert.rejects(() => safeFetch('http://1.1.1.1/start'), (e) => e.status === 400);
    assert.equal(f.seen.length, 1, 'the private hop is never requested');
  } finally { f.restore(); }
});

test('a public redirect is followed as before', async () => {
  const f = stubFetch([{ location: 'http://8.8.8.8/there' }, { body: 'arrived' }]);
  try {
    const resp = await safeFetch('http://1.1.1.1/start');
    assert.equal(await resp.text(), 'arrived');
    assert.deepEqual(f.seen, ['http://1.1.1.1/start', 'http://8.8.8.8/there']);
  } finally { f.restore(); }
});

test('a redirect loop stops instead of running forever', async () => {
  const f = stubFetch([{ location: 'http://8.8.8.8/again' }]);
  try {
    await assert.rejects(() => safeFetch('http://8.8.8.8/again'), (e) => e.status === 502);
    assert.ok(f.seen.length <= 6, `stopped after ${f.seen.length} hops`);
  } finally { f.restore(); }
});
