// Partykeller: kleiner Service Worker. Holt die Seite immer frisch, faellt offline auf den letzten Stand zurueck.
const CACHE = 'partykeller-v5';
const SUPABASE_URL = 'https://txucqslsykzfhwugdolt.supabase.co';
const SUPABASE_KEY = 'sb_publishable_60QG69Q7CZ6Ai0qrGePH6w_sMXGaSdT';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});

// Push-Benachrichtigung anzeigen
self.addEventListener('push', e => {
  let msg = { title: 'Partykeller', body: 'Es gibt was Neues.', url: './', tag: 'partykeller' };
  try { msg = Object.assign(msg, e.data.json()); } catch {}
  const shown = self.registration.showNotification(msg.title, {
    body: msg.body, tag: msg.tag, icon: 'icon-192.png', badge: 'icon-192.png', data: { url: msg.url }
  });
  e.waitUntil(Promise.all([shown, msg.mid ? confirmDelivery(msg.mid) : null]));
});
// Beim Antippen die App oeffnen
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.navigate(target).catch(() => {}); return c.focus(); } }
    return clients.openWindow(target);
  }));
});

// Chat-Haken: dem Server melden, dass die Nachricht auf diesem Handy angekommen ist
async function confirmDelivery(mid) {
  try {
    const sub = await self.registration.pushManager.getSubscription();
    if (!sub) return;
    await fetch(SUPABASE_URL + '/rest/v1/rpc/push_received', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY },
      body: JSON.stringify({ p_endpoint: sub.endpoint, p_msg: mid })
    });
  } catch {}
}
