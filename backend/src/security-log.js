// The line in the log that says someone is trying.
//
// Deliberately small. There is no SIEM here and there is not going to be one:
// what exists is Vercel's runtime log, and the only thing that makes it useful
// is that the interesting events are greppable and shaped the same. One JSON
// object per line, one `evt` key to filter on.
//
// What must never appear here: a password, a token, a reset link, a session
// JWT — and, since the QA pass of September 2026, an e-mail address or a whole
// IP address. Both used to be written in clear, the address of a deleted
// account and of people who never had one included, while the privacy page
// said PanelFlow keeps no log of either.
//
// What is written instead is enough for the one question this log answers,
// "one person mistyping, or someone walking the account list?": a keyed hash
// of the address (the same address always gives the same `emailId`, and no
// `emailId` gives the address back) and the network the attempt came from,
// with the machine's own part blanked. A caller passes `email` and `ip` as it
// always did; this is the one place that decides what they become, so no new
// call site can forget to.
import { pseudonym, coarseIp } from './pseudonym.js';

// Anything shaped like an address, inside free text: an upstream error message
// quoting the recipient is the way one would get in by the side door.
const ADDRESS = /[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[^\s@"'<>(),;:]+/g;

/** The fields as they may be written down. */
export function pseudonymous(fields = {}) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'email') {
      if (value) out.emailId = pseudonym('email', String(value).trim().toLowerCase());
    } else if (key === 'ip') {
      out.ip = coarseIp(value);
    } else {
      out[key] = typeof value === 'string' ? value.replace(ADDRESS, '[address]') : value;
    }
  }
  return out;
}

export function securityLog(evt, fields = {}) {
  // console.warn rather than log: on Vercel that is the level worth an alert,
  // and it keeps these lines out of the ordinary request noise.
  console.warn(JSON.stringify({ evt, at: new Date().toISOString(), ...pseudonymous(fields) }));
}
