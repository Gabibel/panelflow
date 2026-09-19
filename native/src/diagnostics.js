// What happened lately, for the report screen and nothing else.
//
// A tester who says "the reader did not open" has told us the one thing they
// could see. What we need is the five things before it: which page, which
// site, whether a script failed, whether a navigation was refused and why.
// Those are all lines this app already writes to the console, where nobody
// on a phone can read them. This keeps the last few dozen in memory so the
// report screen can put them in the mail.
//
// The buffer itself is shared/report.js (the extension keeps the same one in
// its worker); this file is the phone's single instance of it, so that
// anything may `note()` and only the report screen `recent()`s. In memory,
// on purpose, and with no transport at all: the privacy page promises that
// nothing leaves the device but what the reader asks to send.
import '../generated/shared/report.js';

const buffer = globalThis.PanelFlowReport.createDiagnostics();

/**
 * Record one thing. `kind` is a short word ('refused', 'script', 'hub',
 * 'page'); `detail` whatever explains it, cut short so a URL with a token in
 * it, or a stack, never fills the mail.
 */
export const note = (kind, detail) => buffer.note(kind, detail);
/** The page the reader was on last, kept apart: it is the first line of a report. */
export const sawPage = (url) => buffer.sawPage(url);
export const recent = () => buffer.recent();
export const lastPage = () => buffer.lastPage();
/** Empty, for tests and for a tester who wants a clean slate before repeating. */
export const clear = () => buffer.clear();
