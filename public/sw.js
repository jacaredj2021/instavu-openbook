// sw.js. OpenBook service worker.
//
// Intentionally minimal. It exists so OpenBook is installable as a PWA (an app on
// the home screen), but it deliberately does NOT cache app code or API responses.
// That means a deploy is never served stale and your session is never cached: every
// request passes straight through to the network exactly as without a worker.
//
// skipWaiting + clients.claim mean a new worker takes over immediately on the next
// load, so we are never stuck on an old worker. If we ever want real offline support
// we can add a careful network-first cache here later.
//
// TO REMOVE THE PWA LATER: do NOT just delete this file (a 404 does not unregister an
// already-installed worker). Instead ship a version of this file whose activate calls
// self.registration.unregister(), keep it deployed for one update cycle, then delete
// the file. This file is served with Cache-Control: no-cache (see server.js) so that
// replacement reaches installed clients quickly.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Drop any caches a previous version of this worker might have created, then claim
  // open pages so this no-cache worker is in control everywhere right away.
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) { /* caches API may be unavailable; ignore */ }
    await self.clients.claim();
  })());
});

// A fetch handler must exist for installability, but we do not call respondWith, so
// the browser handles every request normally (network, with no SW caching).
self.addEventListener('fetch', () => { /* network passthrough, no caching */ });

// --- Web Push: a new direct message while OpenBook is closed or backgrounded ---
// The server only sends a push when the recipient has no live connection (see
// sockets.js), so here we always show the notification (its arrival is also what
// makes the phone play its notification sound) and set the red count badge on the
// app icon. Showing a notification on every push is also what mobile browsers
// require, so the subscription is not revoked for "silent" pushes.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || 'OpenBook';
  const body = data.body || 'You have a new message on OpenBook.';
  const url = data.url || '/app';
  event.waitUntil((async () => {
    // Reflect the unread-message count on the app-icon badge where supported.
    try {
      if (self.navigator && 'setAppBadge' in self.navigator) {
        if (typeof data.count === 'number' && data.count > 0) await self.navigator.setAppBadge(data.count);
        else if ('clearAppBadge' in self.navigator) await self.navigator.clearAppBadge();
      }
    } catch (e) { /* Badging API not available; ignore */ }
    await self.registration.showNotification(title, {
      body: body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: data.tag || 'dm',
      renotify: true,
      data: { url: url },
    });
  })());
});

// Tapping the notification focuses an existing OpenBook window (or opens one) and
// takes it to Messages.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if ('focus' in c) {
        try { await c.focus(); if ('navigate' in c) { try { await c.navigate(url); } catch (e) {} } return; }
        catch (e) { /* try the next client */ }
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
