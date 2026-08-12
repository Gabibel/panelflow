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

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Reuse a tab that is already on this origin rather than opening a fifth
    // copy of the library — but only for links back into the app. A chapter is
    // on a scan site, which is somebody else's origin and gets its own tab.
    const sameOrigin = target.startsWith('/') || target.startsWith(self.location.origin);
    if (sameOrigin && open.length) {
      await open[0].focus();
      if ('navigate' in open[0]) await open[0].navigate(target);
      return;
    }
    await self.clients.openWindow(target);
  })());
});

// The browser may rotate a subscription on its own. There is no token here to
// register the new one with, so the worker cannot fix it — but dropping the
// stale one stops the server pushing into a void, and app.js re-subscribes the
// next time the reader opens the app.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(event.oldSubscription?.unsubscribe?.() ?? Promise.resolve());
});
