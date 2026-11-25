'use strict';
/* =====================================================================
   Charging screen
   ---------------------------------------------------------------------
   When the car is charging, the Drive screen shows a side view of the
   same car (drawn from the car3d.js profile) with the battery pack
   visible through the body, filling up to the current charge level.
   ===================================================================== */

const CH = { active: false, since: 0, addedKwh: 0, lastT: 0, socHist: [], startSoc: null };

/** Is the car charging right now? */
function isCharging(d) {
  if (d.demoCharging) return true;
  const pIn = -(d.kw ?? 0);
  if (d.chargeMode > 0) return true;
  return d.plug === 2 && pIn > 0.3;
}

/** Track the session: energy added, SoC trend. Called every frame. */
function chargeTick(d) {
  const on = SET.chargeScreen !== false && isCharging(d);
  if (on && !CH.active) Object.assign(CH, { active: true, since: Date.now(), addedKwh: 0, lastT: Date.now(), socHist: [], startSoc: d.soc });
  if (!on && CH.active && Date.now() - CH.lastSeen > 15000) CH.active = false;    // stays up briefly if a reading drops out
  if (on) CH.lastSeen = Date.now();
  if (!CH.active) return;
  const now = Date.now(), dt = (now - CH.lastT) / 3600e3;
  CH.lastT = now;
  const pIn = Math.max(0, -(d.kw ?? 0));
  if (dt > 0 && dt < 0.01) CH.addedKwh += pIn * dt;
  if (d.soc != null && (!CH.socHist.length || now - CH.socHist[CH.socHist.length - 1].t > 20e3)) {
    CH.socHist.push({ t: now, soc: d.soc });
    while (CH.socHist.length && now - CH.socHist[0].t > 20 * 60e3) CH.socHist.shift();
  }
}

/** Charge rate in %/hour: measured SoC trend once there's enough, otherwise from power. */
function chargeRate(d) {
  const pIn = Math.max(0, -(d.kw ?? 0));
  const fromPower = pIn / (SET.usableKwh || 39) * 100;
  const h = CH.socHist;
  if (h.length >= 10) {
    const a = h[0], b = h[h.length - 1], hrs = (b.t - a.t) / 3600e3;
    const trend = (b.soc - a.soc) / hrs;
    if (trend > 0.2) return (trend + fromPower) / 2;
  }
  return fromPower;
}

/** Hours to reach `target` %, with the usual slow-down near the top. */
function hoursTo(target, d) {
  const soc = d.soc ?? 0, r = chargeRate(d);
  if (soc >= target) return 0;
  if (r <= 0.05) return null;
  const rapid = d.chargeMode === 3;
  let h = 0, s = soc;
  while (s < target) {
    const step = Math.min(1, target - s);
    const taper = s > 95 ? 0.55 : s > 80 ? (rapid ? 0.45 : 0.9) : 1;
    h += step / (r * taper); s += step;
  }
  return h;
}
const fmtH = h => h == null ? '—' : h === 0 ? 'done' : h < 1 / 60 ? '<1 min' : h < 1 ? `${Math.round(h * 60)} min` : `${Math.floor(h)}h ${String(Math.round((h % 1) * 60)).padStart(2, '0')}m`;

/** What's most likely holding the charge speed back. */
function chargeLimit(d) {
  const pIn = Math.max(0, -(d.kw ?? 0));
  const temps = (d.temps || []).filter(x => x != null);
  const t = temps.length ? Math.max(...temps) : null;
  const cells = (d.cells || []).filter(Boolean);
  const vmax = cells.length ? Math.max(...cells) : null;
  if ((d.soc ?? 0) >= 95) return 'Nearly full: final top-up runs slowly';
  if (d.chargeMode === 3) {
    if (t != null && t >= 40) return 'Battery temperature (hot), so rapid charging is slowed';
    if (t != null && t <= 8) return 'Battery temperature (cold), so rapid charging is slowed';
    if ((d.soc ?? 0) > 80) return 'High charge level: rapid charging tapers above 80%';
    if (vmax && vmax > 4100) return 'Cell voltage near maximum';
    return 'Rapid charger output';
  }
  if (d.chargeMode === 1 || (pIn > 0 && pIn < 2.9)) return '3-pin charger (about 2.3 kW)';
  if (pIn > 6.0) return "Car's on-board charger (its maximum)";
  if (d.chargeMode === 2 || pIn >= 2.9) return 'Wallbox or supply limit';
  return 'Waiting for charge data';
}

/* ---------------- side view drawing ---------------- */
function drawChargeScene(g, W, H, d, t) {
  if (carImgReady('side')) return drawChargeSceneImg(g, W, H, d, t);
  // background: soft vignette
  const bg = g.createRadialGradient(W / 2, H * 0.42, 10, W / 2, H * 0.42, Math.max(W, H) * 0.8);
  bg.addColorStop(0, '#111a24'); bg.addColorStop(1, '#05070a');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);

  const scale = Math.min(W * 0.78 / CAR_LEN, H * 0.42 / 1.6);
  const cw = CAR_LEN * scale, x0 = (W - cw) / 2 >= W * 0.12 ? (W - cw) / 2 : W - cw - W * 0.05, yG = H * 0.52;   // room in front for the cable
  const X = z => x0 + (CAR_LEN - z) * scale;          // front of the car on the left, rear on the right
  const Y = y => yG - y * scale;

  // floor reflection line
  const fl = g.createLinearGradient(0, yG, 0, yG + 40);
  fl.addColorStop(0, 'rgba(76,195,255,.10)'); fl.addColorStop(1, 'rgba(76,195,255,0)');
  g.fillStyle = fl; g.fillRect(X(CAR_LEN) - 30, yG, CAR_LEN * scale + 60, 40);
  g.fillStyle = 'rgba(0,0,0,.45)';
  g.beginPath(); g.ellipse(W / 2, yG + 2, CAR_LEN * scale * 0.52, 7, 0, 0, Math.PI * 2); g.fill();

  const col = hexRgb(SET.carColour || '#e6e8eb');
  // side profile in metres: x from the front bumper (0) to the rear (4.4), y up from the ground
  const P = x => X(CAR_LEN - x);
  const ck = Math.max(0.7, Math.min(1.8, scale / 65));
  drawCable(g, P(0.16), Y(0.765), P(0), yG, ck, d.chargeMode);        // behind the car
  const mv = (p, x, y) => p.moveTo(P(x), Y(y)), ln = (p, x, y) => p.lineTo(P(x), Y(y));
  const bz = (p, a, b, c, d, e, f) => p.bezierCurveTo(P(a), Y(b), P(c), Y(d), P(e), Y(f));
  const WF = 0.93, WR = 3.63, AR = 0.42, TR = 0.33;     // wheel centres, arch and tyre radius

  const body = new Path2D();
  mv(body, 0.04, 0.36);
  bz(body, -0.01, 0.45, -0.01, 0.60, 0.04, 0.68);          // nose
  bz(body, 0.08, 0.75, 0.20, 0.78, 0.40, 0.80);            // bonnet front
  bz(body, 0.80, 0.85, 1.15, 0.92, 1.40, 0.98);            // bonnet
  bz(body, 1.66, 1.18, 1.90, 1.42, 2.15, 1.51);            // windscreen
  bz(body, 2.60, 1.565, 3.40, 1.565, 3.86, 1.50);          // roof
  bz(body, 4.02, 1.48, 4.10, 1.47, 4.13, 1.42);            // spoiler
  bz(body, 4.22, 1.30, 4.30, 1.15, 4.33, 1.02);            // tailgate
  bz(body, 4.38, 0.90, 4.40, 0.60, 4.36, 0.40);            // rear bumper
  bz(body, 4.34, 0.33, 4.25, 0.30, WR + AR, 0.30);
  body.arc(P(WR), Y(0.30), AR * scale, 0, Math.PI, true); // rear arch (front is on the left, so mirrored)
  bz(body, WR - AR - 0.04, 0.25, WR - AR - 0.1, 0.24, 3.15, 0.24);
  ln(body, 1.42, 0.24);
  bz(body, 1.39, 0.24, WF + AR + 0.02, 0.26, WF + AR, 0.30);
  body.arc(P(WF), Y(0.30), AR * scale, 0, Math.PI, true); // front arch
  bz(body, 0.35, 0.28, 0.15, 0.28, 0.08, 0.30);
  body.closePath();

  // x-ray body
  const bodyG = g.createLinearGradient(0, Y(1.56), 0, Y(0.24));
  bodyG.addColorStop(0, rgb(col, 0.20)); bodyG.addColorStop(0.45, rgb(col, 0.10)); bodyG.addColorStop(1, rgb(col, 0.05));
  g.fillStyle = bodyG; g.fill(body);

  // faint interior: seats and steering wheel
  g.save(); g.clip(body);
  g.strokeStyle = rgb(col, 0.16); g.lineWidth = 1.2;
  const seat = x => { const q = new Path2D(); mv(q, x, 0.55); bz(q, x + 0.05, 0.75, x + 0.14, 1.05, x + 0.20, 1.22); bz(q, x + 0.23, 1.30, x + 0.30, 1.28, x + 0.29, 1.18);
    bz(q, x + 0.26, 0.95, x + 0.22, 0.75, x + 0.20, 0.62); bz(q, x + 0.05, 0.62, x - 0.30, 0.64, x - 0.38, 0.60); ln(q, x - 0.36, 0.52); q.closePath(); g.stroke(q); };
  seat(2.18); seat(3.08);
  g.beginPath(); g.ellipse(P(1.86), Y(1.02), 0.05 * scale, 0.17 * scale, -0.45, 0, Math.PI * 2); g.stroke();
  g.restore();
  // battery pack under the floor, between the axles, 24 modules
  const bx = P(1.36), bw = P(3.24) - P(1.36), by = Y(0.38), bh = Y(0.21) - Y(0.38);
  drawPack(g, bx, by, bw, bh, d, t);

  // panel lines, glass, lights, wheels
  g.save(); g.clip(body);
  const line = (w, a, fn) => { g.strokeStyle = rgb(col, a); g.lineWidth = w; const q = new Path2D(); fn(q); g.stroke(q); };
  line(1, 0.38, q => { mv(q, 1.48, 1.02); bz(q, 1.44, 0.80, 1.40, 0.52, 1.43, 0.24); });                 // front door leading edge
  line(1, 0.38, q => { mv(q, 2.60, 1.06); bz(q, 2.60, 0.80, 2.61, 0.50, 2.62, 0.24); });                 // front / rear door
  line(1, 0.38, q => { mv(q, 3.42, 1.08); bz(q, 3.45, 0.80, 3.30, 0.62, 3.20, 0.26); });                 // rear door trailing edge
  line(1, 0.30, q => { mv(q, 4.12, 1.40); bz(q, 4.20, 1.25, 4.26, 1.10, 4.28, 0.88); bz(q, 4.30, 0.80, 4.32, 0.70, 4.36, 0.62); }); // tailgate cut
  line(1, 0.30, q => { mv(q, 0.42, 0.80); bz(q, 0.55, 0.70, 0.70, 0.66, 0.92, 0.75); });                 // bonnet / wing seam
  line(1.4, 0.45, q => { mv(q, 0.62, 0.86); bz(q, 1.5, 0.91, 3.0, 0.98, 4.16, 1.05); });                 // shoulder crease
  line(1, 0.22, q => { mv(q, 1.50, 0.44); bz(q, 2.2, 0.45, 2.8, 0.46, 3.20, 0.47); });                   // lower crease
  line(2, 0.25, q => { mv(q, 1.40, 0.27); ln(q, 3.17, 0.27); });                                         // sill
  line(1.2, 0.35, q => { mv(q, 0.03, 0.48); bz(q, 0.15, 0.44, 0.30, 0.43, 0.48, 0.44); });               // front bumper
  line(1.2, 0.35, q => { mv(q, 4.38, 0.50); bz(q, 4.30, 0.47, 4.20, 0.46, 4.10, 0.46); });               // rear bumper
  // door handles
  g.fillStyle = rgb(col, 0.45);
  for (const hx of [2.30, 3.13]) { g.beginPath(); g.roundRect(P(hx), Y(0.925), 0.15 * scale, 0.035 * scale, 3); g.fill(); }
  g.restore();

  // side glass with pillars
  const dlo = new Path2D();
  mv(dlo, 1.50, 1.03); bz(dlo, 1.71, 1.20, 1.92, 1.37, 2.16, 1.45); bz(dlo, 2.6, 1.495, 3.3, 1.495, 3.72, 1.44);
  bz(dlo, 3.85, 1.40, 3.92, 1.30, 3.95, 1.21); ln(dlo, 3.80, 1.17); bz(dlo, 3.65, 1.10, 3.55, 1.085, 3.40, 1.08); ln(dlo, 1.50, 1.03); dlo.closePath();
  const gl = g.createLinearGradient(0, Y(1.5), 0, Y(1.03));
  gl.addColorStop(0, 'rgba(110,150,190,.30)'); gl.addColorStop(1, 'rgba(40,60,85,.38)');
  g.fillStyle = gl; g.fill(dlo);
  g.save(); g.clip(dlo);                                     // reflection streak
  g.fillStyle = 'rgba(255,255,255,.07)';
  g.beginPath(); g.moveTo(P(2.0), Y(1.6)); g.lineTo(P(2.35), Y(1.6)); g.lineTo(P(2.0), Y(0.95)); g.lineTo(P(1.75), Y(0.95)); g.fill();
  g.restore();
  g.strokeStyle = rgb(col, 0.55); g.lineWidth = 1.2; g.stroke(dlo);
  g.strokeStyle = 'rgba(8,10,14,.6)'; g.lineCap = 'round';
  g.lineWidth = 0.04 * scale; g.beginPath(); g.moveTo(P(2.59), Y(1.07)); g.lineTo(P(2.56), Y(1.47)); g.stroke();     // B-pillar
  g.lineWidth = 0.055 * scale; g.beginPath(); g.moveTo(P(3.40), Y(1.09)); g.lineTo(P(3.52), Y(1.47)); g.stroke();     // C-pillar
  g.lineCap = 'butt';
  g.strokeStyle = rgb(col, 0.6); g.lineWidth = 1.6;                                                                  // belt trim
  g.beginPath(); g.moveTo(P(1.50), Y(1.03)); g.lineTo(P(3.40), Y(1.08)); g.stroke();
  // mirror
  const mir = new Path2D(); mv(mir, 1.50, 1.03); bz(mir, 1.52, 1.12, 1.64, 1.15, 1.74, 1.12); bz(mir, 1.77, 1.08, 1.74, 1.03, 1.66, 1.02); mir.closePath();
  g.fillStyle = rgb(col, 0.35); g.fill(mir); g.strokeStyle = rgb(col, 0.7); g.lineWidth = 1; g.stroke(mir);

  // headlight and tail light
  g.save(); g.clip(body);
  const hl = new Path2D(); mv(hl, 0.05, 0.69); bz(hl, 0.22, 0.745, 0.42, 0.78, 0.60, 0.80); ln(hl, 0.62, 0.775); bz(hl, 0.46, 0.72, 0.26, 0.66, 0.07, 0.62); hl.closePath();
  const hg = g.createLinearGradient(P(0.06), 0, P(0.7), 0);
  hg.addColorStop(0, 'rgba(230,245,255,.9)'); hg.addColorStop(1, 'rgba(120,190,255,.45)');
  g.save(); g.shadowColor = 'rgba(160,215,255,.8)'; g.shadowBlur = 10; g.fillStyle = hg; g.fill(hl); g.restore();
  g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1; g.beginPath(); mv(g, 0.09, 0.66); bz(g, 0.26, 0.71, 0.44, 0.75, 0.60, 0.785); g.stroke(); // DRL
  g.restore();
  const tl = new Path2D(); mv(tl, 4.33, 1.03); bz(tl, 4.25, 1.07, 4.12, 1.10, 4.03, 1.11); ln(tl, 4.02, 1.05); bz(tl, 4.14, 1.02, 4.26, 0.98, 4.35, 0.93); tl.closePath();
  g.save(); g.shadowColor = 'rgba(255,40,60,.7)'; g.shadowBlur = 8; g.fillStyle = 'rgba(220,30,50,.75)'; g.fill(tl); g.restore();
  g.fillStyle = 'rgba(255,80,60,.5)'; g.fillRect(P(4.38), Y(0.50), 0.10 * scale, 0.025 * scale);                  // rear reflector

  // wheels
  for (const wx of [WF, WR]) {
    const cx = P(wx), cy = Y(TR), r = TR * scale;
    g.fillStyle = 'rgba(4,5,7,.92)';                                     // arch liner
    g.beginPath(); g.arc(cx, Y(0.30), AR * scale - 1, Math.PI, 0, false); g.arc(cx, cy, r, 0, Math.PI, true); g.fill();
    const ty = g.createRadialGradient(cx, cy, r * 0.7, cx, cy, r);       // tyre
    ty.addColorStop(0, '#1d2025'); ty.addColorStop(0.85, '#0c0d0f'); ty.addColorStop(1, '#050506');
    g.fillStyle = ty; g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
    const rr = r * 0.70;
    g.fillStyle = '#121519'; g.beginPath(); g.arc(cx, cy, rr, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#3a4047'; g.beginPath(); g.arc(cx, cy, rr * 0.72, 0, Math.PI * 2); g.fill();           // brake disc
    g.fillStyle = '#5b636c'; g.beginPath(); g.arc(cx, cy, rr * 0.82, -2.5, -1.7); g.arc(cx, cy, rr * 0.5, -1.7, -2.5, true); g.fill(); // caliper
    const sp = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
    sp.addColorStop(0, '#e9edf1'); sp.addColorStop(0.7, '#b7bec6'); sp.addColorStop(1, '#7d858e');
    g.fillStyle = sp;
    for (let k = 0; k < 5; k++) for (const off of [-0.17, 0.17]) {       // five split spokes
      const a = k * Math.PI * 2 / 5 + off + 0.3, w1 = 0.13, w2 = 0.07;
      g.beginPath();
      g.moveTo(cx + Math.cos(a - w1) * rr * 0.22, cy + Math.sin(a - w1) * rr * 0.22);
      g.lineTo(cx + Math.cos(a - w2) * rr * 0.96, cy + Math.sin(a - w2) * rr * 0.96);
      g.arc(cx, cy, rr * 0.96, a - w2, a + w2);
      g.lineTo(cx + Math.cos(a + w1) * rr * 0.22, cy + Math.sin(a + w1) * rr * 0.22);
      g.closePath(); g.fill();
    }
    g.strokeStyle = '#c9cfd6'; g.lineWidth = Math.max(1.5, rr * 0.06); g.beginPath(); g.arc(cx, cy, rr * 0.98, 0, Math.PI * 2); g.stroke(); // rim lip
    g.fillStyle = '#2a2f35'; g.beginPath(); g.arc(cx, cy, rr * 0.24, 0, Math.PI * 2); g.fill();          // hub
    g.fillStyle = '#9aa2ab'; g.beginPath(); g.arc(cx, cy, rr * 0.11, 0, Math.PI * 2); g.fill();
  }

  // outline last so it sits crisp on top
  g.strokeStyle = rgb(col, 0.85); g.lineWidth = 1.6; g.lineJoin = 'round'; g.stroke(body);
  g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 1;                                            // roof highlight
  g.beginPath(); mv(g, 2.2, 1.50); bz(g, 2.6, 1.545, 3.4, 1.545, 3.82, 1.49); g.stroke();

  // energy flowing from the charge port (in the nose) to the pack
  drawFlap(g, [P(0.22), Y(0.79)], [P(0.15), Y(1.06)], 9 * ck);
  drawFlow(g, [[P(0.16), Y(0.765)], [P(0.55), Y(0.80)], [P(WF), Y(0.78)], [P(1.30), Y(0.70)], [bx + 6, by + bh / 2]], yG, t, { kind: d.chargeMode });
}

function drawPack(g, bx, by, bw, bh, d, t) {
  const soc = Math.max(0, Math.min(100, d.soc ?? 0));
  const fillCol = soc < 15 ? '#ff5d6c' : soc < 30 ? '#ffb84d' : '#3ddc97';
  g.save();
  g.shadowColor = fillCol; g.shadowBlur = 18;
  g.fillStyle = 'rgba(10,20,18,.9)';
  g.beginPath(); g.roundRect(bx, by, bw, bh, 4); g.fill();
  g.restore();
  // charge fills from the front (where the charge port is) towards the back
  const fw = bw * soc / 100;
  const fg = g.createLinearGradient(bx, 0, bx + bw, 0);
  fg.addColorStop(0, fillCol); fg.addColorStop(1, rgb(hexRgb(fillCol), 0.65));
  g.save(); g.beginPath(); g.roundRect(bx, by, bw, bh, 4); g.clip();
  g.fillStyle = fg; g.fillRect(bx, by, fw, bh);
  // moving shimmer on the charging edge
  const edge = bx + fw, sh = (t / 900) % 1;
  const sg = g.createLinearGradient(edge - 40, 0, edge + 6, 0);
  sg.addColorStop(0, 'rgba(255,255,255,0)'); sg.addColorStop(0.8, `rgba(255,255,255,${0.25 + 0.25 * Math.sin(sh * Math.PI * 2)})`); sg.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sg; g.fillRect(edge - 40, by, 46, bh);
  g.restore();
  // module lines
  g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 1;
  for (let m = 1; m < 24; m++) { const xx = bx + bw * m / 24; g.beginPath(); g.moveTo(xx, by + 1); g.lineTo(xx, by + bh - 1); g.stroke(); }
  g.strokeStyle = rgb(hexRgb(fillCol), 0.9); g.lineWidth = 1.4;
  g.beginPath(); g.roundRect(bx, by, bw, bh, 4); g.stroke();

}
/** Energy path from the charge port to the pack: a smooth curve through pts (screen px).
 *  o.noseX: screen x of the front of the car; o.k: size scale; o.kind: chargeMode (1 3-pin, 2 wallbox, 3 rapid). */
function drawFlow(g, pts, yG, t, o = {}) {
  // Catmull-Rom through the points, sampled into a polyline
  const P = [pts[0], ...pts, pts[pts.length - 1]], line = [];
  for (let i = 1; i < P.length - 2; i++) for (let k = 0; k < 16; k++) {
    const u = k / 16, [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const f = j => 0.5 * (2 * p1[j] + (-p0[j] + p2[j]) * u + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * u * u + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * u * u * u);
    line.push([f(0), f(1)]);
  }
  line.push(pts[pts.length - 1]);
  const len = [0]; for (let i = 1; i < line.length; i++) len.push(len[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  const total = len[len.length - 1];
  const at = dist => { let i = 1; while (i < len.length - 1 && len[i] < dist) i++; const r = (dist - len[i - 1]) / ((len[i] - len[i - 1]) || 1);
    return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * r, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * r]; };
  const [portX, portY] = pts[0];
  g.fillStyle = '#4cc3ff'; g.shadowColor = '#4cc3ff'; g.shadowBlur = 12;
  g.beginPath(); g.arc(portX, portY, 4, 0, Math.PI * 2); g.fill();
  g.shadowBlur = 0;
  g.strokeStyle = 'rgba(76,195,255,.35)'; g.lineWidth = 2; g.setLineDash([3, 5]);
  g.beginPath(); line.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.stroke(); g.setLineDash([]);
  const period = { 1: 2600, 2: 1400, 3: 650 }[o.kind] || 1800, dots = o.kind === 3 ? 7 : 5;   // faster charging, faster flow
  for (let k = 0; k < dots; k++) {
    const u = ((t / period) + k / dots) % 1, [qx, qy] = at(u * total);
    g.fillStyle = `rgba(150,220,255,${0.9 - u * 0.5})`;
    g.beginPath(); g.arc(qx, qy, 2.6, 0, Math.PI * 2); g.fill();
  }
}

/** The charge-port lid, open: hinged at the back edge of the port, standing up from the nose and tilted a little
 *  forward. hinge/tip are screen points; t is its thickness. Drawn in the car's own grey outline style. */
function drawFlap(g, hinge, tip, t) {
  const [hx, hy] = hinge, [tx, ty] = tip, L = Math.hypot(tx - hx, ty - hy) || 1, nx = (ty - hy) / L * t, ny = -(tx - hx) / L * t;
  g.save();
  // a slightly rounded panel: its face shows a little at this angle, with a lighter rim along the outer edge
  const grd = g.createLinearGradient(hx, hy, tx, ty);
  grd.addColorStop(0, 'rgba(120,130,142,.92)'); grd.addColorStop(1, 'rgba(165,174,186,.92)');
  g.fillStyle = grd; g.strokeStyle = 'rgba(225,232,240,.85)'; g.lineWidth = 1.1; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(hx, hy); g.lineTo(tx, ty);
  g.quadraticCurveTo(tx + nx * 0.6, ty + ny * 0.6 - t * 0.15, tx + nx, ty + ny);
  g.lineTo(hx + nx, hy + ny); g.closePath(); g.fill(); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.moveTo(hx + nx * 0.5, hy + ny * 0.5); g.lineTo(tx + nx * 0.5, ty + ny * 0.5); g.stroke();
  g.restore();
}

/* The charging cable: out of the port in one smooth curve, easing down past the front of the car to lie flat on the
   ground, then off the left edge, as if to a charger out of view. It's drawn before the car: the port is in the middle
   of the nose, so from the side its end is hidden behind the bodywork. Its thickness and colour show the charger in use:
   a thin grey 3-pin lead, a thicker dark Type 2 wallbox cable, or a heavy black CHAdeMO rapid cable. */
const CABLES = {
  1: { w: 2.6, col: '#8d98a5', edge: '#c3ccd6' },   // 3-pin
  2: { w: 4.6, col: '#262d36', edge: '#5b6672' },   // wallbox / BYOC (Type 2)
  3: { w: 7.5, col: '#121519', edge: '#3d4653' },   // rapid (CHAdeMO)
};
function drawCable(g, px, py, noseX, yG, k, kind) {
  const c = CABLES[kind] || CABLES[2];
  const gx = Math.max(Math.min(noseX, px) * 0.25, Math.min(noseX, px) - 70 * k), gy = yG + 2;   // where it touches the ground
  const span = px - gx;
  const path = () => {
    g.beginPath(); g.moveTo(px, py);
    g.bezierCurveTo(px - span * 0.45, py, gx + span * 0.4, gy, gx, gy);   // level out of the port, level onto the ground: no corners
    g.lineTo(-40, gy);                                                     // along the ground, off screen
  };
  g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
  g.strokeStyle = c.edge; g.lineWidth = (c.w + 1.6) * k; path(); g.stroke();   // a thin rim so a dark cable shows on a dark floor
  g.strokeStyle = c.col; g.lineWidth = c.w * k; path(); g.stroke();
  g.restore();
}

/* ---------------- info overlay ---------------- */
function renderChargeInfo(d) {
  const el = $('chargeInfo');
  if (!el) return;
  const pIn = Math.max(0, -(d.kw ?? 0)), r = chargeRate(d);
  const temps = (d.temps || []).filter(x => x != null);
  const cells = (d.cells || []).filter(Boolean);
  const mode = d.chargeMode === 3 ? 'Rapid charging' : d.chargeMode === 1 ? 'Charging · 3-pin' : d.chargeMode === 2 ? 'Charging · wallbox' : 'Charging';
  const since = CH.since ? fmtH((Date.now() - CH.since) / 3600e3) : '—';
  el.innerHTML = `
    <div class="ch-top">
      <div class="ch-soc">${d.soc == null ? '--' : d.soc.toFixed(1)}<small>%</small></div>
      <div class="ch-mode"><span class="pill regen">${mode}</span><div class="ch-kw">${pIn.toFixed(1)}<small>kW</small></div></div>
    </div>
    <div class="ch-grid">
      <div><b>${fmtH(hoursTo(80, d))}</b><span>to 80%</span></div>
      <div><b>${fmtH(hoursTo(100, d))}</b><span>to 100%</span></div>
      <div><b>+${r.toFixed(1)}</b><span>% per hour</span></div>
      <div><b>${CH.addedKwh.toFixed(2)}</b><span>kWh added · ${since}</span></div>
      <div><b>${temps.length ? Math.round(temps.reduce((a, b) => a + b) / temps.length) : '--'}°C</b><span>battery</span></div>
      <div><b>${cells.length ? Math.max(...cells) - Math.min(...cells) : '--'}<small>mV</small></b><span>cell spread</span></div>
    </div>
    <div class="ch-limit"><span class="label">What's setting the speed</span><b>${chargeLimit(d)}</b></div>`;
}
setInterval(() => { if (CH.active && S.view === 'drive') renderChargeInfo(S.data); }, 1000);
