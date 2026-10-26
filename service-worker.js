'use strict';

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_error) {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = String(payload.title || 'BLACK RIDGE CIA').slice(0, 100);
  const priority = String(payload.priority || 'NORMAL').toUpperCase();
  const options = {
    body: String(payload.body || 'لديك إشعار جديد.').slice(0, 600),
    icon: '/blackridge-push-icon-192.png',
    badge: '/blackridge-push-icon-192.png',
    tag: String(payload.id || ''),
    renotify: false,
    requireInteraction: priority === 'CRITICAL',
    data: { url: '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL('/', self.location.origin);
  const requestedPath = String(event.notification.data?.url || '/');
  try {
    const parsed = new URL(requestedPath, self.location.origin);
    if (parsed.origin === self.location.origin) target.href = parsed.href;
  } catch (_error) {
    // Keep the default same-origin route.
  }

  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => {
      try {
        return new URL(client.url).origin === self.location.origin && typeof client.focus === 'function';
      } catch (_error) {
        return false;
      }
    });
    if (!existing) return self.clients.openWindow(target.href);
    if (typeof existing.navigate === 'function') {
      return existing.navigate(target.href).then((navigated) => (navigated || existing).focus());
    }
    return existing.focus();
  }));
});
