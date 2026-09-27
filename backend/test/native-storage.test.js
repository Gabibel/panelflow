// The phone's store, and the one key in it that is a secret (QA report, F-51).
//
// The bearer token is the account. In AsyncStorage it was a file in the app's
// folder — in the phone's backups, and on the next phone with them. It lives in
// the Keychain now, this device's only; and because a Keychain item outlives
// the app, a marker beside the library says whether the token there is this
// install's. Lifted out of the shipping native/src/storage.js over an
// in-memory AsyncStorage and Keychain, so nothing here restates the rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'native', 'src', 'storage.js'), 'utf8');
const body = src
  .replace("import AsyncStorage from '@react-native-async-storage/async-storage';", '')
  .replace("import * as SecureStore from 'expo-secure-store';", '')
  .replace('export const storage =', 'const storage =');
assert.ok(!/^import /m.test(body) && body.includes('const storage ='), 'storage.js is not shaped the way this test expects');

const MARKER = 'pf-device:tokenInKeychain';

/** A fresh module over a phone whose AsyncStorage and Keychain are the maps given. */
function phone({ file = {}, keychain = {}, available = true, refuse = false } = {}) {
  const disk = new Map(Object.entries(file));
  const chain = new Map(Object.entries(keychain));
  const options = [];
  const AsyncStorage = {
    getItem: async (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: async (k, v) => { disk.set(k, v); },
    removeItem: async (k) => { disk.delete(k); },
    multiGet: async (keys) => keys.map((k) => [k, disk.has(k) ? disk.get(k) : null]),
    multiSet: async (pairs) => { for (const [k, v] of pairs) disk.set(k, v); },
    multiRemove: async (keys) => { for (const k of keys) disk.delete(k); },
    getAllKeys: async () => [...disk.keys()],
  };
  const SecureStore = {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
    isAvailableAsync: async () => available,
    getItemAsync: async (k, o) => { options.push(o); return chain.has(k) ? chain.get(k) : null; },
    setItemAsync: async (k, v, o) => {
      options.push(o);
      if (refuse) throw new Error('errSecInteractionNotAllowed');
      chain.set(k, v);
    },
    deleteItemAsync: async (k, o) => { options.push(o); chain.delete(k); },
  };
  const storage = new Function('AsyncStorage', 'SecureStore', `${body}\nreturn storage;`)(AsyncStorage, SecureStore);
  return { storage, disk, chain, options, reopen: () => phone({ file: Object.fromEntries(disk), keychain: Object.fromEntries(chain), available }) };
}

test('the token goes to the Keychain, and nowhere in the file', async () => {
  const p = phone();
  await p.storage.set({ authToken: 'tok-1', authUser: { email: 'r@example.test' } });
  assert.equal(p.chain.get('pf.authToken'), JSON.stringify('tok-1'));
  assert.ok(!p.disk.has('pf:authToken'), 'the token is still in the file');
  assert.equal(p.disk.get('pf:authUser'), JSON.stringify({ email: 'r@example.test' }));
  assert.deepEqual(await p.storage.get(['authToken', 'authUser']), { authToken: 'tok-1', authUser: { email: 'r@example.test' } });
  // This phone's only, and readable by the background check once the phone
  // has been unlocked since it started.
  assert.ok(p.options.every((o) => o?.keychainAccessible === 'afterFirstUnlockThisDeviceOnly'));
});

test('signing out takes it out of the Keychain', async () => {
  const p = phone();
  await p.storage.set({ authToken: 'tok-1' });
  // The core writes null, not undefined, when an account signs out.
  await p.storage.set({ authToken: null, authUser: null });
  assert.equal(p.chain.size, 0);
  assert.ok(!p.disk.has(MARKER));
  assert.equal((await p.storage.get(['authToken'])).authToken, undefined);
});

test('a token signed in before this version is moved out of the file on the first read', async () => {
  const p = phone({ file: { 'pf:authToken': JSON.stringify('tok-old'), 'pf:library': '[]' } });
  assert.equal((await p.storage.get(['authToken'])).authToken, 'tok-old');
  assert.equal(p.chain.get('pf.authToken'), JSON.stringify('tok-old'));
  assert.ok(!p.disk.has('pf:authToken'));
  assert.equal(p.disk.get(MARKER), '1');
});

test('installed again over an old Keychain item, the app is signed out', async () => {
  // AsyncStorage went with the app; the Keychain item did not.
  const p = phone({ keychain: { 'pf.authToken': JSON.stringify('tok-last-install') } });
  assert.equal((await p.storage.get(['authToken'])).authToken, undefined);
  assert.equal(p.chain.size, 0, 'the last install\'s token is still in the Keychain');
});

test('restored onto another phone, the library comes and the token does not', async () => {
  const p = phone({ file: { [MARKER]: '1', 'pf:library': '[1]' } });
  assert.deepEqual(await p.storage.get(['authToken', 'library']), { library: [1] });
  assert.ok(!p.disk.has(MARKER));
});

test('reading everything includes the token, and never the marker', async () => {
  const p = phone();
  await p.storage.set({ authToken: 'tok-1', library: [] });
  const all = await p.storage.get(null);
  assert.deepEqual(all, { authToken: 'tok-1', library: [] });
});

test('with no Keychain — the web build — the token stays where it always was', async () => {
  const p = phone({ available: false });
  await p.storage.set({ authToken: 'tok-web' });
  assert.equal(p.disk.get('pf:authToken'), JSON.stringify('tok-web'));
  assert.equal(p.chain.size, 0);
  assert.equal((await p.storage.get(['authToken'])).authToken, 'tok-web');
});

test('a Keychain that refuses keeps the sign-in, and the token moves once it answers', async () => {
  const p = phone({ refuse: true });
  await p.storage.set({ authToken: 'tok-1' });
  assert.equal(p.disk.get('pf:authToken'), JSON.stringify('tok-1'), 'the sign-in was lost');
  const later = p.reopen();
  assert.equal((await later.storage.get(['authToken'])).authToken, 'tok-1');
  assert.equal(later.chain.get('pf.authToken'), JSON.stringify('tok-1'));
  assert.ok(!later.disk.has('pf:authToken'));
});
