// ══════════════════════════════════════════════════════
// SERVICE WORKER — Dashboard FI / Portal Asistencia
// ══════════════════════════════════════════════════════

const CACHE_NAME = 'dashboard-fi-v3';
const urlsToCache = [
  './',
  './index.html',
  './portal-asistencia.html'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(key => { if (key !== CACHE_NAME) return caches.delete(key); })
    ))
  );
  self.clients.claim();
});

// CRÍTICO: No interceptar Firebase/Google APIs — causan errores de fetch con streams
self.addEventListener('fetch', event => {
  const url = event.request.url;

  // Dejar pasar SIN TOCAR todo lo de Firebase/Google
  if (url.includes('firestore.googleapis.com') ||
      url.includes('firebase') ||
      url.includes('googleapis.com') ||
      url.includes('gstatic.com') ||
      url.includes('firebaseapp.com') ||
      url.includes('firebaseio.com')) {
    return; // NO llamar event.respondWith — deja que el navegador lo maneje
  }

  // Solo cachear recursos propios del app
  event.respondWith(
    caches.match(event.request).then(response => {
      if (response) return response;
      return fetch(event.request).catch(() => {
        // Si falla la red y no hay caché, devolver respuesta vacía
        return new Response('', { status: 503 });
      });
    })
  );
});

// ══════════════════════════════════════════════════════
// NOTIFICACIONES PUSH (FCM)
// ══════════════════════════════════════════════════════
self.addEventListener('push', function(e) {
  if (!e.data) return;
  var data = {};
  try { data = e.data.json(); } catch(err) { data = { title: 'FISDC', body: e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'FISDC', {
    body:    data.body || '',
    icon:    '/dashboard-fi/icon-192.png',
    badge:   '/dashboard-fi/icon-96.png',
    vibrate: [300, 100, 300],
    tag:     data.tag || 'fisdc-' + Date.now(),
    requireInteraction: false,
    data:    { url: data.url || '/dashboard-fi/' }
  }));
});

self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/dashboard-fi/';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf('dashboard-fi') >= 0 && 'focus' in list[i]) return list[i].focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// ══════════════════════════════════════════════════════
// NOTIFICACIONES LOCALES (programadas)
// ══════════════════════════════════════════════════════
var _notifTimers = [];

self.addEventListener('message', function(e) {
  var msg = e.data;
  if (!msg || !msg.tipo) return;
  if (msg.tipo === 'PROGRAMAR_NOTIFS') _programarNotificaciones(msg.config);
  if (msg.tipo === 'CANCELAR_NOTIFS')  _cancelarTodos();
  if (msg.tipo === 'TEST') {
    self.registration.showNotification('🔔 FISDC — Notificaciones activas', {
      body: 'Las notificaciones están funcionando correctamente.',
      icon: '/dashboard-fi/icon-192.png',
      badge: '/dashboard-fi/icon-96.png',
      tag: 'test-' + Date.now(),
      vibrate: [200, 100, 200]
    });
  }
});

function _programarNotificaciones(config) {
  _cancelarTodos();
  if (!config || !config.esEmpleado) return;
  var hoy = new Date().toISOString().slice(0, 10);
  [
    { hora: config.horaEntrada    || '07:00', titulo: '🏢 Hora de marcar entrada',       cuerpo: 'Recuerda registrar tu entrada.', tag: 'entrada-' + hoy },
    { hora: config.horaAlmuerzo   || '12:00', titulo: '🍽️ Hora de almuerzo',             cuerpo: 'Marca tu salida a almuerzo.',    tag: 'alm-sal-' + hoy },
    { hora: config.horaRegresoAlm || '13:00', titulo: '↩️ ¿Ya regresaste?',              cuerpo: 'Marca tu regreso del almuerzo.', tag: 'alm-reg-' + hoy },
    { hora: config.horaSalida     || '16:45', titulo: '🏠 Recuerda marcar tu salida',     cuerpo: 'Registra tu salida antes de irte.', tag: 'salida-' + hoy }
  ].forEach(function(r) { _programarEn(r.hora, r.titulo, r.cuerpo, r.tag); });
}

function _programarEn(horaStr, titulo, cuerpo, tag) {
  var ahora = new Date();
  var partes = (horaStr || '08:00').split(':');
  var target = new Date(ahora);
  target.setHours(parseInt(partes[0]), parseInt(partes[1] || 0), 0, 0);
  var msHasta = target.getTime() - ahora.getTime();
  if (msHasta < 0) return;
  _notifTimers.push(setTimeout(function() {
    self.registration.showNotification(titulo, {
      body: cuerpo, icon: '/dashboard-fi/icon-192.png',
      badge: '/dashboard-fi/icon-96.png',
      vibrate: [300, 100, 300], tag: tag, requireInteraction: true
    });
  }, msHasta));
}

function _cancelarTodos() {
  _notifTimers.forEach(function(t) { clearTimeout(t); });
  _notifTimers = [];
}
