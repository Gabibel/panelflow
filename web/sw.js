// The part of PanelFlow that runs when PanelFlow is not open.
//
// A service worker has no page, no localStorage and no session — it is woken by
// the browser, handed a decrypted payload, and given a few seconds. So it does
// exactly two things: turn the payload into a notification, and turn a click on
// that notification into a focused tab. Everything that needs to know who is
// signed in happens in app.js, where there is a page to ask.
const FALLBACK = { title: 'PanelFlow', body: 'A series you follow has a new chapter.', url: '/' };

self.addEventListener('push', (event) => {
  let data = FALLBACK;
  try {
    // A push service is allowed to wake a worker with no payload at all, and
    // Chrome does it when a message is dropped. Showing *something* is not
    // optional: a push permission is revoked by browsers that receive a push
    // and display nothing.
    if (event.data) data = { ...FALLBACK, ...event.data.json() };
  } catch { /* not our JSON; the fallback still says something true */ }

  event.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    // Two runs about the same series replace each other rather than stacking.
    tag: data.tag || 'panelflow-news',
    renotify: true,
    data: { url: data.url || '/' },
  }));
});

/**
 * Where a click on a notification may take the reader, as a URL: a page of this
 * app, or an http(s) address, and the app's front page for anything else.
 *
 * A payload carries a series' address as the library stored it, and the server
 * stored whatever a client sent until it learnt to refuse anything but http(s).
 * A javascript: or data: address from before then is not one to open a window
 * on. Read as a URL rather than as text, so "//elsewhere.example" is the other
 * site it names and not, for starting with a slash, a page of this one.
 */
function clickTarget(url) {
  try {
    const u = new URL(url, self.location.origin);
    if (u.protocol === 'https:' || u.protocol === 'http:') return u;
  } catch { /* not an address at all: the front page below */ }
  return new URL('/', self.location.origin);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = clickTarget(event.notification.data?.url || '/');
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Reuse a tab that is already on this origin rather than opening a fifth
    // copy of the library — but only for links back into the app. A chapter is
    // on a scan site, which is somebody else's origin and gets its own tab.
    if (target.origin === self.location.origin && open.length) {
      await open[0].focus();
      if ('navigate' in open[0]) await open[0].navigate(target.href);
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});

// The browser may rotate a subscription on its own. There is no token here to
// register the new one with, so the worker cannot fix it — but dropping the
// stale one stops the server pushing into a void, and app.js re-subscribes the
// next time the reader opens the app.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(event.oldSubscription?.unsubscribe?.() ?? Promise.resolve());
});
