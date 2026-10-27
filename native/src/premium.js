// PanelFlow Premium on the iPhone: buying it, and knowing it was bought.
//
// The App Store sells the subscription; RevenueCat's SDK
// (react-native-purchases) talks to StoreKit and keeps the receipt, and
// ./premium-state.js decides what its answer means. This file is the only one
// that touches the SDK, so a screen asks `premiumStatus()` or `buy('annual')`
// and never sees StoreKit.
//
// Two answers are combined (premium-state.js, combine):
//
// - the phone's: the App Store's, through RevenueCat. It works before any
//   account exists and with no network, which is what offline space needs.
//   It is written down after every look, so a phone on a plane still knows.
// - the account's: the server's (`getPremium` in the core), which asked
//   RevenueCat itself. It is what the statistics are served on, and it covers
//   an account made Premium on another iPhone.
//
// The phone never tells the server it paid. After a purchase or a restore it
// asks the server to look again (`refreshPremium`), and the server asks
// RevenueCat. See backend/src/premium.js.
//
// Who RevenueCat thinks this is: the account's id once one is signed in
// (`identify`), so the server can find the purchase under it. Before that,
// RevenueCat's own anonymous id, and signing in carries the purchase over to
// the account. Signing out changes nothing: the phone, and the Apple ID that
// pays, are the same, and taking Premium away from them would be wrong.
import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Purchases from 'react-native-purchases';
import { send } from './core.js';
import {
  ENTITLEMENT, NOT_PREMIUM, combine, fromCustomerInfo, plansFrom, stillPremium,
} from './premium-state.js';

/**
 * RevenueCat's public key for the iOS app, set in EAS (`EXPO_PUBLIC_…` is
 * inlined into the bundle at build time). Public by design: it can read
 * offerings and make purchases for this phone, nothing about anyone else.
 * Without it there is nothing to sell, and every screen says so.
 */
const API_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY || '';

const KEPT = 'panelflow.premium';

/** Whether this build can sell Premium at all. */
export const premiumOffered = () => Platform.OS === 'ios' && !!API_KEY;

let started = null;
let identity = null;
let kept = null;
const listeners = new Set();

/** Be told whenever the phone's answer changes. Returns the unsubscribe. */
export function onPremiumChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function readKept() {
  if (kept) return kept;
  try {
    const raw = await AsyncStorage.getItem(KEPT);
    kept = raw ? JSON.parse(raw) : { ...NOT_PREMIUM };
  } catch {
    kept = { ...NOT_PREMIUM };
  }
  return kept;
}

async function remember(info) {
  kept = fromCustomerInfo(info);
  await AsyncStorage.setItem(KEPT, JSON.stringify(kept)).catch(() => {});
  for (const fn of listeners) {
    try { fn(kept); } catch { /* a screen that went away */ }
  }
  return kept;
}

/**
 * Start the SDK, once, under the account when there is one. Never throws:
 * a store that cannot be reached is a phone that keeps its last answer.
 */
async function start(accountId = null) {
  if (!premiumOffered()) return false;
  if (!started) {
    started = (async () => {
      Purchases.configure({ apiKey: API_KEY, appUserID: accountId || null });
      identity = accountId || null;
      Purchases.addCustomerInfoUpdateListener((info) => { remember(info); });
      return true;
    })().catch((e) => {
      started = null;
      console.warn('[panelflow] the App Store could not be reached', e?.message ?? e);
      return false;
    });
  }
  return started;
}

/** The account the purchases belong to, from now on. See the header. */
export async function identify(accountId) {
  if (!(await start(accountId))) return;
  if (!accountId || accountId === identity) return;
  try {
    const { customerInfo } = await Purchases.logIn(accountId);
    identity = accountId;
    await remember(customerInfo);
    // The purchase may have been made before this account existed: the
    // server only finds it under the account once RevenueCat has moved it.
    if (stillPremium(kept)) await send({ type: 'refreshPremium' });
  } catch (e) {
    console.warn('[panelflow] Premium could not follow the account', e?.message ?? e);
  }
}

/** The phone's answer, asked again when there is a network, kept otherwise. */
async function deviceState() {
  if (await start(identity)) {
    try { return await remember(await Purchases.getCustomerInfo()); } catch { /* offline */ }
  }
  return readKept();
}

/**
 * Whether Premium counts on this phone now, and why.
 * @returns {Promise<{ offered: boolean, active: boolean, until: string|null,
 *   source: 'device'|'account'|null, willRenew: boolean, trial: boolean }>}
 */
export async function premiumStatus() {
  const [device, account] = await Promise.all([
    deviceState(),
    send({ type: 'getPremium' }).then((r) => r?.premium ?? null),
  ]);
  return { offered: premiumOffered(), ...combine(device, account) };
}

/**
 * The phone's answer alone, from what was last written down, without asking
 * anyone. For the places that cannot wait on a network: the offline cap.
 */
export async function premiumHere() {
  return stillPremium(await readKept());
}

/** The plans on offer, priced by the App Store, or null when there are none. */
export async function premiumPlans() {
  if (!(await start(identity))) return null;
  try {
    const offerings = await Purchases.getOfferings();
    const ids = [offerings?.current?.monthly, offerings?.current?.annual]
      .map((p) => p?.product?.identifier).filter(Boolean);
    const eligibility = ids.length
      ? await Purchases.checkTrialOrIntroductoryPriceEligibility(ids).catch(() => ({}))
      : {};
    return plansFrom(offerings, eligibility);
  } catch {
    return null;
  }
}

/** After the App Store said yes: the server is asked to look too. */
async function settle(customerInfo) {
  const state = await remember(customerInfo);
  await send({ type: 'refreshPremium' });
  return { ok: true, active: stillPremium(state) };
}

/**
 * Buy one plan. `{ cancelled: true }` when the reader closed Apple's sheet,
 * which is not an error and is not shown as one.
 */
export async function buy(period) {
  if (!(await start(identity))) return { error: 'unavailable' };
  try {
    const offerings = await Purchases.getOfferings();
    const pkg = period === 'year' ? offerings?.current?.annual : offerings?.current?.monthly;
    if (!pkg) return { error: 'unavailable' };
    const { customerInfo } = await Purchases.purchasePackage(pkg);
    return settle(customerInfo);
  } catch (e) {
    if (e?.userCancelled) return { cancelled: true };
    return { error: String(e?.message ?? e) };
  }
}

/** "Restore purchases": what Apple asks every app selling a subscription to have. */
export async function restore() {
  if (!(await start(identity))) return { error: 'unavailable' };
  try {
    return settle(await Purchases.restorePurchases());
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

/** Apple's own page for cancelling or changing the subscription. */
export async function manageSubscription() {
  try {
    if (await start(identity)) {
      await Purchases.showManageSubscriptions();
      return;
    }
  } catch { /* fall through to the page */ }
  await Linking.openURL('https://apps.apple.com/account/subscriptions').catch(() => {});
}

export { ENTITLEMENT };
