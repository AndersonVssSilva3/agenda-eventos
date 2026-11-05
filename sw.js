// sw.js - Service Worker

// Activar la versión nueva del service worker de inmediato
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const VIBRACION = [500, 200, 500, 200, 500, 200, 500];

self.addEventListener('push', function (event) {
  if (!event.data) return;

  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    data = { body: event.data.text() };
  }

  const title = data.title || 'Mi Agenda';
  const options = {
    body: data.body || 'Tienes un recordatorio',
    icon: './icon-192.png',
    badge: './icon-192.png',
    // En Android 8+ el sonido/vibración los decide el canal de notificaciones
    // del sistema; aun así lo pedimos explícitamente.
    vibrate: VIBRACION,
    silent: false,
    // Un "tag" distinto por recordatorio + renotify = vuelve a sonar/vibrar
    // aunque haya otra notificación de la app en pantalla.
    tag: data.tag || 'recordatorio-' + Date.now(),
    renotify: true,
    requireInteraction: true, // La notificación se queda en pantalla hasta que la toques
    timestamp: Date.now(),
    data: { url: data.url || './' },
  };

  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    // Si la app está abierta, que suene también dentro de ella
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((c) => c.postMessage({ type: 'reminder', title, body: options.body }));
  })());
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = event.notification.data?.url || './';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
