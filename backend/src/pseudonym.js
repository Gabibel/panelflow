// Telling two people apart without writing down who either of them is.
//
// Two places need exactly that and nothing more. The rate-limit counters have
// to know that the tenth failed sign-in is against the same account as the
// first; the security log has to show one person mistyping apart from someone
// walking the account list. Neither needs the address itself, and both outlive
// the account they counted — the counters by up to three days, the log for as
// long as the host keeps it. The QA pass of September 2026 found both holding
// e-mail addresses in clear, a deleted account's among them, next to the
// addresses of people who never had an account at all.
//
// A keyed hash (HMAC-SHA-256) rather than a plain one: a list of plain hashes
// of e-mail addresses is a dictionary away from the addresses. Without the
// server's secret, an identifier written here is a random string.
import { createHmac } from 'node:crypto';

// The session-signing secret, which a deployed server cannot boot without (see
// auth.js), under a label of its own: an identifier here is never a valid
// anything else. Read at call time, so a test that sets it first is honoured.
const secret = () => process.env.PANELFLOW_JWT_SECRET || 'dev-secret-change-me';

/** The same `value` of the same `kind` always gives the same identifier. */
export function pseudonym(kind, value) {
  return createHmac('sha256', secret())
    .update(`panelflow:${kind}:${String(value ?? '')}`)
    .digest('hex')
    .slice(0, 24);
}

/**
 * An IP address with its end blanked: `203.0.113.77` → `203.0.113.0`, and an
 * IPv6 address kept to its first 48 bits (`2001:db8:85a3::`).
 *
 * Enough to see that a burst of attempts came from one network, which is what
 * the security log is read for; not enough to single out the line it came
 * from. Anything that is not an address comes back as `unknown`.
 */
export function coarseIp(ip) {
  let text = String(ip ?? '').trim().toLowerCase().replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped) text = mapped[1];
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(text);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0`;
  if (/^[0-9a-f:]+$/.test(text) && text.includes(':')) {
    const [head, tail] = text.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups = tail === undefined
      ? left
      : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
    const first = groups.slice(0, 3).map((g) => g.replace(/^0+(?=.)/, '') || '0');
    while (first.length < 3) first.push('0');
    return `${first.join(':')}::`;
  }
  return 'unknown';
}
