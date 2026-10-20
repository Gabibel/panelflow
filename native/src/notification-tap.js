// Tapping a new-chapter banner opens the chapter it is about.
//
// notify.js has always put the chapter's address in the banner (`data.url`),
// for this, and nothing ever read it back: a tap opened the app wherever it
// was, and the reader went looking for the series by hand (QA P8). The
// computer has done it since the first alert (background.js,
// notifications.onClicked).
//
// Both ways a tap arrives: the app already running (a listener), and the app
// launched by the tap (the response the launch left behind, read once). The
// address goes to `open`, which is the shell's one door into the in-app
// browser (Shell.js, openUrl): anything but http(s) stops there.
//
// No import, so a test runs it with a stand-in for expo-notifications: `api`
// is that module.

const targetOf = (response) => response?.notification?.request?.content?.data?.url ?? null;

/** Follow taps from now on; returns what stops it. */
export function followTaps(api, open) {
  const follow = (response) => {
    const url = targetOf(response);
    if (!url) return;
    // Handled once. Left behind, the same response is "the last one" again
    // after a JavaScript reload (an update applied on return to the app), and
    // the chapter would open a second time with nobody tapping.
    try {
      const cleared = (api.clearLastNotificationResponse ?? api.clearLastNotificationResponseAsync)?.call(api);
      cleared?.catch?.(() => {});
    } catch { /* nothing to clear */ }
    open(url);
  };
  try {
    const launch = api.getLastNotificationResponse?.();
    if (launch) follow(launch);
  } catch { /* a module that cannot say: no launch by a tap, as far as anyone knows */ }
  const sub = api.addNotificationResponseReceivedListener?.(follow);
  return () => sub?.remove?.();
}
