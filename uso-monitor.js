/* ════════════════════════════════════════════════════════════════════
   MONITOR DE USO DE FIRESTORE  (uso-monitor.js · v1)
   Cuenta cada lectura/escritura que hacen las páginas del sistema, la
   atribuye a (hora · colección · función que la dispara · página) y la
   sube por lotes a  paConfig/uso_<AAAA-MM-DD>  (día del Pacífico, que es
   el día en que Google reinicia la cuota).
   · Costo propio: ~3 escrituras por teléfono al día (lote cada 30 min).
   · No bloquea nada: si falla, guarda en localStorage y reintenta.
   · Barra de aviso al 50 / 75 / 95 % (solo en páginas de administrador).
   · Panel: uso-firestore.html
   Las cifras son una ESTIMACIÓN (solo cuenta lo que hacen estas páginas).
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.UsoMonitor || !window.firebase || !firebase.firestore) return;

  var LIM_R = 50000, LIM_W = 20000;
  var LS_KEY = 'uso_pend_v1';
  var FLUSH_MS = 30 * 60 * 1000;
  var PAGINA = (location.pathname.split('/').pop() || 'index').replace(/\.html$/, '') || 'index';

  // Identificador de este dispositivo (no cambia mientras no se borren los datos del navegador)
  var DISP = (function () {
    var id = null; try { id = localStorage.getItem('uso_disp_id'); } catch (e) {}
    if (!id) { id = Math.random().toString(36).slice(2, 7).toUpperCase(); try { localStorage.setItem('uso_disp_id', id); } catch (e) {} }
    var ua = navigator.userAgent || '';
    var so = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? ((ua.match(/Android[^;)]*;\s*([^;)]+?)\s*(Build|\))/) || [])[1] || 'Android') : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Otro';
    var nav = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Nav';
    var pwa = false; try { pwa = window.matchMedia('(display-mode: standalone)').matches; } catch (e) {}
    return { id: id, desc: so + ' · ' + nav + (pwa ? ' (app instalada)' : '') };
  })();
  function usuarioActual() {
    try {
      if (window.PA) { if (PA.adminNombre) return 'Admin: ' + PA.adminNombre; if (PA.empleado && PA.empleado.nombre) return 'Empleado: ' + PA.empleado.nombre; }
      if (window.S && S.currentUser) return S.currentUser.nombre || S.currentUser.email || 'usuario';
    } catch (e) {}
    return 'sin sesión';
  }
  var _db = null;          // instancia de Firestore (se toma de la primera operación)
  var _interno = false;    // true mientras el monitor hace sus propias operaciones
  var _pend = {};          // { dia: { r, w, k:{clave:n} } }
  var _ultFlush = Date.now();
  var _total = 0;

  try { _pend = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { _pend = {}; }

  function fmt(tz, opts) { return new Intl.DateTimeFormat('en-CA', Object.assign({ timeZone: tz }, opts)).format(new Date()); }
  function diaPacifico() { return fmt('America/Los_Angeles', { year: 'numeric', month: '2-digit', day: '2-digit' }); }
  function horaSV() {
    var h = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/El_Salvador', hour: '2-digit', hour12: false }).format(new Date());
    return String(parseInt(h, 10) % 24).padStart(2, '0');
  }
  function limpio(s) { return String(s == null ? '?' : s).replace(/[^A-Za-z0-9_\-]/g, '_').slice(0, 60); }

  // Función de tu código que disparó la operación (primer marco fuera del SDK y de este archivo)
  function quienLlama() {
    try {
      var lim = Error.stackTraceLimit; Error.stackTraceLimit = 25;
      var st = (new Error()).stack || ''; Error.stackTraceLimit = lim;
      var lines = st.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (!l || l.indexOf('uso-monitor') >= 0 || l.indexOf('Error') === 0) continue;
        if (/firebasejs|gstatic|firebase-/.test(l)) continue;
        if (/<computed>|\bat\s+DP\.|^\s*DP\./.test(l)) continue;   // envoltorios propios de la página
        var m = l.match(/at\s+(?:async\s+)?([^\s(]+)\s+\(/) || l.match(/^\s*([^\s@(]+)@/);
        var ln = l.match(/:(\d+):\d+\)?\s*$/);
        var nombre = m ? m[1] : 'anon';
        if (nombre === 'Object.<anonymous>' || nombre === 'anonymous' || nombre === '<anonymous>') nombre = 'anon';
        nombre = nombre.replace(/^(Object|Promise|Array|HTMLButtonElement|HTMLElement|Window)\./, '');
        if (nombre === 'anon' && ln) nombre = 'anon_L' + ln[1];
        return nombre;
      }
    } catch (e) {}
    return 'desconocido';
  }
  function coleccion(ref) {
    try {
      var p = ref.path;
      if (!p && ref._delegate && ref._delegate._query) p = ref._delegate._query.path.canonicalString();
      if (!p && ref._delegate && ref._delegate._key) p = ref._delegate._key.path.canonicalString();
      if (!p) return 'desconocida';
      var s = p.split('/');
      return s[0] + (s.length > 2 ? '/' + s[2] : '');
    } catch (e) { return 'desconocida'; }
  }
  function contar(tipo, n, ref, et) {
    if (_interno || !n) return;
    try {
      if (!_db && ref && ref.firestore) _db = ref.firestore;
      var dia = diaPacifico();
      var b = _pend[dia] || (_pend[dia] = { r: 0, w: 0, k: {} });
      if (tipo === 'R') b.r += n; else b.w += n;
      var clave = [horaSV(), tipo, limpio(coleccion(ref)), limpio(et || quienLlama()), limpio(PAGINA + '@' + String(window.PA_VERSION || window.APP_VERSION || '').replace(/^v2026-/, ''))].join('~');
      b.k[clave] = (b.k[clave] || 0) + n;
      var dk = DISP.id + '~' + horaSV();
      var dd = (b.d || (b.d = {}))[dk] || (b.d[dk] = { r: 0, w: 0 });
      if (tipo === 'R') dd.r += n; else dd.w += n;
      b.u = usuarioActual();
      _total += n;
    } catch (e) {}
  }

  // ── Parches ───────────────────────────────────────────────────────
  var F = firebase.firestore;
  function envolver(clase, nombre, fn) {
    try {
      var proto = clase && clase.prototype;
      if (!proto || typeof proto[nombre] !== 'function') return;
      var orig = proto[nombre];
      proto[nombre] = fn(orig);
    } catch (e) {}
  }
  function leyoDeServidor(snap) { return !(snap && snap.metadata && snap.metadata.fromCache); }

  // get() de consultas y documentos
  envolver(F.Query, 'get', function (orig) {
    return function () {
      var interno = _interno, ref = this, args = arguments, et = interno ? null : quienLlama();
      var p = orig.apply(this, args);
      if (!interno && p && p.then) p.then(function (s) { if (leyoDeServidor(s)) contar('R', Math.max(1, s.size || 0), ref, et); }, function () {});
      return p;
    };
  });
  envolver(F.DocumentReference, 'get', function (orig) {
    return function () {
      var interno = _interno, ref = this, et = interno ? null : quienLlama();
      var p = orig.apply(this, arguments);
      if (!interno && p && p.then) p.then(function (s) { if (leyoDeServidor(s)) contar('R', 1, ref, et); }, function () {});
      return p;
    };
  });
  // onSnapshot: cuenta los documentos que llegan del servidor
  function envolverSnap(orig) {
    return function () {
      var ref = this, interno = _interno, args = Array.prototype.slice.call(arguments);
      if (!interno) {
        var et = quienLlama();
        var cuenta = function (s) {
          try {
            if (!leyoDeServidor(s)) return;
            if (typeof s.docChanges === 'function') contar('R', Math.max(1, s.docChanges().length), ref, et);
            else contar('R', 1, ref, et);
          } catch (e) {}
        };
        for (var i = 0; i < args.length; i++) {
          if (typeof args[i] === 'function') { (function (j, f) { args[j] = function (s) { cuenta(s); return f.apply(this, arguments); }; })(i, args[i]); break; }
          if (args[i] && typeof args[i].next === 'function') {
            (function (j, o) { args[j] = { next: function (s) { cuenta(s); return o.next.apply(o, arguments); }, error: o.error && o.error.bind(o), complete: o.complete && o.complete.bind(o) }; })(i, args[i]); break;
          }
        }
      }
      return orig.apply(this, args);
    };
  }
  envolver(F.Query, 'onSnapshot', envolverSnap);
  envolver(F.DocumentReference, 'onSnapshot', envolverSnap);

  // escrituras
  ['set', 'update', 'delete'].forEach(function (m) {
    envolver(F.DocumentReference, m, function (orig) {
      return function () { contar('W', 1, this); return orig.apply(this, arguments); };
    });
  });
  envolver(F.CollectionReference, 'add', function (orig) {
    return function () { contar('W', 1, this); return orig.apply(this, arguments); };
  });
  // lotes: cuenta cada operación del lote
  ['set', 'update', 'delete'].forEach(function (m) {
    envolver(F.WriteBatch, m, function (orig) {
      return function (ref) { contar('W', 1, ref); return orig.apply(this, arguments); };
    });
  });
  // transacciones
  envolver(F.Transaction, 'get', function (orig) {
    return function (ref) { contar('R', 1, ref); return orig.apply(this, arguments); };
  });
  ['set', 'update', 'delete'].forEach(function (m) {
    envolver(F.Transaction, m, function (orig) {
      return function (ref) { contar('W', 1, ref); return orig.apply(this, arguments); };
    });
  });

  // ── Subida por lotes ─────────────────────────────────────────────
  function guardarLocal() { try { localStorage.setItem(LS_KEY, JSON.stringify(_pend)); } catch (e) {} }

  function flush(forzar) {
    guardarLocal();
    if (!_db) return;
    var dias = Object.keys(_pend).filter(function (d) { return _pend[d] && (_pend[d].r || _pend[d].w); });
    if (!dias.length) return;
    if (!forzar && Date.now() - _ultFlush < FLUSH_MS && _total < 800) return;
    _ultFlush = Date.now(); _total = 0;
    var inc = firebase.firestore.FieldValue.increment;
    dias.forEach(function (dia) {
      var b = _pend[dia];
      delete _pend[dia];            // se reinserta si falla
      var k = {}; Object.keys(b.k).forEach(function (c) { k[c] = inc(b.k[c]); });
      var dv = {}; Object.keys(b.d || {}).forEach(function (c) {
        var p = c.split('~'), x = b.d[c];
        dv[p[0]] = dv[p[0]] || { desc: DISP.desc, pagina: PAGINA, usuario: b.u || usuarioActual(), ultimo: Date.now(), h: {} };
        dv[p[0]].h[p[1] + 'r'] = inc(x.r); dv[p[0]].h[p[1] + 'w'] = inc(x.w);
      });
      _interno = true;
      try {
        _db.collection('paConfig').doc('uso_' + dia).set(
          { tipo: 'uso', fecha: dia, r: inc(b.r), w: inc(b.w), k: k, disp: dv, actualizado: Date.now() }, { merge: true }
        ).then(function () { guardarLocal(); }, function () {
          var x = _pend[dia] || (_pend[dia] = { r: 0, w: 0, k: {} });
          x.r += b.r; x.w += b.w; Object.keys(b.k).forEach(function (c) { x.k[c] = (x.k[c] || 0) + b.k[c]; });
          x.d = x.d || {}; Object.keys(b.d || {}).forEach(function (c) { var y = x.d[c] || (x.d[c] = { r: 0, w: 0 }); y.r += b.d[c].r; y.w += b.d[c].w; });
          guardarLocal();
        });
      } finally { _interno = false; }
    });
    guardarLocal();
  }

  // ── Barra de aviso 50 / 75 / 95 % ─────────────────────────────────
  function mostrarBarra(nivel, pctR, pctW, r, w) {
    var clave = 'uso_barra_' + diaPacifico();
    var visto = 0; try { visto = parseInt(localStorage.getItem(clave) || '0', 10); } catch (e) {}
    if (visto >= nivel) return;
    var el = document.getElementById('usoBarra');
    if (!el) { el = document.createElement('div'); el.id = 'usoBarra'; document.body.appendChild(el); }
    var color = nivel >= 95 ? '#b91c1c' : nivel >= 75 ? '#c2410c' : '#b45309';
    el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99998;background:' + color + ';color:#fff;padding:9px 14px;font:600 13px system-ui,sans-serif;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;box-shadow:0 2px 10px rgba(0,0,0,.35)';
    el.innerHTML = '<span>⚠ Cuota de Firestore al ' + Math.max(pctR, pctW) + '% hoy — lecturas ' + r.toLocaleString('es-SV') + ' / ' + LIM_R.toLocaleString('es-SV')
      + ' (' + pctR + '%) · escrituras ' + w.toLocaleString('es-SV') + ' / ' + LIM_W.toLocaleString('es-SV') + ' (' + pctW + '%)'
      + (nivel >= 95 ? ' — LÍMITE INMINENTE: se cortará el guardado' : '') + '</span>'
      + '<a href="uso-firestore.html" target="_blank" style="color:#fff;text-decoration:underline">Ver qué lo consume</a>'
      + '<button id="usoBarraX" style="background:#fff;color:' + color + ';border:0;border-radius:6px;padding:4px 10px;font-weight:700;cursor:pointer">Cerrar</button>';
    document.getElementById('usoBarraX').onclick = function () { try { localStorage.setItem(clave, String(nivel)); } catch (e) {} el.remove(); };
    try { if (window.Notification && Notification.permission === 'granted') new Notification('Firestore al ' + Math.max(pctR, pctW) + '% de la cuota diaria'); } catch (e) {}
  }
  function verificar() {
    if (!_db) return;
    _interno = true;
    try {
      _db.collection('paConfig').doc('uso_' + diaPacifico()).get().then(function (d) {
        if (!d.exists) return;
        var x = d.data() || {}, r = x.r || 0, w = x.w || 0;
        var pr = Math.round(r * 100 / LIM_R), pw = Math.round(w * 100 / LIM_W), p = Math.max(pr, pw);
        var nivel = p >= 95 ? 95 : p >= 75 ? 75 : p >= 50 ? 50 : 0;
        if (nivel) mostrarBarra(nivel, pr, pw, r, w);
      }).catch(function () {});
    } finally { _interno = false; }
  }
  function esAdmin() { try { return typeof window.UsoMonitorEsAdmin === 'function' && !!window.UsoMonitorEsAdmin(); } catch (e) { return false; } }

  setInterval(function () { flush(false); }, 60 * 1000);
  setInterval(function () { if (esAdmin()) verificar(); }, 10 * 60 * 1000);
  setTimeout(function () { if (esAdmin()) verificar(); }, 25000);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { guardarLocal(); if (Date.now() - _ultFlush > 5 * 60 * 1000) flush(true); }
  });
  window.addEventListener('pagehide', guardarLocal);
  // lo que quedó de una sesión anterior se sube al poco de abrir
  setTimeout(function () { if (Object.keys(_pend).length) flush(true); }, 20000);

  window.UsoMonitor = { dispositivo: DISP, flush: function () { flush(true); }, verificar: verificar, limites: { lecturas: LIM_R, escrituras: LIM_W }, _pend: function () { return _pend; } };
})();
