'use strict';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || './CryptoOffer_V13_4.html';
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({type:'window', includeUncontrolled:true});
    for (const client of clientsList) {
      if ('focus' in client) {
        try {
          const url = new URL(client.url);
          if (url.pathname.endsWith('/CryptoOffer_V13_4.html') || url.pathname.endsWith('/')) {
            await client.focus();
            return;
          }
        } catch (_) {}
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});
