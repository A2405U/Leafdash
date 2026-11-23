'use strict';
/* =====================================================================
   Demo route: a made-up stretch of map that the demo drives round, so
   the Drive screen shows bends, junctions, turns, different road types,
   traffic lights and zebra crossings without the car or GPS.

     Elm Road (20 mph, zebra, side road) → right at the lights onto
     High Road A105 (30 mph, S-bends, crossing lights, side road) →
     slip road onto the A40 dual carriageway (70) → off-slip (50) →
     left at the lights onto Station Road B (40, roundabout, tight bend,
     zebra, mini-roundabout) → restart.

   It feeds fake GPS fixes into the real-road code, exactly like the phone
   would, so what you see is how the app handles real roads.
   ===================================================================== */

const DRT = { on: false, timer: null, fixTimer: null, s: 0, v: 0, a: 0, route: null, stopsDone: new Set(), waitUntil: 0 };

function drtBuild() {
  let nid = 1;
  const node = (x, y) => ({ x, y, id: nid++ });
  /** Points every ~10 m from a start state: ['S', metres] straight, ['L'|'R', radius, degrees] arcs. */
  const gen = (start, h, cmds, first = null) => {
    const pts = [first || node(start.x, start.y)];
    let { x, y } = start;
    for (const c of cmds) {
      if (c[0] === 'S') {
        const n = Math.max(1, Math.round(c[1] / 12));
        for (let i = 0; i < n; i++) { x += Math.sin(h) * c[1] / n; y += Math.cos(h) * c[1] / n; pts.push(node(x, y)); }
      } else {
        const r = c[1], ang = c[2] * Math.PI / 180, sgn = c[0] === 'R' ? 1 : -1;
        const n = Math.max(2, Math.round(r * ang / 9));
        for (let i = 0; i < n; i++) {
          const dh = sgn * ang / n, mid = h + dh / 2, chord = 2 * r * Math.sin(ang / n / 2);
          x += Math.sin(mid) * chord; y += Math.cos(mid) * chord; h += dh; pts.push(node(x, y));
        }
      }
    }
    return { pts, end: pts[pts.length - 1], h };
  };
  const ways = [], feats = [];
  const way = (tags, pts) => { ways.push({ id: 7000 + ways.length, tags, pts }); return pts; };
  const at = (pts, i) => pts[Math.min(pts.length - 1, i)];
  const deg = d => d * Math.PI / 180;

  // Elm Road: residential, 20 mph, gentle bends
  const elm = gen({ x: 0, y: 0 }, 0, [['S', 90], ['R', 110, 28], ['S', 60], ['L', 110, 28], ['S', 70]]);
  way({ highway: 'residential', name: 'Elm Road', maxspeed: '20 mph' }, elm.pts);
  feats.push({ kind: 'zebra', p: at(elm.pts, 6) });
  way({ highway: 'residential', name: 'Oak Close', maxspeed: '20 mph' }, gen(at(elm.pts, 14), deg(-80), [['S', 40], ['R', 40, 40], ['S', 40]], at(elm.pts, 14)).pts);
  const N1 = elm.end;
  // High Road A105 at the T-junction: lights; west part is a side branch, we turn right (east)
  feats.push({ kind: 'lights', p: N1 });
  way({ highway: 'primary', name: 'High Road', ref: 'A105', maxspeed: '30 mph' }, gen(N1, deg(-90), [['S', 150]], N1).pts);
  const lon = gen(N1, deg(90), [['S', 110], ['L', 220, 22], ['S', 70], ['R', 200, 44], ['S', 60], ['L', 220, 22], ['S', 140]], N1);
  way({ highway: 'primary', name: 'High Road', ref: 'A105', maxspeed: '30 mph' }, lon.pts);
  feats.push({ kind: 'lights', p: at(lon.pts, 24) });
  way({ highway: 'tertiary', name: 'Church Street', maxspeed: '30 mph' }, gen(at(lon.pts, 17), deg(180), [['S', 50], ['L', 60, 30], ['S', 40]], at(lon.pts, 17)).pts);
  const N2 = lon.end;
  way({ highway: 'primary', name: 'High Road', ref: 'A105', maxspeed: '30 mph' }, gen(N2, lon.h, [['S', 160]], N2).pts);
  // slip road up onto the A40
  const slip = gen(N2, lon.h, [['S', 15], ['L', 70, 75], ['S', 70]], N2);
  way({ highway: 'trunk_link', ref: 'A40', oneway: 'yes', lanes: '1', maxspeed: '40 mph' }, slip.pts);
  const N3 = slip.end;
  // A40 dual carriageway, 2 lanes, national limit; starts a little before the merge
  const back = gen(N3, slip.h + Math.PI, [['S', 140]]);
  const dual = gen(N3, slip.h, [['S', 260], ['R', 650, 28], ['S', 260], ['L', 520, 42], ['S', 240]], N3);
  way({ highway: 'trunk', ref: 'A40', oneway: 'yes', lanes: '2', maxspeed: 'GB:nsl_dual' }, [...back.pts.slice(1).reverse(), ...dual.pts]);
  const N4 = dual.end;
  way({ highway: 'trunk', ref: 'A40', oneway: 'yes', lanes: '2', maxspeed: 'GB:nsl_dual' }, gen(N4, dual.h, [['S', 260]], N4).pts);
  const off = gen(N4, dual.h, [['S', 20], ['L', 90, 55], ['S', 70]], N4);
  way({ highway: 'trunk_link', ref: 'A40', oneway: 'yes', lanes: '1', maxspeed: '50 mph' }, off.pts);
  const N5 = off.end;
  // Station Road B-road at the lights: right is a branch, we turn left
  feats.push({ kind: 'lights', p: N5 });
  way({ highway: 'secondary', name: 'Station Road', ref: 'B450', maxspeed: '40 mph' }, gen(N5, off.h + Math.PI / 2, [['S', 140]], N5).pts);
  const stnTags = { highway: 'secondary', name: 'Station Road', ref: 'B450', maxspeed: '40 mph' };
  const stnA = gen(N5, off.h - Math.PI / 2, [['S', 150]], N5);
  way(stnTags, stnA.pts);
  // a roundabout (clockwise, as in the UK): we come in at the bottom and take the second exit, straight on
  const RB = 15, hS = stnA.h, cen = { x: stnA.end.x + Math.sin(hS) * RB, y: stnA.end.y + Math.cos(hS) * RB };
  const ringPts = [stnA.end];
  for (let i = 1; i < 16; i++) { const a = hS + Math.PI + i * Math.PI / 8; ringPts.push(node(cen.x + Math.sin(a) * RB, cen.y + Math.cos(a) * RB)); }
  way({ highway: 'secondary', junction: 'roundabout', lanes: '1', maxspeed: '40 mph' }, [...ringPts, ringPts[0]]);
  way({ highway: 'tertiary', name: 'Park Avenue', maxspeed: '30 mph' }, gen(ringPts[4], hS - Math.PI / 2, [['S', 30], ['R', 80, 30], ['S', 50]], ringPts[4]).pts);
  way({ highway: 'residential', name: 'Kiln Way', maxspeed: '30 mph' }, gen(ringPts[12], hS + Math.PI / 2, [['S', 90]], ringPts[12]).pts);
  const stn = gen(ringPts[8], hS, [['S', 60], ['R', 160, 32], ['S', 90], ['L', 45, 70], ['S', 130], ['R', 200, 25], ['S', 120]], ringPts[8]);
  way(stnTags, stn.pts);
  feats.push({ kind: 'zebra', p: at(stn.pts, 22) });
  feats.push({ kind: 'mini', p: at(stn.pts, 34) });
  way({ highway: 'residential', name: 'Mill Lane', maxspeed: '30 mph' }, gen(at(stn.pts, 34), stn.h - Math.PI / 2, [['S', 70]], at(stn.pts, 34)).pts);

  // the route we drive, in order
  const legs = [elm.pts, lon.pts, slip.pts, dual.pts, off.pts, stnA.pts, ringPts.slice(0, 9), stn.pts];
  const pts = [];
  for (const L of legs) for (const p of L) if (!pts.length || pts[pts.length - 1].id !== p.id) pts.push(p);
  // the car itself drives a smooth line (≈8 m radius round junction corners), like a real driver
  const drive = smoothLine(pts.map(p => ({ ...p, w: null, dir: 1 })), 6).pts;
  const way0 = p => pts.reduce((best, q) => { const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2; return d < best.d ? { d, q } : best; }, { d: Infinity }).q;
  drive.forEach(p => { p.near = way0(p); });
  const s = drive[drive.length - 1].s;
  // stop briefly at the T-junction lights
  const stops = [N1, N5].map(n => drive.reduce((b, p) => { const d = (p.x - n.x) ** 2 + (p.y - n.y) ** 2; return d < b.d ? { d, s: p.s } : b; }, { d: Infinity }).s - 7);
  // speed profile every 2 m: road limit, bends (sideways grip ~2.2 m/s²), then brake ahead of slow bits
  const step = 2, prof = [];
  const posAt = d => { let lo = 0, hi = drive.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (drive[m].s < d) lo = m; else hi = m; }
    const a = drive[lo], b = drive[hi], f = Math.max(0, Math.min(1, (d - a.s) / ((b.s - a.s) || 1))); return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, a, b }; };
  const limitAt = d => { const q = posAt(d).b.near; const w = ways.find(w => w.pts.includes(q)); const lim = parseLimit(w?.tags.maxspeed); return lim ? lim.v * (lim.mph ? 0.44704 : 0.27778) : 13; };
  for (let d = 0; d <= s; d += step) {
    const A = posAt(Math.max(0, d - 8)), B = posAt(d), C = posAt(Math.min(s, d + 8));
    const h1 = Math.atan2(B.x - A.x, B.y - A.y), h2 = Math.atan2(C.x - B.x, C.y - B.y);
    const dth = Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1)));
    const vBend = dth > 0.01 ? Math.sqrt(2.2 * 8 / dth) : 99;
    prof.push(Math.min(limitAt(d) * 0.95, vBend));
  }
  for (const st of stops) { const i = Math.round(st / step); if (prof[i] != null) prof[i] = 0; }
  for (let i = prof.length - 2; i >= 0; i--) prof[i] = Math.min(prof[i], Math.sqrt(prof[i + 1] ** 2 + 2 * 1.6 * step));
  return { ways, feats, pts, len: s, prof, step, stops, posAt };
}

function drtStart() {
  if (DRT.on) return;
  const R = drtBuild();
  DRT.route = R; DRT.on = true; DRT.s = 0; DRT.v = 0; DRT.stopsDone.clear(); DRT.waitUntil = 0;
  OSM.fixture = true;
  const O = { lat: 51.5072, lon: -0.1276 };   // central London (the route itself is made up)
  OSM.O = O; OSM.ways.clear(); OSM.nodeWays.clear(); OSM.feats.clear(); OSM.path = null; OSM.Hs = null; OSM.prevFixAt = 0;
  const ll = p => ({ lat: O.lat + p.y / 110540, lon: O.lon + p.x / (111320 * Math.cos(O.lat * Math.PI / 180)) });
  osmLoad({ elements: [
    ...R.ways.map(w => ({ type: 'way', id: w.id, tags: w.tags, nodes: w.pts.map(p => p.id), geometry: w.pts.map(ll) })),
    ...R.feats.map((f, i) => ({ type: 'node', id: 9000 + i, ...ll(f.p), tags: f.kind === 'lights' ? { highway: 'traffic_signals' } : f.kind === 'mini' ? { highway: 'mini_roundabout' } : { highway: 'crossing', crossing: 'uncontrolled', crossing_ref: 'zebra' } })),
  ] });
  DRT.ll = ll;
  let last = performance.now();
  DRT.timer = setInterval(() => {
    const now = performance.now(), dt = Math.min(0.5, (now - last) / 1000); last = now;
    const i = Math.min(R.prof.length - 1, Math.round(DRT.s / R.step));
    let target = R.prof[i];
    const stop = R.stops.find(st => !DRT.stopsDone.has(st) && Math.abs(st - DRT.s) < 0.5);
    if (stop != null && DRT.v < 0.4) {                     // waiting at the lights
      if (!DRT.waitUntil) DRT.waitUntil = now + 3500;
      if (now < DRT.waitUntil) target = 0; else { DRT.stopsDone.add(stop); DRT.waitUntil = 0; }
    }
    if (DRT.stopsDone.has(R.stops.find(st => Math.abs(st - DRT.s) < 4))) target = Math.max(target, 4);
    const a = Math.max(-3, Math.min(1.8, (target - DRT.v) * 1.2));
    DRT.a = a; DRT.v = Math.max(0, DRT.v + a * dt); DRT.s += DRT.v * dt;
    // pull up exactly at the stop line of a red light rather than rolling through it
    const pending = R.stops.find(st => !DRT.stopsDone.has(st) && st - DRT.s < 12 && st - DRT.s > -1);
    if (pending != null) {
      const gap = Math.max(0.01, pending - DRT.s);
      if (DRT.s >= pending) { DRT.s = pending; DRT.v = 0; DRT.a = 0; }
      else { const need = DRT.v * DRT.v / (2 * gap); if (need > 0.3) { DRT.a = -Math.min(4, need); DRT.v = Math.max(0, DRT.v + DRT.a * dt); } }
    }
    if (DRT.s > R.len - 10) { drtStop(); drtStart(); }   // loop back to the start
  }, 50);
  const fix = () => {
    if (!DRT.on) return;
    const p = R.posAt(DRT.s), h = Math.atan2(p.b.x - p.a.x, p.b.y - p.a.y) * 180 / Math.PI;
    const q = DRT.ll({ x: p.x + (Math.random() - 0.5) * 3, y: p.y + (Math.random() - 0.5) * 3 });
    osmOnFix(q.lat, q.lon, h, DRT.v, true);
  };
  fix(); DRT.fixTimer = setInterval(fix, 1000);
}

function drtStop() {
  if (!DRT.on) return;
  clearInterval(DRT.timer); clearInterval(DRT.fixTimer);
  DRT.on = false; OSM.fixture = false; OSM.path = null; OSM.ways.clear(); OSM.nodeWays.clear(); OSM.feats.clear(); OSM.O = null;
}

/** Called by the demo generator: speed and power follow the route. */
function demoRouteApply(d) {
  if (!DRT.on || d.demoCharging) return;
  const v = DRT.v, a = DRT.a;
  d.speed = v * 3.6;
  const kw = (1650 * a * v + 0.5 * 1.2 * 0.28 * 2.3 * v ** 3 + 180 * v) / 1000;
  d.kw = kw > 0 ? kw / 0.9 + 0.6 : kw * 0.7 + 0.6;
  d.motorKw = Math.max(0, d.kw - 1.3);
  d.current = d.kw * 1000 / (d.voltage || 370);
  d.gear = v < 0.3 && DRT.waitUntil ? d.gear : 'D';
}

LeafDash.on('mode', m => {
  if (m === 'demo' && SET.demoRoute !== false && !S.demoCharging && !S.replay) drtStart();   // a replay brings its own road
  if (m !== 'demo') drtStop();
});
