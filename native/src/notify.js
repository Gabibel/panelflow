// "A new chapter is out." — the OS half of it.
//
// The core decides when; this only decides how it is shown. It is written so
// that a phone which refuses notifications is a phone that still works: every
// call is guarded, because in Expo Go on some platforms the module is present
// but declines to schedule, and a library that will not open because a banner
// could not be raised would be a poor trade.
//
// And it never asks by itself. The system's "Allow notifications?" used to
// appear the first time a check found something — in the middle of reading, or
// from a background task with nobody looking (QA report, F-48). It is asked
// now when the reader turns the switch on in Settings › New chapters, which is
// the one moment the question makes sense. A phone that already said yes to it
// before keeps its notifications.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Linking } from 'react-native';
import * as Notifications from 'expo-notifications';

// This phone's answer, and not the account's: a reader who wants banners on
// the phone in their pocket did not thereby ask for them on a tablet at home.
// Outside the core's `pf:` keys, so a sign-out does not reset it.
const KEY = 'pf-device:notifyNewChapters';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

async function permission() {
  try {
    return await Notifications.getPermissionsAsync();
  } catch (e) {
    console.warn('[panelflow] notifications unavailable', e);
    return { granted: false, canAskAgain: false };
  }
}

/**
 * Whether new chapters are announced on this phone: `{ on, blocked }`.
 * `blocked` is the system saying no, which only the Settings app can undo.
 */
export async function notificationState() {
  const [stored, perm] = await Promise.all([AsyncStorage.getItem(KEY).catch(() => null), permission()]);
  // Never answered here: on if the system was already asked and said yes
  // (a phone from before the switch existed), off otherwise.
  const wanted = stored === null ? !!perm.granted : stored === '1';
  return { on: wanted && !!perm.granted, blocked: !perm.granted && perm.canAskAgain === false };
}

/** The switch. Turning it on is when the system's question is asked. */
export async function setNotifications(on) {
  if (!on) {
    await AsyncStorage.setItem(KEY, '0').catch(() => {});
    return { on: false, blocked: false };
  }
  let perm = await permission();
  if (!perm.granted && perm.canAskAgain !== false) {
    try { perm = await Notifications.requestPermissionsAsync(); } catch { /* answered below */ }
  }
  await AsyncStorage.setItem(KEY, perm.granted ? '1' : '0').catch(() => {});
  return { on: !!perm.granted, blocked: !perm.granted };
}

/** Where notifications are allowed again once refused: the system's own page for this app. */
export const openNotificationSettings = () => Linking.openSettings();

/**
 * Raise one — only when the reader turned them on here and the system still
 * allows it. `null` triggers mean "now", which is what the core means: this is
 * never a reminder, it is the result of a check that has already happened.
 */
export async function raise(notification) {
  if (!(await notificationState()).on) return;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: notification?.title ?? 'PanelFlow',
        body: notification?.message ?? '',
        // Carried through so tapping the banner can open the chapter it is
        // about, rather than just the app.
        data: { url: notification?.url ?? null, id: notification?.id ?? null },
      },
      trigger: null,
    });
  } catch (e) {
    console.warn('[panelflow] could not raise a notification', e);
  }
}
