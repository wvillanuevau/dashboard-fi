// ══════════════════════════════════════════════════════
// SERVICE WORKER — Dashboard FI / Portal Asistencia
// Fusiona: caché offline (original) + notificaciones
// ══════════════════════════════════════════════════════

// ── Caché offline (código original sin cambios) ───────
const CACHE_NAME = 'proyectos-pro-v1';
const urlsToCache = [
  './',
  './index.html',
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;500;600;700;800&family=Karla:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://cdn.jsdelivr.net/npm/@zxing/library@0.19.1/umd/index.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(urlsToCache)));
});

self.addEventListener('fetch', event => {
  if (event.request.url.includes('firestore.googleapis.com')) {
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(caches.match(event.request).then(response => response || fetch(event.request)));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.map(key => { if (key !== CACHE_NAME) return caches.delete(key); }))));
});

// ══════════════════════════════════════════════════════
// NOTIFICACIONES — Portal de Asistencia FISDC
// ══════════════════════════════════════════════════════
var _notifTimers = [];

// Mensajes desde el portal
self.addEventListener('message', function(e) {
  var msg = e.data;
  if (!msg || !msg.tipo) return;

  if (msg.tipo === 'PROGRAMAR_NOTIFS') _programarNotificaciones(msg.config);
  if (msg.tipo === 'CANCELAR_NOTIFS')  _cancelarTodos();
  if (msg.tipo === 'TEST') {
    self.registration.showNotification('🔔 FISDC — Notificaciones activas', {
      body: 'Las notificaciones están funcionando. Recibirás recordatorios de asistencia cada día.',
      icon: '/dashboard-fi/icon-192.png',
      badge: '/dashboard-fi/icon-192.png',
      tag: 'test-' + Date.now(),
      vibrate: [200, 100, 200, 100, 200],
      requireInteraction: false,
      data: { url: '/dashboard-fi/portal-asistencia.html' }
    }).catch(function(e) {
      console.error('[SW] Error mostrando notif:', e);
    });
  }
});

// Clic en notificación → abrir/enfocar el portal
self.addEventListener('notificationclick', function(e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url)
    || '/dashboard-fi/portal-asistencia.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.indexOf('portal-asistencia') >= 0 && 'focus' in list[i])
          return list[i].focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

// Push desde servidor (FCM — fase futura)
self.addEventListener('push', function(e) {
  if (!e.data) return;
  var data = e.data.json();
  e.waitUntil(self.registration.showNotification(data.title || 'FISDC', {
    body: data.body || 'Recordatorio',
    icon: '/dashboard-fi/icon-192.png',
    vibrate: [200, 100, 200],
    tag: data.tag || 'fisdc',
    data: { url: data.url || '/dashboard-fi/portal-asistencia.html' }
  }));
});

// ── Programar recordatorios del día ──────────────────
function _programarNotificaciones(config) {
  _cancelarTodos();
  if (!config) return;

  var ahora = new Date();
  var hoy = ahora.toISOString().slice(0, 10);

  // Recordatorios de asistencia (todos los empleados)
  if (config.esEmpleado) {
    [
      { hora: config.horaEntrada    || '07:00', titulo: '🏢 Hora de marcar entrada',         cuerpo: 'Recuerda registrar tu entrada en el Portal de Asistencia.',    tag: 'entrada-'    + hoy },
      { hora: config.horaAlmuerzo   || '12:00', titulo: '🍽️ Hora de almuerzo',               cuerpo: 'No olvides marcar tu salida a almuerzo.',                      tag: 'alm-sal-'    + hoy },
      { hora: config.horaRegresoAlm || '13:00', titulo: '↩️ ¿Ya regresaste del almuerzo?',   cuerpo: 'Marca tu regreso para mantener tu registro al día.',            tag: 'alm-reg-'    + hoy },
      { hora: config.horaSalida     || '16:45', titulo: '🏠 Recuerda marcar tu salida',       cuerpo: 'Antes de irte, registra tu salida en el portal.',              tag: 'salida-'     + hoy }
    ].forEach(function(r) {
      _programarEn(r.hora, r.titulo, r.cuerpo, r.tag, config.portalUrl);
    });
  }

  // Recordatorio de km (solo motoristas)
  if (config.esMotorista) {
    _programarEn(
      config.horaKm || '16:00',
      '🚛 Registro de km pendiente',
      'Hola ' + (config.nombreMotorista || '') + ', recuerda reportar el km de tu vehículo.',
      'km-' + hoy,
      config.portalMotoristaUrl
    );
  }
}

function _programarEn(horaStr, titulo, cuerpo, tag, url) {
  var ahora  = new Date();
  var partes = (horaStr || '08:00').split(':');
  var target = new Date(ahora);
  target.setHours(parseInt(partes[0]), parseInt(partes[1] || 0), 0, 0);

  var msHasta = target.getTime() - ahora.getTime();
  if (msHasta < 0) return; // ya pasó hoy

  console.log('[SW Notif] Programando en', Math.round(msHasta / 60000), 'min:', titulo);

  _notifTimers.push(setTimeout(function() {
    self.registration.showNotification(titulo, {
      body: cuerpo,
      icon: '/dashboard-fi/icon-192.png',
      vibrate: [300, 100, 300, 100, 300],
      tag: tag,
      requireInteraction: true,
      data: { url: url || '/dashboard-fi/portal-asistencia.html' }
    });
  }, msHasta));
}

function _cancelarTodos() {
  _notifTimers.forEach(function(t) { clearTimeout(t); });
  _notifTimers = [];
}
