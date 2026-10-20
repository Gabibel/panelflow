// The addresses the app may open or draw: http(s), and nothing else.
//
// Every series, bookmark and history row carries an address, and the server
// stored whatever a client sent until backend/src/http-url.js taught it to
// refuse anything but http(s). An account synced before then can still hand
// this phone a javascript: address, which the in-app browser would run in
// whatever page it holds, bridge to the app included, or a data: or file: one
// for an <Image> to draw. So every address read off an entry is asked here
// before anything opens it or draws it.
//
// A pattern on the scheme rather than `new URL`, as navigation-policy.js reads
// one: React Native's URL is not the browser's, and finds a scheme with a
// pattern of its own. So the pattern here is the rule that runs on the phone,
// and the one backend/test/web-links.test.js runs, over the table the server's
// rule and the two browser copies answer.

// The scheme, then at least one character of a host: "https://" alone names
// nothing to open.
const WEB = /^https?:\/\/[^\s/?#]/i;

/** The address, trimmed, when it is http(s); null for anything else. */
export function webUrl(v) {
  if (typeof v !== 'string') return null;
  const url = v.trim();
  return WEB.test(url) ? url : null;
}

/** The first of `urls` that is an http(s) address, or null when none is. */
export const firstWebUrl = (...urls) => urls.map(webUrl).find(Boolean) ?? null;
