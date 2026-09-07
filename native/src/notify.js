// "A new chapter is out." — the OS half of it.
//
// The core decides when; this only decides how it is shown. It is written so
// that a phone which refuses notifications is a phone that still works: every
// call is guarded, because in Expo Go on some platforms the module is present
// but declines to schedule, and a library that will not open because a banner
// could not be raised would be a poor trade.
import * as Notifications from 'expo-notifications';

let ready = null;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

/** Ask once, and remember the answer for the rest of the session. */
export async function ensurePermission() {
  if (ready) return ready;
  ready = (async () => {
    try {
      const current = await Notifications.getPermissionsAsync();
      if (current.granted) return true;
      const asked = await Notifications.requestPermissionsAsync();
      return !!asked.granted;
    } catch (e) {
      console.warn('[panelflow] notifications unavailable', e);
      return false;
    }
  })();
  return ready;
}

/**
 * Raise one. `null` triggers mean "now", which is what the core means: this is
 * never a reminder, it is the result of a check that has already happened.
 */
export async function raise(notification) {
  if (!(await ensurePermission())) return;
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
