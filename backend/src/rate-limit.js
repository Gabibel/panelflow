// How many times a thing may be done, and how often.
//
// Three different problems, one counter. Guessing a password must not be free —
// bcrypt at cost 10 blocks the lambda's only thread for ~70 ms, so an unlimited
// login endpoint is a password oracle *and* a way to take the API down with a
// loop. Asking for reset mails must not be free either, or the endpoint becomes
// a way to mail-bomb someone else's inbox. And the routes that spend a fetch of
// our own on someone else's site must not be free, or a signed-up stranger has
// a proxy at our expense and our reputation.
//
// The counter lives in the database, not in a Map. There is no process here to
// hold a Map: consecutive requests land on different lambdas, and a limit each
// instance counts separately allows the limit times the number of instances.
// One row per bucket, one round trip per check.
//
// A bucket is named after who is being counted — `login-account:<e-mail>`,
// `forgot-email:<e-mail>`, `login-ip:<address>` — and is *stored* under a
// keyed hash of that name (`bucketKey`), never the name. The table outlives the
// accounts it counts, and it used to hold their addresses in clear for up to
// three days after a deletion, next to addresses of people who never signed up
// (QA, September 2026). A counter only has to tell two callers apart.
import { db } from './db.js';
import { pseudonym } from './pseudonym.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });

const tune = (name, fallback) => {
  const set = Number(process.env[`PANELFLOW_LIMIT_${name}`]);
  return Number.isFinite(set) && set > 0 ? set : fallback;
};

/**
 * Every ceiling in one place, and every one of them overridable — a limit that
 * can only be changed by a deploy is a limit nobody raises at three in the
 * morning when it turns out to be wrong. The defaults are what production runs.
 *
 * The numbers are chosen against what the *legitimate* extreme looks like, not
 * against what feels safe: an office behind one address, a reader who mistypes,
 * a shelf of two hundred series being checked. Anything that would inconvenience
 * those is too tight, whatever it does to an attacker.
 */
export const LIMITS = {
  // Sign-in attempts from one address, right or wrong. Sized to leave the
  // bcrypt cost — ~70 ms of blocked thread each — well short of a way to stall
  // the function.
  loginIp:      { max: tune('LOGIN_IP', 30),      windowSec: 900 },
  // Failures against one account, from anywhere. Cleared by a success.
  loginAccount: { max: tune('LOGIN_ACCOUNT', 10), windowSec: 900 },
  // Sign-ups from one network. Counted only once the form is valid, and sized
  // for a mobile carrier's shared address on launch day rather than for one
  // household: ten an hour turned away the eleventh person on the same carrier
  // (QA, September 2026).
  register:     { max: tune('REGISTER', 30),      windowSec: 3600 },
  // Mails that can be aimed at one inbox, from any number of machines.
  forgotEmail:  { max: tune('FORGOT_EMAIL', 3),   windowSec: 3600 },
  forgotIp:     { max: tune('FORGOT_IP', 10),     windowSec: 3600 },
  reset:        { max: tune('RESET', 10),         windowSec: 3600 },
  // Not a request count: a budget of *outbound page fetches*, spent by the
  // routes that go and read someone else's site on the caller's behalf. Those
  // are the ones where a free account is otherwise a free proxy, billed to our
  // function time and charged to our reputation with the scan sites. Each route
  // declares what it costs (src/routes/meta.js, src/routes/search.js).
  fetchBudget:  { max: tune('FETCH', 300),        windowSec: 3600 },
  // Images the public cover relay goes and fetches for one address. It is the
  // one outbound route with no account behind it (an <img> sends no token),
  // so the address is all there is to count. Only what goes out is charged —
  // a cover already cached costs nothing to serve again — and a shelf of two
  // hundred series opened on a new device is two hundred of those, twice over
  // for a household behind one address.
  coverIp:      { max: tune('COVER_IP', 600),     windowSec: 3600 },
};

// Increment and roll the window over in a single statement. Doing it as
// read-then-write would be two round trips *and* a race: two requests reading 9
// would both write 10 and both be allowed. Here the database decides, once.
//
// The CASE is the window: if this bucket's window opened longer ago than the
// window length, the row is reused as a fresh one rather than deleted and
// re-inserted. A bucket therefore costs one row forever, not one row per window.
const SPEND = `
  INSERT INTO rate_limits (bucket, count, window_start)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT (bucket) DO UPDATE SET
    count = CASE WHEN window_start <= datetime('now', ?) THEN excluded.count ELSE count + excluded.count END,
    window_start = CASE WHEN window_start <= datetime('now', ?) THEN datetime('now') ELSE window_start END
  RETURNING count, window_start
`;

/** The row a bucket is kept under: a keyed hash of its name, never the name. */
export const bucketKey = (bucket) => pseudonym('bucket', bucket);

/**
 * Charge `cost` to `bucket` and say whether it stayed within `max` per
 * `windowSec`. Never throws on the caller's behalf — see `enforce`.
 * @returns {Promise<{ ok: boolean, count: number, retryAfter: number }>}
 */
export async function spend(bucket, { max, windowSec, cost = 1 }) {
  const ago = `-${windowSec} seconds`;
  const row = await db.prepare(SPEND).get(bucketKey(bucket), cost, ago, ago);
  const count = Number(row?.count ?? 0);
  const started = parseSqlDate(row?.window_start);
  const elapsed = started === null ? 0 : (Date.now() - started) / 1000;
  return {
    ok: count <= max,
    count,
    retryAfter: Math.max(1, Math.ceil(windowSec - elapsed)),
  };
}

/** As `spend`, but a 429 with a Retry-After when the bucket is spent. */
export async function enforce(res, bucket, opts) {
  const verdict = await spend(bucket, opts);
  if (!verdict.ok) {
    res.set('Retry-After', String(verdict.retryAfter));
    throw httpError(429, opts.message ?? 'too many requests, try again later');
  }
  return verdict;
}

/**
 * Charge an account for going and reading someone else's page.
 *
 * One budget shared by every route that does it, rather than a separate count
 * per route: what is being protected is the function's time and our standing
 * with the scan sites, and neither of those cares which endpoint spent it. The
 * `cost` is roughly how many pages the call will fetch, so a request that
 * fetches twenty is not one request.
 */
export const spendFetches = (req, res, cost) => enforce(res, `fetch:${req.user.id}`, {
  ...LIMITS.fetchBudget,
  cost,
  message: 'you have asked the server to read a lot of pages — try again in a little while',
});

/**
 * Forget a bucket. Called when the thing being counted turns out to have been
 * legitimate — a correct password clears that account's failure count, so
 * someone who mistypes twice a day for a month is never locked out by the sum.
 */
export const forget = (bucket) =>
  db.prepare('DELETE FROM rate_limits WHERE bucket = ?').run(bucketKey(bucket));

/**
 * Whether the request came through a proxy that writes x-forwarded-for itself.
 *
 * Vercel does, and overwrites whatever the client sent, so there the header is
 * the client. Anywhere else it is whatever the client chose to write: trusted
 * everywhere, it let anyone pick the bucket they were counted in, a fresh one
 * per request (QA, September 2026). A deployment behind another proxy of that
 * kind says so with PANELFLOW_TRUST_PROXY=1.
 */
const trustProxy = () => !!process.env.VERCEL || process.env.PANELFLOW_TRUST_PROXY === '1';

/**
 * The caller's address, as far as it can be known: the left-most entry of
 * x-forwarded-for behind a trusted proxy, the socket's address otherwise.
 * Nothing is *granted* on the strength of it, only refused.
 */
export function callerIp(req) {
  if (trustProxy()) {
    const forwarded = String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * The network an address belongs to, for counting.
 *
 * An IPv4 address is one line, often shared. An IPv6 subscriber is handed a
 * whole /64 — eighteen quintillion addresses to rotate through — so counted per
 * address, one machine was an unlimited number of callers. Counted per /64 it
 * is one, as it is on IPv4.
 */
export function networkOf(ip) {
  let text = String(ip ?? '').trim().toLowerCase().replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped) text = mapped[1];
  if (!text.includes(':') || !/^[0-9a-f:]+$/.test(text)) return text || 'unknown';
  const [head, tail] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = tail === undefined
    ? left
    : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '') || '0').join(':')}::/64`;
}

/** The caller's network: what the per-address limits count. */
export const callerNetwork = (req) => networkOf(callerIp(req));

/** SQLite's 'YYYY-MM-DD HH:MM:SS', which is UTC and says so nowhere. */
function parseSqlDate(value) {
  if (!value) return null;
  const ms = Date.parse(String(value).replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Drop counters whose window closed long ago. Nothing depends on this — a stale
 * row is reused, not consulted — it only stops the table growing by one row per
 * address that ever mistyped a password. Run from the nightly cron, so a row
 * lives two days after its window opened and at most one more day before the
 * sweep comes round: three days in all, which is what the privacy page says.
 */
export const pruneRateLimits = () =>
  db.prepare("DELETE FROM rate_limits WHERE window_start <= datetime('now', '-2 days')").run();
