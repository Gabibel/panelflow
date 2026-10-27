// What PanelFlow Premium is on this phone, as plain data.
//
// The App Store's answer arrives through RevenueCat's SDK (./premium.js) as a
// `CustomerInfo`; the account's answer arrives from the server (backend/src/
// premium.js). This file turns both into the one shape the screens read,
// `{ active, until, ... }`, and decides the one question that has to work with
// no network at all: is this phone still Premium right now?
//
// It has to, because the reason to pay for offline space is reading where
// there is no network. So the answer is kept (./premium.js writes it down) and
// judged here against the clock, never against a server that cannot be
// reached:
//
// - until the date Apple gave, it is Premium;
// - a subscription that renews does so on that date, and a phone that has
//   been offline since cannot have heard about it. It keeps Premium for
//   GRACE_MS past that date, and the first look with a network settles it.
//   A subscription the App Store had already said will not renew gets no such
//   grace: it ends on its date.
//
// No import, so a test runs it as it is.

/** The entitlement configured in RevenueCat for the subscription. */
export const ENTITLEMENT = 'premium';

/** How long a renewing subscription is believed past its date, unconfirmed. */
export const GRACE_MS = 3 * 24 * 3600 * 1000;

export const NOT_PREMIUM = Object.freeze({ active: false, until: null, willRenew: false, trial: false, checkedAt: null });

const iso = (v) => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/**
 * The App Store's answer, as kept. `customerInfo.entitlements.active` holds
 * only the entitlements that count right now; an expiration date of null
 * there is a lifetime grant.
 */
export function fromCustomerInfo(info, now = Date.now()) {
  const e = info?.entitlements?.active?.[ENTITLEMENT];
  const checkedAt = new Date(now).toISOString();
  if (!e || e.isActive === false) return { ...NOT_PREMIUM, checkedAt };
  return {
    active: true,
    until: iso(e.expirationDate),
    willRenew: !!e.willRenew,
    trial: e.periodType === 'TRIAL',
    checkedAt,
  };
}

/** Whether a kept answer still says Premium at `now`. */
export function stillPremium(state, now = Date.now()) {
  if (!state || state.active !== true) return false;
  if (state.until === null) return true;
  const until = Date.parse(state.until);
  if (!Number.isFinite(until)) return false;
  if (now < until) return true;
  // Past its date: believed for a while only when it was going to renew and
  // nobody has been able to ask since.
  const asked = Date.parse(state.checkedAt);
  const unconfirmed = !Number.isFinite(asked) || asked < until;
  return state.willRenew && unconfirmed && now < until + GRACE_MS;
}

/**
 * The phone's answer and the account's, together. Either one is enough: a
 * subscription bought on this iPhone counts before any account is signed in,
 * and an account made Premium elsewhere (a grant, another iPhone on the same
 * account) counts here too. The later end date is the one shown.
 */
export function combine(device, account, now = Date.now()) {
  const onDevice = stillPremium(device, now);
  const onAccount = !!account?.active;
  if (!onDevice && !onAccount) return { active: false, until: null, source: null, willRenew: false, trial: false };
  const until = [onDevice ? device.until : undefined, onAccount ? account.until ?? null : undefined]
    .filter((u) => u !== undefined)
    .reduce((a, b) => (a === null || b === null ? null : (Date.parse(a) >= Date.parse(b) ? a : b)));
  return {
    active: true,
    until,
    source: onDevice ? 'device' : 'account',
    willRenew: onDevice ? !!device.willRenew : false,
    trial: onDevice ? !!device.trial : false,
  };
}

/**
 * The two plans on offer, from RevenueCat's current offering, with their
 * prices as the App Store wrote them for this phone's country and currency.
 * Never a price written here: the store's is the only one allowed on screen.
 *
 * `eligibility` is RevenueCat's answer to "may this Apple ID still have the
 * free trial"; the trial is only offered when it says yes, so nobody is
 * promised seven free days that the App Store will then not give.
 */
export function plansFrom(offerings, eligibility = {}) {
  const current = offerings?.current;
  if (!current) return null;
  const plan = (pkg, period) => {
    const p = pkg?.product;
    if (!p || typeof p.priceString !== 'string') return null;
    const intro = p.introPrice;
    const trialDays = intro && Number(intro.price) === 0 ? daysOf(intro) : 0;
    const eligible = eligibility?.[p.identifier]?.status === ELIGIBLE;
    return {
      id: pkg.identifier,
      product: p.identifier,
      period,
      price: p.priceString,
      trialDays: eligible ? trialDays : 0,
    };
  };
  const monthly = plan(current.monthly, 'month');
  const annual = plan(current.annual, 'year');
  return monthly || annual ? { monthly, annual } : null;
}

/** RevenueCat's INTRO_ELIGIBILITY_STATUS.INTRO_ELIGIBILITY_STATUS_ELIGIBLE. */
export const ELIGIBLE = 2;

function daysOf(intro) {
  const n = Number(intro.periodNumberOfUnits) || 0;
  const unit = String(intro.periodUnit || '').toUpperCase();
  return unit === 'DAY' ? n : unit === 'WEEK' ? n * 7 : unit === 'MONTH' ? n * 30 : unit === 'YEAR' ? n * 365 : 0;
}
