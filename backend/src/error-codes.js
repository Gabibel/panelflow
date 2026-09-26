// The name of every refusal, beside its sentence.
//
// Each route answers a refusal with an English sentence (`error`), written for
// whoever reads the log. The clients used to put that sentence on screen as it
// was — "invalid credentials", "wrong password", "too many requests" in the
// middle of a French interface (QA, September 2026). A reader needs the same
// refusal in their own language, and a client can only translate what it can
// recognise, so every refusal now also carries a `code`: a stable name the
// clients look up as `err_<code>` in shared/_locales.
//
// Named here, once, rather than at each of the ~80 places a route refuses:
// `withErrorCodes` (mounted first in index.js) adds the code to any JSON body
// that has an `error` and no `code`, from the sentence when it is one of the
// known ones and from the status otherwise. A route that knows better sets its
// own `code`, and that one is kept.
//
// backend/test/i18n.test.js holds the other half: every code this file can
// produce has a sentence in every locale.

/**
 * Known sentences (matched case-insensitively, anywhere in `error`) → code.
 * The first match wins, so a needle that another one contains comes first:
 * "too many redirects" is a site that misbehaved, not a rate limit.
 */
export const BY_SENTENCE = [
  ['too many redirects', 'site_unreachable'],
  ['push is not configured', 'push_unavailable'],
  // Accounts.
  ['invalid credentials', 'invalid_credentials'],
  ['email already registered', 'email_taken'],
  ['a valid e-mail address is required', 'bad_email'],
  ['password is longer than', 'password_too_long'],
  ['min 8 chars', 'weak_password'],
  ['wrong password', 'wrong_password'],
  ['that is already your address', 'same_email'],
  ['link is no longer valid', 'link_expired'],
  ['is not configured on this server', 'mail_unavailable'],
  ['could not send the email', 'mail_failed'],
  ['unknown user', 'unknown_user'],
  ['missing bearer token', 'session_ended'],
  ['invalid token', 'session_ended'],
  ['password changed', 'session_ended'],
  // Limits.
  ['too many', 'rate_limited'],
  ['read a lot of pages', 'rate_limited'],
  // Trackers.
  ['connection to this tracker has expired', 'tracker_expired'],
  ['the connection has expired', 'tracker_expired'],
  ['connect that tracker first', 'tracker_not_connected'],
  ['not connected', 'tracker_not_connected'],
  ['not linked', 'tracker_not_linked'],
  ['service not configured', 'tracker_unavailable'],
  ['pushing progress to', 'tracker_unavailable'],
  ['nothing can be imported from', 'tracker_unavailable'],
  ['rather than an authorisation page', 'tracker_unavailable'],
  ['unknown service', 'tracker_unavailable'],
  ['did not say which account', 'tracker_failed'],
  // The sites the server reads for you.
  ['site unreachable', 'site_unreachable'],
  ['site answered', 'site_unreachable'],
  ['redirect', 'site_unreachable'],
  ['site blocked the request', 'site_blocked'],
  ['challenging the server', 'site_blocked'],
  ['url not allowed', 'bad_url'],
  ['invalid url', 'bad_url'],
  // The library and its shelves.
  ['is longer than', 'too_long'],
  ['must be a list of at most', 'too_long'],
  ['already have a category with that name', 'category_exists'],
  ['categories', 'too_many_items'],
  ['items at a time', 'too_many_items'],
  ['not found', 'not_found'],
  ['does not exist', 'not_found'],
  // Import and export.
  ['newer PanelFlow', 'backup_too_new'],
  ['does not look like a PanelFlow export', 'import_invalid'],
  ['entries in that export', 'import_invalid'],
  ['post the export', 'import_invalid'],
  // Notifications.
  ['push service', 'bad_push_endpoint'],
  ['push subscription needs', 'bad_push_endpoint'],
  ['no browser registered for push', 'push_none'],
  // Services that are down.
  ['search unavailable', 'search_unavailable'],
  ['unavailable', 'unavailable'],
];

/** What a refusal is called when its sentence is none of the above. */
export const BY_STATUS = {
  400: 'bad_request',
  401: 'session_ended',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'too_large',
  429: 'rate_limited',
  500: 'server_error',
  502: 'upstream_failed',
  503: 'unavailable',
};

/** Codes a route sets itself, which no sentence above produces. */
export const SET_BY_ROUTES = ['bad_url', 'bad_push_endpoint'];

/** Every code a client can receive, for the test that holds the locale files to it. */
export const CODES = [...new Set([
  ...BY_SENTENCE.map(([, code]) => code), ...Object.values(BY_STATUS), ...SET_BY_ROUTES,
])].sort();

export function codeFor(sentence, status) {
  const said = String(sentence ?? '').toLowerCase();
  for (const [needle, code] of BY_SENTENCE) {
    if (said.includes(needle.toLowerCase())) return code;
  }
  const s = Number(status);
  return BY_STATUS[s] ?? (s >= 500 ? 'server_error' : 'bad_request');
}

/** Express middleware: every JSON refusal leaves with a `code`. */
export function withErrorCodes(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body === 'object' && !Array.isArray(body)
        && typeof body.error === 'string' && !body.code && res.statusCode >= 400) {
      return json({ ...body, code: codeFor(body.error, res.statusCode) });
    }
    return json(body);
  };
  next();
}
