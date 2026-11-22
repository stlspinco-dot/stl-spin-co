/* STL Spin Co — service worker for web push notifications.
 * No caching, no offline shell — it only exists to receive pushes and
 * show them as notifications, then open /owner when tapped.
 * iPhone: this only runs in the Home Screen web app (iOS 16.4+), after
 * the owner taps "Enable booking notifications" on /owner and allows it.
 */
'use strict';

self.addEventListener('push', (event) => {
  let data = {};
  try {
    if (event.data) data = event.data.json();
  } catch {
    data = {};
  }
  const title = data.title || 'New STL Spin Co booking';
  const body = data.body || 'A new booking request arrived.';
  const url = data.url || '/owner';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.ref || 'stl-spin-co-booking',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/owner';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url.includes(url)) return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
