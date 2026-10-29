'use strict';

function isSameOriginWindow(client) {
  try {
    return new URL(client.url).origin === self.location.origin;
  } catch (_error) {
    return false;
  }
}

function requestForegroundAlarm(client, id) {
  if (!client || typeof client.postMessage !== 'function' || typeof MessageChannel !== 'function') {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    let settled = false;
    let timeout;
    let channel;
    const finish = (played) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try { channel?.port1?.close(); } catch (_error) {}
      try { channel?.port2?.close(); } catch (_error) {}
      resolve(played === true);
    };

    try {
      channel = new MessageChannel();
      channel.port1.onmessage = (messageEvent) => finish(messageEvent.data?.played === true);
      timeout = setTimeout(() => finish(false), 800);
      client.postMessage({
        type: 'blackridge:mobile-push-critical-alarm',
        id
      }, [channel.port2]);
    } catch (_error) {
      finish(false);
    }
  });
}

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_error) {
    payload = { body: event.data ? event.data.text() : '' };
  }

  const title = String(payload.title || 'BLACK RIDGE CIA').slice(0, 100);
  const priority = String(payload.priority || 'NORMAL').toUpperCase();
  const id = String(payload.id || '').slice(0, 160);
  event.waitUntil((async () => {
    let foregroundClient = null;
    if (priority === 'CRITICAL') {
      try {
        const clients = await self.clients.matchAll({
          type: 'window',
          includeUncontrolled: true
        });
        foregroundClient = clients.find((client) =>
          client.visibilityState === 'visible' && isSameOriginWindow(client)
        ) || null;
      } catch (_error) {
        foregroundClient = null;
      }
    }

    const customAlarmPlayed = foregroundClient
      ? await requestForegroundAlarm(foregroundClient, id)
      : false;
    const options = {
      body: String(payload.body || 'لديك إشعار جديد.').slice(0, 600),
      icon: '/blackridge-notification-icon-192.png',
      badge: '/blackridge-notification-icon-192.png',
      image: '/blackridge-notification-banner.png',
      tag: id,
      renotify: false,
      requireInteraction: priority === 'CRITICAL',
      silent: customAlarmPlayed,
      data: { url: '/' }
    };
    await self.registration.showNotification(title, options);
  })());
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
