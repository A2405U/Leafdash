'use strict';
/* =====================================================================
   Drive screen
   ---------------------------------------------------------------------
   Perspective road with lane lines, your car, speed and a few stats.
   With ECO off and hard acceleration it goes into "warp": lines stretch
   into streaks, light trails rush from the horizon, and the camera kicks.

   Speed comes from the car when that's decoded (S.data.speed, km/h).
   Until then it falls back to the phone's GPS.
   ===================================================================== */

/* settings (SET, CAR_COLOURS) live in settings.js */

/* ---------------- the car ----------------
   Drawn in 3D on the road canvas (car3d.js). If you upload a photo,
   it's shown instead, sized and placed to sit in the lane. */
function renderCar() {
  const el = $('car');
  el.innerHTML = SET.carImage ? `<img src="${SET.carImage}" alt="Your car">` : '';
  el.classList.toggle('hidden', !SET.carImage);
}

/* ---------------- speed ---------------- */
const SPD = { mps: null, at: 0, watch: null, last: null };

function startGps() {
  if (SPD.watch != null || !navigator.geolocation) return;
  SPD.watch = navigator.geolocation.watchPosition(p => {
    const now = p.timestamp || Date.now();
    let v = p.coords.speed;
    // Some phones give no speed: work it out from successive fixes
    if ((v == null || Number.isNaN(v)) && SPD.last) {
      const dt = (now - SPD.last.t) / 1000;
      if (dt > 0.5) v = haversine(SPD.last.lat, SPD.last.lon, p.coords.latitude, p.coords.longitude) / dt;
    }
    SPD.last = { t: now, lat: p.coords.latitude, lon: p.coords.longitude };
    const c = p.coords;
    window.LeafDash?.emit('gps', { lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: c.altitude, hdg: c.heading, spd: c.speed, at: now });
    if (v != null && !Number.isNaN(v)) { SPD.mps = Math.max(0, v); SPD.at = Date.now(); }
    osmOnFix(p.coords.latitude, p.coords.longitude, p.coords.heading, v);   // real road shape (if enabled)
  }, e => log('GPS: ' + e.message), { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
}
function haversine(a, b, c, d) {
  const R = 6371e3, r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r;
  const h = Math.sin(x / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(y / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Current speed in m/s and its source, or nulls. */
function currentSpeed() {
  const d = S.data;
  if (d.speed != null) return { mps: d.speed / 3.6, src: S.mode === 'demo' ? 'demo' : 'car' };
  if (SPD.mps != null && Date.now() - SPD.at < 5000) return { mps: SPD.mps, src: 'GPS' };
  return { mps: null, src: null };
}

/* ---------------- road + warp renderer ---------------- */
const DR = { P: 0, dist: 0, last: 0, raf: null, parts: [], spawn: 0 };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* Make the scene fill the space between the power strip and the tabs. */
function fitScene() {
  const el = $('drive');
  if (!el || S.view !== 'drive') return;
  const top = el.getBoundingClientRect().top + window.scrollY;
  const tabs = document.querySelector('.tabs');
  const rail = getComputedStyle(tabs).flexDirection === 'column';
  // bottom bar (phone) or floating pill (tablet): stop above it; side rail: use the full height
  const bottomLimit = rail ? window.innerHeight : tabs.getBoundingClientRect().top + window.scrollY;
  const minH = window.innerHeight < 520 ? 220 : 380;
  el.style.height = Math.max(minH, bottomLimit - top - 12) + 'px';
}
window.addEventListener('resize', fitScene);

function startDrive() {
  fitScene();
  if (DR.raf) return;
  DR.last = 0;
  DR.raf = requestAnimationFrame(driveFrame);
}

function driveFrame(ts) {
  DR.raf = null;
  if (S.view !== 'drive' || document.hidden) return;
  const dt = DR.last ? Math.min(0.05, (ts - DR.last) / 1000) : 0;
  DR.last = ts;

  const cv = $('road'), dpr = Math.min(devicePixelRatio || 1, 2);
  const W = cv.clientWidth, H = cv.clientHeight;
  if (!W || !H) { DR.raf = requestAnimationFrame(driveFrame); return; }
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);

  const d = S.data, kw = d.kw ?? 0;
  const sp = currentSpeed(), mps = sp.mps ?? 0;

  // charging: swap the road for the side view with the battery filling up
  chargeTick(d);
  $('drive').classList.toggle('charging', CH.active);
  if (CH.active) {
    drawChargeScene(g, W, H, d, ts);
    DR.raf = requestAnimationFrame(driveFrame);
    return;
  }

  // --- warp intensity: ECO off + hard acceleration ---
  let target = 0;
  if (SET.warp === 'always' || (SET.warp === 'auto' && !d.eco)) target = clamp((kw - 25) / 45, 0, 1);
  DR.P += (target - DR.P) * Math.min(1, dt * (target > DR.P ? 2.5 : 1.2));
  const P = DR.P < 0.002 ? 0 : DR.P;

  // distance travelled drives the lane-line scroll (trip miles are counted in history.js, on every tab)
  DR.dist += mps * dt * (1 + P * 2.5);
  DR.travel = (DR.travel || 0) + mps * dt;
  osmAdvance(mps, dt);

  // --- camera ---
  const shx = P ? (Math.random() - 0.5) * P * 3 : 0, shy = P ? (Math.random() - 0.5) * P * 2 : 0;
  const cx = W / 2 + shx;
  const y0 = H * (0.3 - P * 0.035) + shy;           // horizon
  const zn = 2, zoom = 1 + P * 0.08;
  const k = (H - y0) * zn;
  const CAM_H = 3.0;                                 // chase-camera height in metres
  const s = zoom / CAM_H;
  const sy = z => y0 + k / z;
  const sx = (X, z) => cx + X * s * k / z;
  const gp = (X, z) => [sx(X, z), sy(z)];
  const gh = (X, z, Y) => [sx(X, z), y0 + k * (1 - Y * s) / z];     // Y metres above the ground
  // where the car sits (~40% of the screen width, never behind the info chips)
  let zr = (1.8 * s * k) / Math.min(0.4 * W, 0.42 * H);
  zr = Math.max(zr, k / Math.max(40, (H - 88) - y0));
  // real road from OpenStreetMap, when enabled and matched
  const OG = osmActive() ? osmGeometry(zr + 2.2) : null;

  // --- sky ---
  const sky = g.createLinearGradient(0, 0, 0, y0 + 20);
  sky.addColorStop(0, '#05070a');
  sky.addColorStop(1, P ? mix('#0b1018', '#1a1240', P) : '#0b1018');
  g.fillStyle = sky; g.fillRect(0, 0, W, H);
  if (P) {
    const glow = g.createRadialGradient(cx, y0, 0, cx, y0, W * 0.9);
    glow.addColorStop(0, `rgba(140,170,255,${0.55 * P})`);
    glow.addColorStop(0.25, `rgba(110,70,255,${0.22 * P})`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = glow; g.fillRect(0, 0, W, H);
  }

  // --- road surface ---
  // With no map data the road is an ordinary two-lane road (one lane each way), driving on the left:
  // kerb just to the car's left, centre line to its right, the oncoming lane beyond that.
  const LW = 3.1, KL = -LW / 2, KR = LW * 1.5;
  const zf = 220;
  if (OG) osmDrawSurface(g, gp, OG);
  else {
  g.beginPath();
  g.moveTo(sx(KL - 0.6, zn * 0.55), sy(zn * 0.55)); g.lineTo(sx(KR + 0.6, zn * 0.55), sy(zn * 0.55));
  g.lineTo(sx(KR + 0.6, zf), sy(zf)); g.lineTo(sx(KL - 0.6, zf), sy(zf)); g.closePath();
  const rd = g.createLinearGradient(0, y0, 0, H);
  rd.addColorStop(0, 'rgba(18,24,32,0)'); rd.addColorStop(0.15, '#111821'); rd.addColorStop(1, '#151d27');
  g.fillStyle = rd; g.fill();
  }

  // --- warp light trails (behind the lane lines) ---
  if (P) {
    DR.spawn += dt * P * 260;
    while (DR.spawn >= 1 && DR.parts.length < 420) {
      DR.spawn--;
      const a = Math.random() * Math.PI * 2;
      DR.parts.push({ a, r: 4 + Math.random() * 30, hue: [210, 190, 265, 0][Math.floor(Math.random() * 4)] });
    }
  }
  const maxR = Math.hypot(W, H);
  g.lineCap = 'round';
  DR.parts = DR.parts.filter(p => {
    p.r *= 1 + dt * (1.6 + P * 4.5);
    if (p.r > maxR || (!P && Math.random() < dt * 3)) return false;
    const len = p.r * (0.12 + P * 0.5);
    const ca = Math.cos(p.a), sa = Math.sin(p.a);
    const alpha = clamp(p.r / (W * 0.25), 0, 1) * Math.max(P, 0.15);
    g.strokeStyle = p.hue ? `hsla(${p.hue},100%,80%,${alpha})` : `rgba(255,255,255,${alpha})`;
    g.lineWidth = 0.6 + (p.r / maxR) * 3;
    g.beginPath();
    g.moveTo(cx + ca * p.r, y0 + sa * p.r * 0.75);
    g.lineTo(cx + ca * (p.r + len), y0 + sa * (p.r + len) * 0.75);
    g.stroke();
    return true;
  });

  // --- lane lines ---
  const quad = (X, z1, z2, w, a) => {
    z1 = Math.max(z1, zn * 0.5);
    if (z2 <= z1) return;
    g.globalAlpha = a;
    g.beginPath();
    g.moveTo(sx(X - w / 2, z1), sy(z1)); g.lineTo(sx(X + w / 2, z1), sy(z1));
    g.lineTo(sx(X + w / 2, z2), sy(z2)); g.lineTo(sx(X - w / 2, z2), sy(z2));
    g.closePath(); g.fill();
  };
  const fade = z => clamp(1 - z / 140, 0, 1);

  g.fillStyle = P ? mix('#ffffff', '#9fdcff', P) : '#e8eef5';
  g.shadowColor = '#7fc8ff'; g.shadowBlur = P * 14;
  const period = 10.5, dash = Math.min(period - 0.4, 4.5 * (1 + P * 5));
  const scenery = SET.scenery !== false && typeof sceneryDraw === 'function';
  if (OG) {
    osmDrawLines(g, gp, OG, DR.travel - OSM.sCar, dash, fade);
    if (scenery) sceneryDraw(g, gh, sceneryReal(OG), { fade, P });
    osmDrawFeats(g, gh, OG, fade);
  }
  else {
  // solid road edges (outer)
  for (let z = zn * 0.5; z < 150; z += 4) { quad(KL, z, z + 4.2, 0.12, 0.28 * fade(z)); quad(KR, z, z + 4.2, 0.12, 0.24 * fade(z)); }
  // dashed centre line to the car's right, stretching into streaks in warp
  const off = DR.dist % period;
  for (let i = 0; i < 18; i++) {
    const z1 = zn * 0.5 + i * period - off;
    quad(LW / 2, z1, z1 + dash, 0.14, 0.9 * fade(z1));
  }
  g.shadowBlur = 0; g.globalAlpha = 1;
  if (scenery) sceneryDraw(g, gh, sceneryStraight(zr, KL, KR), { fade, P });
  }
  g.shadowBlur = 0; g.globalAlpha = 1;

  // --- car: sits in the lane just above the info chips ---
  const cam = { cx, y0, k, s, zr };
  const braking = kw < -5;
  if (SET.carImage) {
    const fp = carFootprint(cam), car = $('car');
    car.style.width = fp.width * 1.12 + 'px';
    car.style.left = fp.cx + 'px';
    car.style.bottom = (H - fp.yGround - 4) + 'px';
    car.style.filter = P ? `drop-shadow(0 0 ${P * 22}px rgba(130,170,255,${P * 0.55}))` : 'drop-shadow(0 10px 12px rgba(0,0,0,.6))';
  } else if (carImgReady('rear')) {
    drawCarImg(g, cam, { P, lights: carLights(d) });
  } else {
    drawCar3D(g, cam, { colour: SET.carColour, P, lights: carLights(d) });
  }
  // --- vignette in warp ---
  if (P) {
    const v = g.createRadialGradient(cx, H * 0.55, W * 0.35, cx, H * 0.55, maxR * 0.7);
    v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, `rgba(0,0,0,${0.55 * P})`);
    g.fillStyle = v; g.fillRect(0, 0, W, H);
  }

  $('drive').classList.toggle('warp', P > 0.05);

  DR.raf = requestAnimationFrame(driveFrame);
}

function mix(a, b, t) {
  const p = h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16));
  const A = p(a), B = p(b);
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

/* ---------------- overlay text (speed + info) ---------------- */
function renderDriveInfo() {
  const d = S.data, sp = currentSpeed();
  const mph = SET.units === 'mph';
  $('spd').textContent = sp.mps == null ? '--' : Math.round(sp.mps * (mph ? 2.23694 : 3.6));
  $('spdUnit').textContent = mph ? 'mph' : 'km/h';
  $('spdSrc').textContent = sp.src ? (sp.src === 'GPS' ? 'GPS speed' : sp.src === 'demo' ? 'demo' : '') : 'no speed yet';

  // bottom chips: any four metrics, chosen in Settings → Drive screen
  document.querySelectorAll('.drive-info > div').forEach((el, i) => {
    const f = fmtMetric(SET.chips[i] || 'soc');
    el.querySelector('b').textContent = f.v;
    el.querySelector('span').textContent = f.short && f.short !== f.label ? f.short : f.u;
  });

  // side panel (wide screens only)
  if (getComputedStyle(document.querySelector('.drive-side')).display !== 'none') {
    const cells = (d.cells || []).filter(x => x != null);
    $('dsSoc').textContent = d.soc == null ? '--' : d.soc.toFixed(1);
    $('dsSoh').textContent = `SOH ${d.soh == null ? '--' : d.soh.toFixed(1)}%`;
    $('dsVolt').textContent = d.voltage == null ? '--' : d.voltage.toFixed(0);
    $('dsAmps').textContent = `${d.current == null ? '--' : d.current.toFixed(0)} A`;
    $('dsSpread').textContent = cells.length ? Math.max(...cells) - Math.min(...cells) : '--';
    $('dsCells').textContent = cells.length ? `${Math.min(...cells)} – ${Math.max(...cells)} mV` : '\u00a0';
    $('dsUsed').textContent = T.used.toFixed(2);
    $('dsRegen').textContent = `${T.regen.toFixed(2)} kWh regen`;
    $('dsAux').textContent = d.aux == null ? '--' : d.aux.toFixed(1);
    $('ds12A').textContent = d.aux12A == null ? '\u00a0' : `${d.aux12A.toFixed(2)} A`;
    $('dsAmb').textContent = d.ambient == null ? '--' : d.ambient.toFixed(0);
    $('dsGom').textContent = `dash range ${d.gomKm == null ? '--' : Math.round(SET.units === 'mph' ? d.gomKm * 0.621371 : d.gomKm)} ${SET.units === 'mph' ? 'mi' : 'km'}`;
  }

  const gb = $('gearBig');
  gb.textContent = d.gear || '';
  gb.className = 'gear-big' + (d.gear ? ' on' : '') + (d.gear === 'R' ? ' rev' : '');

  $('epedalTag').classList.toggle('on', !!d.ePedal);
  const tag = $('driveTag');
  const warp = DR.P > 0.05;
  tag.textContent = d.eco ? 'ECO' : warp ? 'WARP' : '';
  tag.className = 'drive-tag ' + (d.eco ? 'eco' : warp ? 'warp' : '');
}
setInterval(() => { if (S.view === 'drive') renderDriveInfo(); }, 250);

/* ---------------- wiring ---------------- */
renderCar();
$('btnDriveSettings').addEventListener('click', () => openSettings('drive'));
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => { if (b.dataset.view === 'drive') startDrive(); }));
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.view === 'drive') startDrive(); });
// GPS starts once there's something to drive with (connected or demo)
setInterval(() => { if (S.mode === 'on' || (SET.realRoad && !OSM.fixture)) startGps(); }, 2000);
if (S.view === 'drive') startDrive();
