// The key/value store `createCore` asks for, on top of AsyncStorage.
//
// The Kotlin and Swift shells hand the core an offscreen WebView's
// localStorage, because neither language can run the core itself. Here the core
// runs in the app's own JavaScript engine, so the store is the app's own
// storage — same contract (`get(keys)` / `set(obj)`, JSON in and out), one
// fewer WebView, and no origin to lose the library to.
import AsyncStorage from '@react-native-async-storage/async-storage';

// The same prefix the mobile worker uses, for the same reason: AsyncStorage is
// shared with anything else in the app that wants a key, and the core is
// allowed to enumerate its own without seeing theirs.
const PREFIX = 'pf:';

export const storage = {
  /** `null` means every key the core owns — that is how `getAll` is spelt. */
  async get(keys) {
    const list = keys === null || keys === undefined
      ? (await AsyncStorage.getAllKeys())
        .filter((k) => k.startsWith(PREFIX)).map((k) => k.slice(PREFIX.length))
      : (Array.isArray(keys) ? keys : [keys]);
    if (list.length === 0) return {};
    const out = {};
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
      if (v === undefined) removals.push(PREFIX + k);
      else writes.push([PREFIX + k, JSON.stringify(v)]);
    }
    if (writes.length) await AsyncStorage.multiSet(writes);
    if (removals.length) await AsyncStorage.multiRemove(removals);
  },
};
