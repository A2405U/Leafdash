'use strict';
/* =====================================================================
   Roadside scenery on the Drive screen
   ---------------------------------------------------------------------
   Trees, hedges, houses, lamp posts and fences beside the road, in the
   same outline look as the road: dark shapes with grey edges, and green
   only for leaves and hedges. Nothing is downloaded for this. Each object
   comes from a fixed "random" number for its spot, so the same stretch of
   road always looks the same, and it doesn't flicker or swim.

   What's drawn depends on the road (from OpenStreetMap when real road
   shape is on, otherwise a general mix):
     town   (30 mph and under, residential streets): houses, lamp posts, street trees, garden hedges
     rural  (40 mph and over, single carriageway):   hedgerows, trees, field fences, the odd house
     fast   (dual carriageway, motorway):            tall lamp posts, trees set back, fences
     mixed  (no map data):                           a bit of each
   ===================================================================== */

const SCN = { cell: 12, ahead: 150 };
const SCN_LINE = '#5b6672', SCN_FILL = '#0c1117', SCN_LEAF = '#3ddc97';

/** A repeatable number from 0 to 1 for a spot (and a salt). */
function scnRand(a, b, salt = 0) {
  let h = (Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663) ^ Math.imul(salt + 1, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The kind of road, for the scenery mix. */
function scnKind(li) {
  if (!li) return 'mixed';
  const hw = li.hw || '', lim = li.limit ? (li.limit.mph ? li.limit.v : li.limit.v * 0.621371) : null;
  if (/motorway|trunk/.test(hw) || (!li.bwd && li.fwd >= 2 && (lim ?? 60) >= 50)) return 'fast';
  if (/residential|living_street/.test(hw) || (lim != null && lim <= 30)) return 'town';
  if (lim != null && lim >= 40) return 'rural';
  return 'mixed';
}

/* What stands at one spot, on one side of the road. r() gives the spot's repeatable numbers. */
function scnPick(kind, r) {
  const x = r(1);
  if (kind === 'town') return x < 0.32 ? 'house' : x < 0.5 ? 'tree' : x < 0.64 ? 'lamp' : x < 0.76 ? 'garden' : null;
  if (kind === 'rural') return x < 0.22 ? 'tree' : x < 0.36 ? 'house' : x < 0.5 ? 'fence' : null;
  if (kind === 'fast') return x < 0.35 ? 'lamp' : x < 0.55 ? 'tree' : x < 0.75 ? 'fence' : null;
  return x < 0.2 ? 'tree' : x < 0.28 ? 'house' : x < 0.38 ? 'lamp' : x < 0.48 ? 'fence' : null;
}
const scnHedges = kind => kind === 'rural' || kind === 'mixed';

/**
 * Draw the scenery. W = where things are:
 *   at(s, o) → [X, z]: ground point s metres along the road, o metres to the right of its centre, in camera space
 *   edges(s) → { left, right, kind, skip }: kerb offsets, the road kind, and whether to leave this spot empty
 *   sCar: where the car is along the road; cellKey(s): a fixed id for the spot at s (so things don't move)
 */
function sceneryDraw(g, gh, W, opts) {
  const { P = 0, zMin = 1.2 } = opts;
  const fade = z => Math.max(0, Math.min(1, (130 - z) / 70, (z - 6) / 10));
  if (P > 0.6) return;
  const keep = 1 - P / 0.6;                          // fades out as warp builds up
  const items = [];
  const s0 = W.sCar - 20, s1 = W.sCar + SCN.ahead;
  const seen = new Set();                            // each spot once, even where the road runs along the grid
  for (let s = Math.max(0, Math.floor(s0)); s < s1; s += 1) {
    const key = W.cellKey(s);
    if (key == null) continue;
    const id = key[0] + ',' + key[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const e = W.edges(s);
    if (!e) continue;
    for (const side of [-1, 1]) {
      if (e.skip?.(side)) continue;
      const r = n => scnRand(key[0], key[1], n * 2 + (side > 0 ? 1 : 0));
      const what = scnPick(e.kind, r);
      if (!what) continue;
      const kerb = side < 0 ? e.left : e.right;
      items.push({ what, s, side, kerb, r, kind: e.kind });
    }
  }
  // hedgerows: a run along each side, broken for gateways and junctions
  const hedges = [];
  for (const side of [-1, 1]) {
    let run = null;
    for (let s = Math.max(0, Math.floor(s0)); s < s1; s += 2) {
      const e = W.edges(s);
      const key = e && W.cellKey(s);
      const on = e && key && scnHedges(e.kind) && !e.skip?.(side) && scnRand(key[0], key[1], 40 + side) > 0.12;
      if (on) { const o = (side < 0 ? e.left : e.right) + side * 1.6; (run ||= []).push({ s, o }); }
      else if (run) { if (run.length > 1) hedges.push(run); run = null; }
    }
    if (run && run.length > 1) hedges.push(run);
  }

  g.save();
  g.shadowBlur = 0; g.lineJoin = 'round'; g.lineCap = 'round';
  const px = (s, o, Y = 0) => { const [X, z] = W.at(s, o); return z < zMin ? null : { p: gh(X, z, Y), z }; };
  const style = (a, leaf) => {
    g.globalAlpha = a * keep;
    g.strokeStyle = leaf ? SCN_LEAF : SCN_LINE;
    g.fillStyle = leaf ? 'rgba(61,220,151,.10)' : SCN_FILL;
  };
  const lw = z => Math.max(0.6, Math.min(2, 30 / z));

  // hedges first (they're low and long), far pieces before near ones
  for (const run of hedges) {
    for (let i = run.length - 1; i > 0; i--) {
      const a = run[i - 1], b = run[i];
      const q = [px(a.s, a.o, 0), px(b.s, b.o, 0), px(b.s, b.o, 1.4), px(a.s, a.o, 1.4)];
      if (q.some(x => !x)) continue;
      g.lineWidth = lw(q[0].z) * 0.8;
      const al = fade(q[0].z);
      style(al * 0.55, true); g.fillStyle = 'rgba(61,220,151,.08)';
      g.beginPath(); q.forEach((x, j) => j ? g.lineTo(x.p[0], x.p[1]) : g.moveTo(x.p[0], x.p[1])); g.closePath(); g.fill();
      g.beginPath(); g.moveTo(q[3].p[0], q[3].p[1]); g.lineTo(q[2].p[0], q[2].p[1]); g.stroke();   // the top edge
    }
  }

  // everything else, far to near
  items.sort((a, b) => b.s - a.s);
  for (const it of items) {
    const { r, side } = it;
    const [, zc] = W.at(it.s, it.kerb);
    if (zc < zMin + 0.5) continue;
    const a = fade(zc);
    if (a <= 0.02) continue;
    g.lineWidth = lw(zc);
    if (it.what === 'tree') {
      const o = it.kerb + side * (2.5 + r(2) * (it.kind === 'fast' ? 14 : 8)), h = 2.6 + r(3) * 1.6, R = 1.6 + r(4) * 1.4;
      const base = px(it.s, o, 0), top = px(it.s, o, h); if (!base || !top) continue;
      const u = Math.abs(gh(W.at(it.s, o)[0] + 1, base.z, 0)[0] - base.p[0]);
      style(a * 0.8, false); g.beginPath(); g.moveTo(base.p[0], base.p[1]); g.lineTo(top.p[0], top.p[1]); g.stroke();
      const c = px(it.s, o, h + R * 0.8);
      style(a * 0.7, true);
      g.beginPath(); g.ellipse(c.p[0], c.p[1], R * u, R * u * 0.92, 0, 0, Math.PI * 2);
      g.fillStyle = SCN_FILL; g.fill();                       // hides what's behind the crown
      g.fillStyle = 'rgba(61,220,151,.12)'; g.fill();
      if (zc < 70) { g.globalAlpha = a * keep * 0.6 * Math.min(1, (70 - zc) / 25); g.stroke(); }   // far trees: soft, no outline
    } else if (it.what === 'lamp') {
      const o = it.kerb + side * 0.6, h = it.kind === 'fast' ? 10 : 6.5, arm = side * -1.4;
      const base = px(it.s, o, 0), top = px(it.s, o, h), end = px(it.s, o + arm, h), head = px(it.s, o + arm, h - 0.25);
      if (!base || !top || !end || !head) continue;
      style(a * 0.8, false);
      g.beginPath(); g.moveTo(base.p[0], base.p[1]); g.lineTo(top.p[0], top.p[1]); g.lineTo(end.p[0], end.p[1]); g.stroke();
      g.beginPath(); g.moveTo(end.p[0], end.p[1]); g.lineTo(head.p[0], head.p[1]); g.stroke();
    } else if (it.what === 'fence') {
      const o = it.kerb + side * 1.2, len = 8;
      const posts = [];
      for (let k = 0; k <= 4; k++) posts.push([px(it.s + k * len / 4, o, 0), px(it.s + k * len / 4, o, 1.1), px(it.s + k * len / 4, o, 0.6)]);
      if (posts.some(p => p.some(x => !x))) continue;
      style(a * 0.7, false);
      g.beginPath();
      for (const [b, t] of posts) { g.moveTo(b.p[0], b.p[1]); g.lineTo(t.p[0], t.p[1]); }
      for (const j of [1, 2]) posts.forEach((p, k) => k ? g.lineTo(p[j].p[0], p[j].p[1]) : g.moveTo(p[j].p[0], p[j].p[1]));
      g.stroke();
    } else if (it.what === 'garden') {
      const o = it.kerb + side * 1.0, len = 6 + r(2) * 4;
      const q = [px(it.s, o, 0), px(it.s + len, o, 0), px(it.s + len, o, 0.9), px(it.s, o, 0.9)];
      if (q.some(x => !x)) continue;
      style(a * 0.6, true); g.fillStyle = 'rgba(61,220,151,.08)';
      g.beginPath(); q.forEach((x, j) => j ? g.lineTo(x.p[0], x.p[1]) : g.moveTo(x.p[0], x.p[1])); g.closePath(); g.fill(); g.stroke();
    } else if (it.what === 'house') {
      // a simple pitched-roof house, gable ends facing along the road, set back behind a front garden
      const set = 5 + r(2) * 4, wid = 7 + r(3) * 2.5, dep = 7, hw = 4.6 + r(4) * 0.8, rh = 2.2;
      const oN = it.kerb + side * set, oF = oN + side * dep, oM = (oN + oF) / 2;
      const sA = it.s + (12 - wid) / 2, sB = sA + wid;
      const f = (s, o, Y) => px(s, o, Y);
      const nearEnd = W.at(sA, oM)[1] < W.at(sB, oM)[1] ? sA : sB, farEnd = nearEnd === sA ? sB : sA;
      const gable = s => [f(s, oN, 0), f(s, oF, 0), f(s, oF, hw), f(s, oM, hw + rh), f(s, oN, hw)];
      const faces = [
        { pts: gable(farEnd) },
        { pts: [f(sA, oF, 0), f(sB, oF, 0), f(sB, oF, hw), f(sA, oF, hw)] },            // back wall
        { pts: [f(sA, oF, hw), f(sB, oF, hw), f(sB, oM, hw + rh), f(sA, oM, hw + rh)] }, // back roof
        { pts: [f(sA, oN, 0), f(sB, oN, 0), f(sB, oN, hw), f(sA, oN, hw)], front: true },  // wall facing the road
        { pts: [f(sA, oN, hw), f(sB, oN, hw), f(sB, oM, hw + rh), f(sA, oM, hw + rh)] }, // front roof
        { pts: gable(nearEnd) },
      ];
      if (faces.some(fc => fc.pts.some(x => !x))) continue;
      g.globalAlpha = a * keep; g.fillStyle = SCN_FILL;
      for (const fc of faces) { g.beginPath(); fc.pts.forEach((x, i) => i ? g.lineTo(x.p[0], x.p[1]) : g.moveTo(x.p[0], x.p[1])); g.closePath(); g.fill(); }
      // outline: the wall facing the road, the near gable and the ridge
      style(a * 0.75, false);
      g.beginPath();
      for (const fc of [faces[3], faces[5]]) { fc.pts.forEach((x, i) => i ? g.lineTo(x.p[0], x.p[1]) : g.moveTo(x.p[0], x.p[1])); g.closePath(); }
      const rA = f(sA, oM, hw + rh), rB = f(sB, oM, hw + rh), eA = f(sA, oN, hw), eB = f(sB, oN, hw);
      g.moveTo(rA.p[0], rA.p[1]); g.lineTo(rB.p[0], rB.p[1]); g.lineTo(eB.p[0], eB.p[1]); g.moveTo(rA.p[0], rA.p[1]); g.lineTo(eA.p[0], eA.p[1]);
      g.stroke();
      if (zc > 45) continue;
      // a door and two windows on the road side, faint
      const fr = faces[3].pts, at2 = (u, v) => ({ p: [fr[0].p[0] + (fr[1].p[0] - fr[0].p[0]) * u + (fr[3].p[0] - fr[0].p[0]) * v, fr[0].p[1] + (fr[1].p[1] - fr[0].p[1]) * u + (fr[3].p[1] - fr[0].p[1]) * v] });
      style(a * 0.45, false);
      g.beginPath();
      for (const [u0, u1, v0, v1] of [[0.18, 0.36, 0.55, 0.85], [0.64, 0.82, 0.55, 0.85], [0.44, 0.56, 0, 0.42]]) {
        const c = [at2(u0, v0), at2(u1, v0), at2(u1, v1), at2(u0, v1)];
        c.forEach((x, j) => j ? g.lineTo(x.p[0], x.p[1]) : g.moveTo(x.p[0], x.p[1])); g.closePath();
      }
      g.stroke();
    }
  }
  g.restore();
}

/* ---------------- where things go: the straight road (no map data) ----------------
   Spots are every 12 m of distance driven, so they scroll with the lane lines. */
function sceneryStraight(zCar, KL, KR) {
  const sCar = DR.dist;
  return {
    sCar,
    at: (s, o) => [o, zCar + (s - sCar)],
    cellKey: s => [Math.floor(s / SCN.cell), 7],
    edges: () => ({ left: KL, right: KR, kind: 'mixed' }),
  };
}

/* ---------------- where things go: the real road (OpenStreetMap) ----------------
   Spots come from a fixed grid on the ground, so they stay put when the road is rebuilt from a new
   GPS fix. Junction mouths, roundabouts, traffic lights and zebras are left clear. */
function sceneryReal(G) {
  const cache = new Map();
  const edges = s => {
    const k = Math.round(s);
    if (cache.has(k)) return cache.get(k);
    let e = null;
    try {
      const p = pathAt(s), li = laneInfo(p.seg.w, p.seg.dir), w = li.width;
      const brs = (G.branches || []).filter(b => Math.abs(s - b.sJ) < b.half + 6);
      const busy = (G.feats || []).some(f => Math.abs(f.s - s) < 6) || (OSM.path.rbts || []).some(r => s > r.sIn - 18 && s < r.sOut + 18);
      e = { left: li.bwd ? -li.fwd * w : -li.fwd * w / 2, right: li.bwd ? li.bwd * w : li.fwd * w / 2, kind: scnKind(li),
        skip: side => busy || brs.some(b => b.side === side) };
    } catch {}
    cache.set(k, e);
    return e;
  };
  return {
    sCar: OSM.sCar,
    at: G.at,
    edges,
    cellKey: s => { try { const p = pathAt(s); return [Math.floor(p.x / SCN.cell), Math.floor(p.y / SCN.cell)]; } catch { return null; } },
  };
}
