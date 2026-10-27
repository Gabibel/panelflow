// The phone's last answer about PanelFlow Premium, as written down.
//
// Its own file because two sides need it and must not need each other: the
// buying side (./premium.js, which talks to the core) writes it, and the
// offline store (./offline.js, which the core loads) reads it before every
// page it keeps. Reading it here asks nobody: no network, no SDK, which is
// the point of offline space.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { NOT_PREMIUM, stillPremium } from './premium-state.js';

const KEY = 'panelflow.premium';

let kept = null;

export async function readKept() {
  if (kept) return kept;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    kept = raw ? JSON.parse(raw) : { ...NOT_PREMIUM };
  } catch {
    kept = { ...NOT_PREMIUM };
  }
  return kept;
}

export async function writeKept(state) {
  kept = state;
  await AsyncStorage.setItem(KEY, JSON.stringify(state)).catch(() => {});
  return state;
}

/** Whether this phone is Premium now, from what was written down. */
export async function premiumHere() {
  return stillPremium(await readKept());
}
