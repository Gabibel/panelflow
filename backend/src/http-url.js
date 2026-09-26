// Which addresses this API will keep, to be opened later as links.
//
// A series address, a cover, a chapter: every one of them comes back out as an
// `href` or an `src` on some surface — the web shelf, the popup, the phone —
// and the web one lives on the origin that holds the account's token. A
// `javascript:` address stored here was a script waiting for a click on that
// origin, and the phone's in-app browser let any site write one (QA, September
// 2026). So the door is here, on the way in, for every client at once: an
// address is http or https, or it is refused.

/** Is this an absolute http(s) address? */
export function isHttpUrl(value) {
  if (typeof value !== 'string' || !value) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The keys of `body` that hold something other than an http(s) address.
 * Absent, null and empty values are not addresses and are not judged here —
 * whether a field is required is the route's own business.
 */
export function badUrls(body, keys) {
  return keys.filter((k) => {
    const v = body?.[k];
    return v !== undefined && v !== null && v !== '' && !isHttpUrl(v);
  });
}

/** The 400 every route answers with, naming the fields. */
export function refuseBadUrls(res, bad) {
  return res.status(400).json({ error: `${bad.join(', ')} must be an http(s) address`, code: 'bad_url' });
}
