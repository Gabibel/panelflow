// The security log, held to what the privacy page says about it.
//
// The QA pass of September 2026 read the server's log after a few failed
// sign-ins and a deletion, and found every e-mail address and every IP address
// in clear — a deleted account's, and those of people who never had one —
// while the privacy page said PanelFlow keeps no log of either. The log is
// still there, because "one person mistyping, or someone walking the account
// list?" is a question worth being able to answer. What it may hold is below.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { api, newUser, shutdown } from '../test-support/harness.js';
import { pseudonymous } from '../src/security-log.js';
import { coarseIp, pseudonym } from '../src/pseudonym.js';

after(shutdown);

test('an address becomes an identifier that tells two people apart and names neither', () => {
  const one = pseudonymous({ email: 'Reader@Example.test' });
  assert.deepEqual(Object.keys(one), ['emailId']);
  assert.match(one.emailId, /^[0-9a-f]{24}$/);
  // The same person, however they typed it, is the same identifier...
  assert.equal(pseudonymous({ email: ' reader@example.test ' }).emailId, one.emailId);
  // ...and somebody else is somebody else.
  assert.notEqual(pseudonymous({ email: 'other@example.test' }).emailId, one.emailId);
  // Keyed: it is not a plain hash anybody could recompute from a list of addresses.
  assert.notEqual(one.emailId, pseudonym('bucket', 'reader@example.test'));
});

test('an IP address keeps its network and loses its machine', () => {
  assert.equal(coarseIp('203.0.113.77'), '203.0.113.0');
  assert.equal(coarseIp('::ffff:198.51.100.23'), '198.51.100.0');
  assert.equal(coarseIp('2001:db8:85a3::8a2e:370:7334'), '2001:db8:85a3::');
  assert.equal(coarseIp('2001:0db8:0000:0042:0000:8a2e:0370:7334'), '2001:db8:0::');
  assert.equal(coarseIp('fe80::1%eth0'), 'fe80:0:0::');
  for (const junk of ['unknown', '', null, undefined, '1.2.3', 'not an address']) {
    assert.equal(coarseIp(junk), 'unknown', String(junk));
  }
  assert.equal(pseudonymous({ ip: '203.0.113.77' }).ip, '203.0.113.0');
});

test('an address quoted inside free text is taken out too', () => {
  // The mail provider's refusal quotes the recipient; that is how an address
  // would come in by the side door.
  const out = pseudonymous({ status: 422, body: '{"message":"Invalid `to` field: someone@else.example.com"}' });
  assert.doesNotMatch(out.body, /@/);
  assert.match(out.body, /\[address\]/);
  assert.equal(out.status, 422);
});

/** Every security line the server writes while `fn` runs. */
async function logged(fn) {
  const lines = [];
  const real = console.warn;
  console.warn = (...args) => {
    const text = args.map(String).join(' ');
    try {
      const line = JSON.parse(text);
      if (line && line.evt) { lines.push({ text, line }); return; }
    } catch { /* not one of ours */ }
    real(...args);
  };
  try { await fn(); } finally { console.warn = real; }
  return lines;
}

test('through the API: no e-mail, no whole IP address, and nothing about an address with no account', async () => {
  const u = await newUser();
  const ghost = `never-signed-up-${Date.now()}@test.dev`;
  const lines = await logged(async () => {
    await api('POST', '/api/auth/login', { email: u.email, password: 'wrong-guess-123' });
    await api('POST', '/api/auth/login', { email: ghost, password: 'wrong-guess-123' });
    await api('POST', '/api/auth/forgot', { email: ghost });
    await api('DELETE', '/api/auth/me', { password: 'password123' }, u.token);
  });

  const events = lines.map((l) => l.line.evt);
  for (const evt of ['login_failed', 'account_deleted']) {
    assert.ok(events.includes(evt), `${evt} was not logged at all: ${events.join(', ')}`);
  }
  for (const { text, line } of lines) {
    assert.doesNotMatch(text, /@/, `an e-mail address reached the log: ${text}`);
    assert.equal(line.email, undefined);
    if ('ip' in line) {
      assert.match(line.ip, /(\.0|::|^unknown)$/, `a whole IP address reached the log: ${line.ip}`);
    }
  }
  // The known account is recognisable across lines; the stranger is not written down.
  const failed = lines.filter((l) => l.line.evt === 'login_failed').map((l) => l.line);
  assert.ok(failed.some((l) => l.known === true && /^[0-9a-f]{24}$/.test(l.emailId)));
  assert.ok(failed.some((l) => l.known === false && l.emailId === undefined));
  const unknownReset = lines.find((l) => l.line.evt === 'password_reset_unknown_email');
  if (unknownReset) assert.equal(unknownReset.line.emailId, undefined);
});
