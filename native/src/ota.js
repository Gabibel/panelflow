// The JavaScript of this app, updated without a build.
//
// A TestFlight build is fifteen minutes of EAS and a quota of fifteen a month;
// most of what changes between two of them is JavaScript. expo-updates lets
// that JavaScript be published to a channel (`npm run update:ios`) and picked
// up by every installed build of the same runtime version, which here is the
// app's version in app.json: a build of 0.1.0 takes every update published
// for 0.1.0, and a change to native code (a new module, a new permission) is
// a version bump and a real build.
//
// What the phone does with it: at launch, the bundle it has is started at
// once and the channel is asked in the background (app.json, `updates`); a
// newer bundle is downloaded and used at the next launch. Coming back to the
// foreground asks again, so a phone that stays open for days still gets it
// at its next cold start. And the report page has a button that asks now and
// restarts on a hit, for a tester told "it is fixed, update".
//
// Every call here is a no-op where updates are off: Expo Go, a development
// build, the simulator. `Updates.isEnabled` says so, and nothing else in the
// app needs to know.
import { AppState } from 'react-native';
import * as Updates from 'expo-updates';
import { note } from './diagnostics.js';

/** The code the app is running: the update's id, or "embedded" for the build's own bundle. */
export function codeId() {
  if (!Updates.isEnabled) return 'dev';
  if (Updates.isEmbeddedLaunch || !Updates.updateId) return 'embedded';
  return String(Updates.updateId).slice(0, 8);
}

/**
 * Ask the channel now. Returns one of:
 *   'off'      updates are not enabled in this build
 *   'none'     nothing newer on the channel
 *   'applied'  a newer bundle was fetched and the app is restarting on it
 *   'failed'   the channel could not be asked (offline, or a server error)
 *
 * `restart` false fetches without restarting: the next launch will use it.
 */
export async function checkNow(restart = true) {
  if (!Updates.isEnabled) return 'off';
  try {
    const seen = await Updates.checkForUpdateAsync();
    if (!seen.isAvailable) return 'none';
    await Updates.fetchUpdateAsync();
    note('ota', `update ${String(seen.manifest?.id || '').slice(0, 8)} fetched`);
    if (restart) await Updates.reloadAsync();
    return 'applied';
  } catch (e) {
    note('ota', `check failed: ${e?.message || e}`);
    return 'failed';
  }
}

/**
 * Fetch a newer bundle whenever the app comes back to the foreground, for
 * the next launch. Never restarts: a reader in the middle of a chapter is
 * not to be reloaded under their thumb. Returns the function that stops
 * watching.
 */
export function watchForeground() {
  if (!Updates.isEnabled) return () => {};
  let last = AppState.currentState;
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active' && last !== 'active') checkNow(false);
    last = state;
  });
  return () => sub.remove();
}
