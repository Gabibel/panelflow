// What happened lately, for the report screen and nothing else.
//
// A tester who says "the reader did not open" has told us the one thing they
// could see. What we need is the five things before it: which page, which
// site, whether a script failed, whether a navigation was refused and why.
// Those are all lines this app already writes to the console, where nobody
// on a phone can read them. This keeps the last few dozen in memory so the
// report screen can put them in the mail.
//
// In memory, on purpose, and never sent anywhere by itself. The privacy page
// promises that nothing leaves the device but what the reader asks to send;
// this file holds to that by having no transport at all. It forgets on
// restart, which is fine: a report is about now.
//
// No dependency on the rest of the app: anything may `note()`, and the screen
// only ever `recent()`s. A file that is imported from everywhere must not
// import anything back.

const KEEP = 60;
const events = [];

/** The page the reader was on last, kept apart: it is the first line of a report. */
let lastUrl = '';

/**
 * Record one thing. `kind` is a short word ('refused', 'script', 'hub',
 * 'page'); `detail` whatever explains it, cut short so a URL with a token in
 * it, or a stack, never fills the mail.
 */
export function note(kind, detail) {
  events.push({ at: new Date().toISOString(), kind, detail: String(detail ?? '').slice(0, 200) });
  if (events.length > KEEP) events.shift();
}

export function sawPage(url) {
  if (url) lastUrl = String(url).slice(0, 200);
}

export const recent = () => events.slice();
export const lastPage = () => lastUrl;

/** Empty, for tests and for a tester who wants a clean slate before repeating. */
export function clear() {
  events.length = 0;
  lastUrl = '';
}
