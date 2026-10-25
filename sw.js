// sw.js - Service Worker

self.addEventListener('push', function(event) {
  if (!event.data) return;

  try {
    const data = event.data.json();
    
    const options = {
      body: data.body || 'Tienes un recordatorio',
      icon: './icon-192.png',
      badge: './icon-192.png',
      // Patrón de vibración: [vibrar, pausa, vibrar, pausa...] en milisegundos
      vibrate: [500, 200, 500, 200, 500, 200, 500], 
      // Sonido (en navegadores de PC y Android. En iOS el sonido lo controla el sistema)
      sound: './alarma.mp3', 
      requireInteraction: true, // La notificación se queda en pantalla hasta que la toques
      data: {
        url: data.url || './'
      }
    };

    event.waitUntil(
      self.registration.showNotification(data.title || 'Mi Agenda', options)
    );
  } catch (e) {
    console.error('Error al procesar la notificación push:', e);
  }
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if (client.url === event.notification.data.url && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(event.notification.data.url);
      }
    })
  );
});