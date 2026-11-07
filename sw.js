// sw.js - Service Worker
//
// Limitación de los navegadores: un service worker no puede hablar ni reproducir
// audio. Con la app cerrada, el sonido y la vibración los pone el sistema al
// mostrar la notificación. La voz la reproduce la página (ver app.js) en cuanto
// hay una ventana abierta o al tocar la notificación.

const VIBRACION = [500, 200, 500, 200, 500, 200, 500];

// Activa enseguida las versiones nuevas, sin esperar a cerrar todas las pestañas.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function datosRecordatorio(data) {
  const title = data.title || 'Mi Agenda';
  const body = data.body || 'Tienes un recordatorio';
  const key = data.event_id && data.date ? `${data.event_id}:${data.date}` : `${title}:${body}`;
  return { type: 'reminder', key, title, body };
}

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data;
  try {
    data = event.data.json();
  } catch (e) {
    data = { body: event.data.text() };
  }
  const aviso = datosRecordatorio(data);

  event.waitUntil((async () => {
    await self.registration.showNotification(aviso.title, {
      body: aviso.body,
      icon: './icon-192.png',
      badge: './icon-192.png',
      vibrate: VIBRACION,
      tag: aviso.key,
      renotify: true,
      requireInteraction: true, // Se queda en pantalla hasta que la toques
      data: aviso,
    });
    // Si la app está abierta (aunque sea en segundo plano), que hable y vibre.
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    ventanas.forEach((w) => w.postMessage(aviso));
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const aviso = event.notification.data || {};

  event.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (ventanas.length) {
      const w = ventanas[0];
      if (aviso.key) w.postMessage(aviso);
      return 'focus' in w ? w.focus() : undefined;
    }
    // App cerrada: se abre y anuncia el recordatorio al cargar.
    const url = new URL('./', self.registration.scope);
    if (aviso.key) {
      url.searchParams.set('alerta_key', aviso.key);
      url.searchParams.set('alerta_titulo', aviso.title);
      url.searchParams.set('alerta_texto', aviso.body);
    }
    return self.clients.openWindow(url.href);
  })());
});
