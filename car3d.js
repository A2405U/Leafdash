'use strict';
/* =====================================================================
   Generic 3D hatchback, drawn with the same camera as the road so its
   proportions and perspective always match. Original design, not based
   on any real model. Units are metres: X across (right +), Y up,
   z forward from the rear bumper.
   ===================================================================== */

/* Body loft: cross-sections from rear (z=0) to front (z=4.4). */
const CAR_Z  = [0,    0.08, 0.22, 0.45, 0.75, 1.20, 2.00, 2.65, 3.05, 3.45, 3.85, 4.20, 4.40];
const CAR_W  = [0.80, 0.86, 0.89, 0.90, 0.90, 0.90, 0.90, 0.90, 0.90, 0.89, 0.87, 0.83, 0.75]; // half width
const CAR_GC = [0.34, 0.28, 0.24, 0.22, 0.22, 0.22, 0.22, 0.22, 0.22, 0.22, 0.24, 0.28, 0.32]; // underside
const CAR_HB = [0.90, 0.95, 0.98, 0.99, 1.00, 1.00, 1.00, 1.00, 0.99, 0.96, 0.89, 0.81, 0.72]; // shoulder
const CAR_HC = [0.90, 0.95, 1.12, 1.36, 1.50, 1.54, 1.55, 1.50, 1.28, 0.96, 0.89, 0.81, 0.72]; // roof
const CAR_WC = [0.70, 0.70, 0.68, 0.66, 0.65, 0.65, 0.65, 0.65, 0.68, 0.75, 0.75, 0.75, 0.70]; // roof half width

const CAR_LEN = 4.4;
let CAR_MODEL = null;

function ring(i) {
  const w = CAR_W[i], gc = CAR_GC[i], hb = CAR_HB[i], hc = Math.max(CAR_HC[i], hb), wc = Math.min(CAR_WC[i], w - 0.04);
  const r = [
    [-w * 0.88, gc], [-w, gc + 0.15], [-w, hb - 0.1], [-(w - 0.03), hb],
    [-wc, hc - 0.05], [-(wc - 0.08), hc], [wc - 0.08, hc], [wc, hc - 0.05],
    [w - 0.03, hb], [w, hb - 0.1], [w, gc + 0.15], [w * 0.88, gc],
  ];
  return r.map(([X, Y]) => [X, Y, CAR_Z[i]]);
}

function buildCar() {
  const faces = [];
  const rings = CAR_Z.map((_, i) => ring(i));
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i], b = rings[i + 1];
    const zm = (CAR_Z[i] + CAR_Z[i + 1]) / 2;
    const cabin = Math.max(CAR_HC[i], CAR_HC[i + 1]) - Math.max(CAR_HB[i], CAR_HB[i + 1]) > 0.06;
    for (let j = 0; j < a.length - 1; j++) {           // last edge is the underside: never visible
      let kind = 'body';
      if (cabin && (j === 3 || j === 7)) kind = zm > 0.55 && zm < 2.7 ? 'glass' : 'body';       // side windows / pillars
      if (cabin && j >= 4 && j <= 6) kind = (zm > 0.08 && zm < 0.75) || zm > 2.65 ? 'glass' : 'roof';  // rear glass / windscreen / roof
      faces.push({ pts: [a[j], a[j + 1], b[j + 1], b[j]], kind, ref: [0, 0.75, zm] });
    }
  }
  // rear face (the panel you mostly see)
  faces.push({ pts: rings[0].slice().reverse(), kind: 'body', normal: [0, 0, -1] });

  // wheels: octagonal prisms
  const wheel = (X, zc) => {
    const r = 0.32, n = 10, x1 = Math.sign(X) * 0.66, x2 = Math.sign(X) * 0.9;
    const pt = (x, t) => [x, r + r * Math.sin(t), zc + r * Math.cos(t)];
    const out = [];
    for (let i = 0; i < n; i++) {
      const t1 = (i / n) * Math.PI * 2, t2 = ((i + 1) / n) * Math.PI * 2;
      out.push({ pts: [pt(x1, t1), pt(x2, t1), pt(x2, t2), pt(x1, t2)], kind: 'tyre', ref: [X, r, zc] });
    }
    out.push({ pts: Array.from({ length: n }, (_, i) => pt(x2, (i / n) * Math.PI * 2)), kind: 'rim', normal: [Math.sign(X), 0, 0] });
    return out;
  };
  const wheels = [...wheel(-1, 0.78), ...wheel(1, 0.78), ...wheel(-1, 3.38), ...wheel(1, 3.38)];

  // mirrors
  const box = (x1, x2, y1, y2, z1, z2, kind) => {
    const c = [(x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2];
    const P = (x, y, z) => [x, y, z];
    return [
      [P(x1, y1, z1), P(x2, y1, z1), P(x2, y2, z1), P(x1, y2, z1)],
      [P(x1, y1, z2), P(x1, y2, z2), P(x2, y2, z2), P(x2, y1, z2)],
      [P(x1, y2, z1), P(x2, y2, z1), P(x2, y2, z2), P(x1, y2, z2)],
      [P(x2, y1, z1), P(x2, y1, z2), P(x2, y2, z2), P(x2, y2, z1)],
      [P(x1, y1, z1), P(x1, y2, z1), P(x1, y2, z2), P(x1, y1, z2)],
    ].map(pts => ({ pts, kind, ref: c }));
  };
  const mirrors = [...box(0.86, 1.02, 0.98, 1.1, 2.56, 2.72, 'trim'), ...box(-1.02, -0.86, 0.98, 1.1, 2.56, 2.72, 'trim')];

  // rear decals, drawn flat on the rear face (z slightly behind it)
  const dz = -0.004;
  const rect = (x1, x2, y1, y2, kind) => ({ pts: [[x1, y1, dz], [x2, y1, dz], [x2, y2, dz], [x1, y2, dz]], kind, decal: true, normal: [0, 0, -1] });
  const decals = [
    rect(-0.62, 0.62, 0.34, 0.45, 'diffuser'),
    rect(-0.27, 0.27, 0.52, 0.63, 'plate'),
    rect(-0.76, 0.76, 0.795, 0.835, 'lightbar'),
    rect(-0.77, -0.48, 0.77, 0.86, 'lamp'),
    rect(0.48, 0.77, 0.77, 0.86, 'lamp'),
    rect(-0.75, -0.63, 0.40, 0.43, 'reflector'),
    rect(0.63, 0.75, 0.40, 0.43, 'reflector'),
    rect(-0.74, 0.74, 0.695, 0.702, 'crease'),
    rect(-0.40, -0.27, 0.365, 0.425, 'reverse'),        // reverse lamps, low in the diffuser
    rect(0.27, 0.40, 0.365, 0.425, 'reverse'),
    rect(-0.78, -0.58, 0.765, 0.865, 'indL'),           // indicator segment at the outer end of each tail lamp
    rect(0.58, 0.78, 0.765, 0.865, 'indR'),
  ];
  // high-level brake light at the top of the rear window
  decals.push({ pts: [[-0.22, 1.505, 0.74], [0.22, 1.505, 0.74], [0.22, 1.48, 0.70], [-0.22, 1.48, 0.70]], kind: 'brake3', decal: true, normal: [0, 0.75, -1] });
  // indicator repeaters on the back of the mirrors
  for (const s of [-1, 1]) decals.push({ pts: [[s * 0.9, 1.0, 2.555], [s * 1.01, 1.0, 2.555], [s * 1.01, 1.035, 2.555], [s * 0.9, 1.035, 2.555]], kind: s < 0 ? 'indL' : 'indR', decal: true, normal: [0, 0, -1], mirror: true });
  // lamps wrapping onto the sides
  for (const s of [-1, 1]) decals.push({ pts: [[s * 0.805, 0.86, 0.01], [s * 0.875, 0.86, 0.2], [s * 0.875, 0.78, 0.2], [s * 0.805, 0.77, 0.01]], kind: 'lamp', decal: true, normal: [s, 0, -0.35] });

  // precompute normals
  const all = [...wheels, ...faces, ...mirrors];
  for (const f of all.concat(decals)) {
    if (!f.normal) {
      const [p0, p1, p2] = f.pts;
      let n = norm(cross(sub(p1, p0), sub(p2, p0)));
      const c = centroid(f.pts);
      if (dot(n, sub(c, f.ref)) < 0) n = n.map(v => -v);
      f.normal = n;
    } else f.normal = norm(f.normal);
    f.c = centroid(f.pts);
  }
  return { solid: all, decals };
}

/* ---------------- tiny vector helpers ---------------- */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = a => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
const centroid = pts => pts.reduce((s, p) => [s[0] + p[0] / pts.length, s[1] + p[1] / pts.length, s[2] + p[2] / pts.length], [0, 0, 0]);
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16));
const rgb = (c, a = 1) => `rgba(${c.map(v => Math.round(clamp(v, 0, 255))).join(',')},${a})`;

/* ---------------- drawing ---------------- */
/**
 * cam: { cx, y0, k, s, zr }  (zr = distance to the rear bumper)
 * opt: { colour, P (warp 0..1), lights: { low, high, tail, brake, reverse, indL, indR } }
 */
function drawCar3D(g, cam, opt) {
  if (!CAR_MODEL) CAR_MODEL = buildCar();
  const { cx, y0, k, s, zr } = cam;
  const h = 1 / s;                                         // camera height implied by the road projection
  const camPos = [0, h, -zr];                              // camera in car-local coordinates
  const proj = ([X, Y, z]) => { const Z = zr + z; return [cx + X * s * k / Z, y0 + k * (1 - Y * s) / Z]; };
  const path = pts => { g.beginPath(); pts.forEach((p, i) => { const [x, y] = proj(p); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); };

  const base = hexRgb(opt.colour || '#e6e8eb');
  const L = norm([0.35, 1, -0.45]);
  const P = opt.P || 0;

  // ground shadow
  g.save();
  g.filter = 'blur(7px)';
  g.fillStyle = 'rgba(0,0,0,.55)';
  path([[-1.0, 0, 0.12], [1.0, 0, 0.12], [0.98, 0, CAR_LEN - 0.1], [-0.98, 0, CAR_LEN - 0.1]]);
  g.fill();
  g.restore();

  const Lt = opt.lights || { tail: true };
  const blinkOn = Math.floor(performance.now() / 380) % 2 === 0;          // ~1.3 Hz flash
  const indL = Lt.indL && blinkOn, indR = Lt.indR && blinkOn;
  // tail-lamp brightness: off / tail / brake
  const tail = Lt.brake ? 1 : Lt.tail ? 0.55 + P * 0.35 : 0;

  // light pools on the road (soft ellipses)
  const pool = (X, z, rM, rgba, squash = 0.22) => {
    const [px, py] = proj([X, 0, z]);
    const pr = rM * s * k / Math.max(0.3, zr + z);
    const gr = g.createRadialGradient(px, py, 0, px, py, pr);
    gr.addColorStop(0, rgba); gr.addColorStop(1, rgba.replace(/[\d.]+\)$/, '0)'));
    g.save(); g.translate(px, py); g.scale(1, squash); g.translate(-px, -py);
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = gr; g.fillRect(px - pr, py - pr, pr * 2, pr * 2);
    g.restore();
  };
  if (tail > 0) pool(0, 0.05, Lt.brake ? 1.3 : 0.9, `rgba(255,40,60,${(Lt.brake ? 0.45 : 0.3) * tail})`);
  if (Lt.reverse) pool(0, -0.35, 1.25, 'rgba(235,240,255,.38)', 0.26);
  if (indL) { pool(-1.0, 0.1, 0.9, 'rgba(255,160,20,.6)'); pool(-1.0, CAR_LEN, 1.1, 'rgba(255,160,20,.45)'); }
  if (indR) { pool(1.0, 0.1, 0.9, 'rgba(255,160,20,.6)'); pool(1.0, CAR_LEN, 1.1, 'rgba(255,160,20,.45)'); }

  // headlight beams on the road ahead (UK dipped beam leans to the left kerb)
  const beam = (pts, zNear, zFar, a) => {
    const [, yN] = proj([0, 0, zNear]), [, yF] = proj([0, 0, zFar]);
    const gr = g.createLinearGradient(0, yN, 0, yF);
    gr.addColorStop(0, `rgba(255,244,220,${a})`); gr.addColorStop(0.6, `rgba(255,244,220,${a * 0.45})`); gr.addColorStop(1, 'rgba(255,244,220,0)');
    g.save(); g.globalCompositeOperation = 'lighter'; g.filter = 'blur(6px)';
    g.fillStyle = gr; path(pts); g.fill(); g.restore();
  };
  const F = CAR_LEN - 0.1;
  if (Lt.high) beam([[-1.4, 0, F - 0.6], [1.4, 0, F - 0.6], [7.5, 0, F + 7], [8.0, 0, F + 80], [-8.0, 0, F + 80], [-7.5, 0, F + 7]], F - 0.6, F + 80, 0.4);
  if (Lt.low || Lt.high) beam([[-1.4, 0, F - 0.6], [1.4, 0, F - 0.6], [7.0, 0, F + 6], [7.4, 0, F + 24], [-7.4, 0, F + 28], [-7.0, 0, F + 6]], F - 0.6, F + 28, 0.55);

  // visible faces, far to near
  const vis = CAR_MODEL.solid
    .filter(f => dot(f.normal, sub(camPos, f.c)) > 0)
    .map(f => ({ f, d: Math.hypot(...sub(f.c, camPos)) }))
    .sort((a, b) => b.d - a.d);

  // warp: blue rim glow around the silhouette
  if (P > 0.02) {
    g.save();
    g.shadowColor = `rgba(130,170,255,${0.9 * P})`; g.shadowBlur = 28 * P;
    g.fillStyle = 'rgba(20,30,60,1)';
    for (const { f } of vis) { path(f.pts); g.fill(); }
    g.restore();
  }

  for (const { f } of vis) {
    const n = f.normal;
    const diff = Math.max(0, dot(n, L));
    const view = norm(sub(camPos, f.c));
    const spec = Math.pow(Math.max(0, dot(n, norm([L[0] + view[0], L[1] + view[1], L[2] + view[2]]))), 24);
    let c;
    if (f.kind === 'body' || f.kind === 'roof') {
      const amb = f.kind === 'roof' ? 0.5 : 0.42;
      c = base.map(v => v * (amb + 0.7 * diff) + 255 * spec * 0.35);
      if (P) c = c.map((v, i) => v + [10, 20, 60][i] * P * (1 - diff));    // cool tint from the warp sky
    } else if (f.kind === 'glass') {
      const sky = Math.max(0, n[1]);
      c = [6 + 22 * sky, 9 + 28 * sky, 14 + 38 * sky].map(v => v + 255 * spec * 0.12);
    } else if (f.kind === 'tyre') {
      c = [10, 11, 13].map(v => v + 30 * diff);
    } else if (f.kind === 'rim') {
      c = [70, 76, 84].map(v => v * (0.5 + 0.6 * diff));
    } else {               // trim (mirrors) in body colour, slightly darker
      c = base.map(v => v * (0.25 + 0.6 * diff));
    }
    g.fillStyle = rgb(c);
    g.strokeStyle = rgb(c);
    g.lineWidth = 0.7;
    path(f.pts); g.fill(); g.stroke();
  }

  // decals on the rear face
  const rearVisible = dot([0, 0, -1], sub(camPos, [0, 0.6, 0])) > 0;
  for (const f of CAR_MODEL.decals) {
    if (!rearVisible || dot(f.normal, sub(camPos, f.c)) <= 0) continue;
    g.save();
    switch (f.kind) {
      case 'diffuser': g.fillStyle = '#0a0b0d'; break;
      case 'plate': g.fillStyle = '#f2c200'; break;
      case 'reflector': g.fillStyle = '#6e0c15'; break;
      case 'crease': g.fillStyle = 'rgba(0,0,0,.35)'; break;
      case 'lightbar':
        if (!tail) { g.fillStyle = '#3a0c12'; break; }
        g.fillStyle = `rgba(255,40,58,${0.55 + 0.45 * tail})`;
        g.shadowColor = '#ff2236'; g.shadowBlur = 10 + 14 * tail; break;
      case 'lamp':
        if (!tail) { g.fillStyle = '#4a1018'; break; }
        g.fillStyle = tail > 0.9 ? '#ff5a66' : '#ff3346';
        g.shadowColor = '#ff2236'; g.shadowBlur = 8 + 16 * tail; break;
      case 'reverse':
        if (Lt.reverse) { g.fillStyle = '#f4f7ff'; g.shadowColor = '#ffffff'; g.shadowBlur = 16; }
        else g.fillStyle = '#2b2f36';
        break;
      case 'brake3':
        if (!Lt.brake) { g.restore(); continue; }
        g.fillStyle = '#ff4a58'; g.shadowColor = '#ff2236'; g.shadowBlur = 14; break;
      case 'indL': case 'indR': {
        const on = f.kind === 'indL' ? indL : indR;
        if (!on) { if (f.mirror) { g.restore(); continue; } g.restore(); continue; }   // off: tail lamp shows through
        g.fillStyle = '#ffb52e'; g.shadowColor = '#ff9a00'; g.shadowBlur = 26; break;
      }
    }
    path(f.pts); g.fill();
    g.restore();
  }
}

/* Screen footprint of the car (for placing a custom photo instead). */
function carFootprint(cam) {
  const { cx, y0, k, s, zr } = cam;
  const yGround = y0 + k / zr;
  const halfW = 1.0 * s * k / zr;
  return { cx, yGround, width: halfW * 2 };
}
