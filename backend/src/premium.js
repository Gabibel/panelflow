// PanelFlow Premium: who has it, and how the server comes to know.
//
// The subscription is sold by Apple, inside the iPhone app, and RevenueCat
// keeps the receipts (native/src/premium.js is the buying side). This file is
// the server's half, and it holds one fact per account: `users.premium_until`,
// the moment the subscription stops counting. An account is Premium while that
// moment is in the future, so a lapsed subscription ends on its own, on time,
// without a job having to come and switch anybody off.
//
// Where the fact comes from matters more than where it is kept. It is only
// ever written from RevenueCat's own answer to "who is this customer"
// (GET /v1/subscribers/{id}), asked by this server with its secret key:
//
// - after a purchase or a restore, the app asks the server to look again
//   (POST /api/premium/refresh);
// - whenever anything changes on Apple's side (a renewal, a refund, a
//   cancellation that has now run out), RevenueCat calls the webhook, and the
//   webhook does not believe a word of the event beyond *whom* it is about. It
//   asks the same question again. That is RevenueCat's own advice, and the
//   reason is that an event can arrive late, twice or out of order, while the
//   answer to "who is this customer, now" is always current.
//
// So no client can make itself Premium: the phone says "look again", never
// "I paid". The one thing a caller chooses is which account the server asks
// about, and that is always the caller's own (req.user.id), or one named by a
// webhook that proved it knows the shared secret.
//
// Asking about an id RevenueCat has never seen *creates* a customer under it.
// That is why the webhook only ever asks about ids that are accounts here.
import { timingSafeEqual } from 'node:crypto';
import { db } from './db.js';

/** The entitlement configured in RevenueCat for the subscription. */
export const ENTITLEMENT = 'premium';

/** What "never ends" is stored as: a lifetime grant has no expiry date. */
export const FOREVER = '9999-12-31T23:59:59.000Z';

const DEFAULT_API = 'https://api.revenuecat.com';

/**
 * Whether this server can sell anything at all. Without the secret key the
 * server cannot check a purchase, and saying "Premium" without checking would
 * be the bug; the clients hide the offer instead.
 */
export const premiumConfigured = () => !!process.env.REVENUECAT_SECRET_KEY;

/**
 * Where RevenueCat's API is. Overridable so the tests can stand a local one
 * up (test-support/no-network.js refuses everything else), and only to an
 * https address or this machine: the secret key goes with every request, and
 * a typo in an environment variable must not send it in clear. A value that
 * is neither is no address at all (null), and nothing is sent.
 */
function apiBase() {
  const set = process.env.PANELFLOW_REVENUECAT_API;
  if (!set) return DEFAULT_API;
  let u;
  try { u = new URL(set); } catch { return null; }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  return u.origin;
}

/** The address of one customer, or an error when there is nowhere to ask. */
function customerUrl(userId) {
  const at = apiBase();
  if (!at) throw Object.assign(new Error('premium unavailable'), { status: 503 });
  return `${at}/v1/subscribers/${encodeURIComponent(userId)}`;
}

/** The shape of an account id here (crypto.randomUUID, see db.js uid). */
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isAccountId = (id) => typeof id === 'string' && ACCOUNT_ID.test(id);

const later = (a, b) => (a === null ? b : b === null ? a : (Date.parse(a) >= Date.parse(b) ? a : b));

/**
 * When the Premium entitlement in a RevenueCat subscriber stops counting, as
 * an ISO moment, or null when there is none.
 *
 * The later of the expiry and the billing grace period: Apple keeps a
 * subscriber served for a few days while it retries a failed card, and so do
 * we. An entitlement with no expiry at all is a lifetime one (a promotional
 * grant from the dashboard), stored as FOREVER.
 */
export function premiumUntilFrom(subscriber) {
  const e = subscriber?.entitlements?.[ENTITLEMENT];
  if (!e || typeof e !== 'object') return null;
  if (e.expires_date === null) return FOREVER;
  const dates = [e.expires_date, e.grace_period_expires_date]
    .filter((d) => typeof d === 'string' && Number.isFinite(Date.parse(d)))
    .map((d) => new Date(d).toISOString());
  return dates.reduce((a, b) => later(a, b), null);
}

/** Whether a stored `premium_until` is still in the future. */
export function premiumActive(until, now = Date.now()) {
  if (typeof until !== 'string' || !until) return false;
  const t = Date.parse(until);
  return Number.isFinite(t) && t > now;
}

/** What a client is told: whether, and until when. */
export const premiumOf = (until, now = Date.now()) => {
  const active = premiumActive(until, now);
  return { active, until: active ? until : null };
};

/**
 * RevenueCat's current answer for one account.
 * @returns {Promise<object>} the `subscriber` object
 */
export async function fetchSubscriber(userId) {
  if (!premiumConfigured()) throw Object.assign(new Error('premium unavailable'), { status: 503 });
  if (!isAccountId(userId)) throw Object.assign(new Error('not an account id'), { status: 400 });
  const resp = await fetch(customerUrl(userId), {
    headers: { Authorization: `Bearer ${process.env.REVENUECAT_SECRET_KEY}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    // The status only: RevenueCat's error body may quote the request.
    throw Object.assign(new Error(`revenuecat answered ${resp.status}`), { status: 502 });
  }
  const body = await resp.json().catch(() => null);
  if (!body || typeof body.subscriber !== 'object' || body.subscriber === null) {
    throw Object.assign(new Error('revenuecat answered something unexpected'), { status: 502 });
  }
  return body.subscriber;
}

/**
 * Ask RevenueCat about one account and write down what it said.
 * @returns {Promise<{ active: boolean, until: string|null }>}
 */
export async function syncPremium(userId) {
  const until = premiumUntilFrom(await fetchSubscriber(userId));
  await db.prepare(
    "UPDATE users SET premium_until = ?, premium_checked_at = datetime('now') WHERE id = ?",
  ).run(until, userId);
  return premiumOf(until);
}

/**
 * Forget the customer RevenueCat keeps under a deleted account. Best effort:
 * the account is gone whatever this answers, and the privacy page promises
 * the deletion, not the network. Apple's own record of the purchase is
 * Apple's, and the subscription itself is cancelled in the iPhone's settings,
 * which the app says before deleting.
 */
export async function forgetSubscriber(userId) {
  if (!premiumConfigured() || !isAccountId(userId)) return false;
  try {
    const resp = await fetch(customerUrl(userId), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${process.env.REVENUECAT_SECRET_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Whether a webhook call carries the value set in RevenueCat's dashboard as
 * its Authorization header. Compared in constant time, and never true when
 * the server has no value set: an unset secret is not an empty one.
 */
export function webhookAuthorized(header) {
  const want = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (!want || typeof header !== 'string') return false;
  const a = Buffer.from(header);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The accounts a webhook event is about. A transfer moves a purchase from one
 * customer to another, and both sides change; every other event names one
 * customer under all of its ids. Only ids shaped like an account are kept,
 * and never more than a handful: an event is not a way to make this server
 * ask RevenueCat about a list.
 */
export function accountsInEvent(event) {
  if (!event || typeof event !== 'object') return [];
  const list = (v) => (Array.isArray(v) ? v : []);
  const ids = event.type === 'TRANSFER'
    ? [...list(event.transferred_from), ...list(event.transferred_to)]
    : [event.app_user_id, event.original_app_user_id, ...list(event.aliases)];
  return [...new Set(ids.filter(isAccountId).map((id) => id.toLowerCase()))].slice(0, 10);
}
