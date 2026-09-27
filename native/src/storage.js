// The key/value store `createCore` asks for, on top of AsyncStorage — and, for
// the one key that is a secret, the Keychain.
//
// The Kotlin and Swift shells hand the core an offscreen WebView's
// localStorage, because neither language can run the core itself. Here the core
// runs in the app's own JavaScript engine, so the store is the app's own
// storage — same contract (`get(keys)` / `set(obj)`, JSON in and out), one
// fewer WebView, and no origin to lose the library to.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

// The same prefix the mobile worker uses, for the same reason: AsyncStorage is
// shared with anything else in the app that wants a key, and the core is
// allowed to enumerate its own without seeing theirs.
const PREFIX = 'pf:';

/**
 * The account's bearer token, kept in the Keychain rather than beside the
 * library (QA report, F-51). AsyncStorage is a file in the app's folder: it
 * goes into the phone's backups and onto the next phone with them, and the
 * token in it is the account. The Keychain item is this device's only, and
 * readable once the phone has been unlocked after a restart — which the
 * background check for new chapters needs, since it runs with the screen off.
 */
const SECRET = 'authToken';
const KEYCHAIN_KEY = 'pf.authToken';
const KEYCHAIN_OPTIONS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

/**
 * Where the token is, written beside the library.
 *
 * A Keychain item outlives the app: deleting PanelFlow and installing it again
 * would find the last account's token and nothing else of it. This marker
 * lives in AsyncStorage, which goes with the app, so a token found without it
 * is a leftover and is erased. Not under PREFIX: it is the device's, not a key
 * the core owns (the same reason notify.js keeps its switch under `pf-device:`).
 */
const MARKER = 'pf-device:tokenInKeychain';

// Asked once. The web build — the test bench — has no Keychain, and keeps the
// token where it always was.
let keychain = null;
const hasKeychain = () => {
  keychain ??= SecureStore.isAvailableAsync().catch(() => false);
  return keychain;
};

let leftoverCleared = false;

/** The token, from the Keychain; moved there first if it is still in the file. */
async function readSecret() {
  if (await AsyncStorage.getItem(MARKER)) {
    const raw = await SecureStore.getItemAsync(KEYCHAIN_KEY, KEYCHAIN_OPTIONS).catch(() => null);
    if (raw !== null) {
      try { return JSON.parse(raw); } catch { return undefined; }
    }
    // Restored onto another phone: the library came with the backup, the
    // token (this device's only) did not. Signed out, which is the truth.
    await AsyncStorage.removeItem(MARKER);
    return undefined;
  }
  // Installed again over an old Keychain item: not this install's. Once per
  // launch is enough; signed out, this path is taken on every request.
  if (!leftoverCleared) {
    leftoverCleared = true;
    await SecureStore.deleteItemAsync(KEYCHAIN_KEY, KEYCHAIN_OPTIONS).catch(() => {});
  }
  // Signed in before this version: the token is still in the file. Moved.
  const legacy = await AsyncStorage.getItem(PREFIX + SECRET);
  if (legacy === null) return undefined;
  let value;
  try { value = JSON.parse(legacy); } catch { return undefined; }
  await writeSecret(value);
  return value;
}

/** Writes or erases the token; a Keychain that refuses keeps it in the file. */
async function writeSecret(value) {
  if (value === undefined || value === null) {
    await SecureStore.deleteItemAsync(KEYCHAIN_KEY, KEYCHAIN_OPTIONS).catch(() => {});
    await AsyncStorage.multiRemove([MARKER, PREFIX + SECRET]);
    return;
  }
  try {
    await SecureStore.setItemAsync(KEYCHAIN_KEY, JSON.stringify(value), KEYCHAIN_OPTIONS);
    await AsyncStorage.setItem(MARKER, '1');
    await AsyncStorage.removeItem(PREFIX + SECRET);
  } catch {
    // A sign-in that silently did not stick is worse than a token in the
    // file; the next read moves it once the Keychain answers again.
    await AsyncStorage.removeItem(MARKER);
    await AsyncStorage.setItem(PREFIX + SECRET, JSON.stringify(value));
  }
}

export const storage = {
  /** `null` means every key the core owns — that is how `getAll` is spelt. */
  async get(keys) {
    const every = keys === null || keys === undefined;
    const secure = await hasKeychain();
    let list = every
      ? (await AsyncStorage.getAllKeys())
        .filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length))
      : (Array.isArray(keys) ? keys : [keys]);
    const out = {};
    if (secure && (every || list.includes(SECRET))) {
      list = list.filter((k) => k !== SECRET);
      const token = await readSecret();
      if (token !== undefined) out[SECRET] = token;
    }
    if (list.length === 0) return out;
    for (const [key, raw] of await AsyncStorage.multiGet(list.map((k) => PREFIX + k))) {
      if (raw === null) continue;
      // A corrupt value is treated as unset rather than thrown: one unreadable
      // key must not take the whole library down with it on boot.
      try { out[key.slice(PREFIX.length)] = JSON.parse(raw); } catch { /* unset */ }
    }
    return out;
  },

  async set(obj) {
    const writes = [];
    const removals = [];
    for (const [k, v] of Object.entries(obj)) {
      if (k === SECRET && await hasKeychain()) await writeSecret(v);
      else if (v === undefined) removals.push(PREFIX + k);
      else writes.push([PREFIX + k, JSON.stringify(v)]);
    }
    if (writes.length) await AsyncStorage.multiSet(writes);
    if (removals.length) await AsyncStorage.multiRemove(removals);
  },
};
