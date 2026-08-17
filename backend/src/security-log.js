// The line in the log that says someone is trying.
//
// Deliberately small. There is no SIEM here and there is not going to be one:
// what exists is Vercel's runtime log, and the only thing that makes it useful
// is that the interesting events are greppable and shaped the same. One JSON
// object per line, one `evt` key to filter on.
//
// What must never appear here: a password, a token, a reset link, a session
// JWT. An email address does — it is the only thing that distinguishes "one
// person is mistyping" from "someone is walking the account list", and this log
// is not published anywhere.
export function securityLog(evt, fields = {}) {
  // console.warn rather than log: on Vercel that is the level worth an alert,
  // and it keeps these lines out of the ordinary request noise.
  console.warn(JSON.stringify({ evt, at: new Date().toISOString(), ...fields }));
}
