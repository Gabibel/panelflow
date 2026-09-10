// Looking for new chapters while the app is closed.
//
// Until now this only happened with the app open: the account screen has a
// "check now" button and the server keeps its own watch on a cron, but a phone
// in a pocket learnt nothing until it was picked up. What that costs is the
// whole point of a shelf — you find out a chapter is out by opening the app to
// see whether a chapter is out.
//
// The work itself is the same `checkNow` the button sends. Everything under it
// already exists: the core walks the watched folders, the sites are asked with
// polite pacing, and anything new is handed to `notify`, which is the local
// notification in native/src/notify.js. This file only arranges for that to
// happen when nobody is looking.
//
// What the OS actually promises is very little, and it is worth saying plainly:
// iOS runs a background task when *it* decides — battery, charge, how often the
// app is opened — so `minimumInterval` is a floor, never a schedule. A phone
// that is never opened may go a day without a check. The server-side watcher
// exists for exactly that reason, and this is the half that reaches a phone
// which never asks.
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { send } from './core.js';

/**
 * The name the OS knows this work by.
 *
 * It is stored by the system, not by us, so changing this string orphans
 * whatever was registered under the old one — hence a constant, spelt once.
 */
const TASK = 'panelflow-check-chapters';

// Defined at module load, and that is a requirement rather than a style: the OS
// starts the app in the background with no UI, and a task defined inside a
// component would not exist yet when it is called.
TaskManager.defineTask(TASK, async () => {
  try {
    const r = await send({ type: 'checkNow' });
    // `checkNow` answers `{ error }` rather than throwing, and the difference
    // matters to the OS: a task that reports failure is one it will schedule
    // more reluctantly.
    return r?.error
      ? BackgroundTask.BackgroundTaskResult.Failed
      : BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    console.warn('[panelflow] the background check failed', e);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/**
 * Ask the OS to run it, no more often than `minutes`.
 *
 * Registering twice is not an error and not a duplicate — the system keeps one
 * registration per name — so this is safe to call on every launch, which is
 * also how a changed interval reaches it.
 *
 * Never throws. In Expo Go there is no background scheduler at all, and an app
 * that would not start because it could not arrange tomorrow's chapter check
 * would be a poor trade.
 */
export async function registerChapterChecks(minutes = 360) {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) {
      // Low Power Mode, Screen Time, a managed device. Nothing to do about it
      // here, and the account screen's button still works.
      console.warn('[panelflow] background checks are not allowed on this device');
      return false;
    }
    await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: Math.max(15, minutes) });
    return true;
  } catch (e) {
    console.warn('[panelflow] could not register the background check', e);
    return false;
  }
}
