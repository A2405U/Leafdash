'use strict';
/* =====================================================================
   The car screen (Android Auto) and its link to the phone
   ---------------------------------------------------------------------
   The Android app shows this page twice: on the phone (the full app, which owns the one adapter connection) and
   on the car's screen (index.html?car). The car copy never connects or polls: the phone sends it the car's
   values, its GPS fixes and its mode through the app (NativeBridge.toCar → CarLink → window.__leafFromPhone),
   a few times a second, and the car copy draws the Drive screen from them. Both copies share the phone's map
   data (offline maps and remembered areas), so the car copy draws the road itself.

   Car screen states:
     phone app not open, or no word from it for 4 s → "Open Leaf Dash on your phone"
     phone disconnected / connecting                  → "Connect to the adapter on the phone"
     phone in Demo                                    → the car screen runs its own Demo
     phone live                                       → mirrors the phone
   The car layout (body.car-screen) is made for small, wide screens like 800 × 480: big speed and gear, the
   power reading beside its bar, no widgets, and the tabs behind a ☰ button (Debug never shows on the car).
   ===================================================================== */

const CAR = {
  isCar: new URLSearchParams(location.search).has('car'),
  phoneAt: 0, phoneMode: null, live: false, menu: false,
};

/* ---------------- on the phone: send to the car screen ---------------- */
if (!CAR.isCar && typeof window.LeafNative?.toCar === 'function') {
  const send = m => { try { window.LeafNative.toCar(JSON.stringify(m)); } catch {} };
  const carOn = () => { try { return !!window.LeafNative.carOn(); } catch { return false; } };
  let last = {}, lastFull = 0, lastSent = 0, lastHb = 0;
  const hb = () => {
    lastHb = Date.now();
    try { window.LeafNative.carMode?.(S.mode, SET.carZoom || 'normal'); } catch {}   // the app repeats it if the page is held back
    send({ k: 'hb', mode: S.mode, zoom: SET.carZoom || 'normal' });
  };
  const flush = () => {
    if (!carOn()) { last = {}; return; }
    const now = Date.now(), full = now - lastFull > 5000, d = {};
    lastSent = now;
    for (const [k, v] of Object.entries(S.data)) {
      const j = JSON.stringify(v);                          // the cells too, for the Cells tab (they change every few seconds)
      if (full || last[k] !== j) { d[k] = v; last[k] = j; }
    }
    if (full) lastFull = now;
    if (Object.keys(d).length) send({ k: 'd', mode: S.mode, d });
    if (now - lastHb > 1000) hb();
  };
  // Sent as the data arrives (at most five times a second), not on a timer: timers are held back while the app
  // is in the background, and the car screen would think the phone had gone.
  LeafDash.on('data', () => { if (Date.now() - lastSent >= 200) flush(); });
  LeafDash.on('gps', g => { if (!g.fake && carOn()) send({ k: 'gps', lat: g.lat, lon: g.lon, hdg: g.hdg, spd: g.spd }); });
  LeafDash.on('mode', m => { last = {}; lastFull = 0; try { window.LeafNative.carMode?.(m, SET.carZoom || 'normal'); } catch {} if (carOn()) send({ k: 'mode', mode: m }); });
  setInterval(() => { if (carOn() && Date.now() - lastHb > 900) hb(); }, 1000);   // while nothing is coming in
  try { window.LeafNative.carMode?.(S.mode, SET.carZoom || 'normal'); } catch {}
}

/* ---------------- on the car screen ---------------- */
function carMsg(text) {
  let el = $('carMsg');
  if (!el) { el = document.createElement('div'); el.id = 'carMsg'; el.className = 'car-msg'; document.body.appendChild(el); }
  el.innerHTML = text ? `<div><b>${esc(text[0])}</b><span>${esc(text[1] || '')}</span></div>` : '';
  el.classList.toggle('hidden', !text);
}

function carGoLive() {
  if (CAR.live) return;
  if (S.mode === 'demo' && typeof stopDemo === 'function') stopDemo();
  if (typeof drtStop === 'function') drtStop();
  OSM.fixture = false; OSM.path = null; OSM.ways.clear(); OSM.nodeWays.clear(); OSM.feats.clear(); OSM.O = null; OSM.fetchAt = null;
  S.data = {};
  S.mirror = true;                  // tells the demo route not to start, and the speed it's the car's
  setMode('demo');                  // draws like Demo (nothing polls, nothing is saved), fed by the phone
  CAR.live = true;
  carMsg(null);
}
function carLeaveLive() {
  if (!CAR.live) return;
  CAR.live = false;
  S.mirror = false;
  setMode('off');
}
function carStopDemo() { if (S.mode === 'demo' && !CAR.live) { stopDemo(); setMode('off'); } }

/** The phone's state decides what the car screen shows. */
function carFollow(mode) {
  CAR.phoneMode = mode; CAR.phoneAt = Date.now();
  if (mode === 'on') carGoLive();
  else if (mode === 'demo') { carLeaveLive(); if (S.mode !== 'demo') startDemo(); carMsg(null); }
  else {
    carLeaveLive(); carStopDemo();
    carMsg(mode === 'busy' ? ['Connecting…', 'The phone is connecting to the adapter.'] : ['Not connected', 'Tap Connect adapter in Leaf Dash on your phone.']);
  }
}

window.__leafFromPhone = text => {
  if (!CAR.isCar) return;
  let m; try { m = typeof text === 'string' ? JSON.parse(text) : text; } catch { return; }
  if (m.mode && m.mode !== CAR.phoneMode) carFollow(m.mode);
  if (m.zoom && /^(small|normal|large)$/.test(m.zoom)) SET.carZoom = m.zoom;   // Car screen road size, chosen on the phone
  CAR.phoneAt = Date.now();
  if (m.k === 'd' && CAR.live && m.d) {
    Object.assign(S.data, m.d);
    S.lastUpdate = Date.now();
    render();
    LeafDash.emit('data', S.data);
  } else if (m.k === 'gps' && CAR.live && m.lat != null) {
    if (m.spd != null && !Number.isNaN(m.spd)) { SPD.mps = Math.max(0, m.spd); SPD.at = Date.now(); }
    osmOnFix(m.lat, m.lon, m.hdg ?? null, m.spd ?? null);
  }
};

/** The part of the car screen Android Auto leaves free (insets in CSS pixels), from SurfaceRenderer. */
window.__leafCarArea = (l, t, r, b) => {
  const st = document.body.style;
  st.setProperty('--car-l', `${Math.max(0, l)}px`); st.setProperty('--car-t', `${Math.max(0, t)}px`);
  st.setProperty('--car-r', `${Math.max(0, r)}px`); st.setProperty('--car-b', `${Math.max(0, b)}px`);
  if (typeof fitScene === 'function') setTimeout(fitScene, 50);
};

/** The ☰ menu: the tabs, shown over the left of the screen (from the page's button or Android Auto's). */
window.__leafCarMenu = open => {
  CAR.menu = open == null ? !CAR.menu : !!open;
  document.body.classList.toggle('car-menu', CAR.menu);
};

if (CAR.isCar) {
  document.body.classList.add('car-screen');
  window.LD_RESTORING = true;       // the car copy only shows things: it never saves over the phone's data
  SET.voice = false;                // the phone speaks; two voices would talk over each other
  SPD.watch = -1;                   // no GPS of its own: the phone's fixes come with the data
  const btn = document.createElement('button');
  btn.id = 'carMenuBtn'; btn.className = 'car-menu-btn'; btn.setAttribute('aria-label', 'Menu');
  btn.innerHTML = '<i></i><i></i><i></i>';
  btn.addEventListener('click', () => window.__leafCarMenu());
  document.body.appendChild(btn);
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => { window.__leafCarMenu(false); scrollTo(0, 0); }));
  // ▲ ▼: page through Dash, Energy and Cells (Android Auto passes taps on, but not swipes)
  const pager = document.createElement('div');
  pager.className = 'car-pager hidden';
  pager.innerHTML = '<button data-p="-1" aria-label="Up">▲</button><button data-p="1" aria-label="Down">▼</button>';
  pager.addEventListener('click', e => { const b = e.target.closest('[data-p]'); if (b) scrollBy({ top: +b.dataset.p * innerHeight * 0.6, behavior: 'smooth' }); });
  document.body.appendChild(pager);
  const pagerTick = () => {
    const more = S.view !== 'drive' && document.documentElement.scrollHeight > innerHeight + 4;
    pager.classList.toggle('hidden', !more);
    if (!more) return;
    pager.children[0].disabled = scrollY < 4;
    pager.children[1].disabled = scrollY + innerHeight >= document.documentElement.scrollHeight - 4;
  };
  setInterval(pagerTick, 400); addEventListener('scroll', pagerTick, { passive: true });
  carMsg(['Open Leaf Dash on your phone', 'The car screen shows what the phone app reads from the car.']);
  setInterval(() => {
    if (CAR.phoneMode != null && Date.now() - CAR.phoneAt > 4000) {
      CAR.phoneMode = null; carLeaveLive(); carStopDemo();
      carMsg(['Open Leaf Dash on your phone', 'The car screen shows what the phone app reads from the car.']);
    }
  }, 1000);
}
