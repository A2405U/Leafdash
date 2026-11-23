'use strict';
/* =====================================================================
   Real road shape from OpenStreetMap
   ---------------------------------------------------------------------
   1. GPS fix → fetch nearby roads from the Overpass API (cached, only
      when you've moved ~300 m from the last fetch).
   2. Snap the fix to the most likely road (distance + heading, sticky).
   3. Trace the road ahead through connected ways (~250 m) and behind.
   4. drive.js draws it with the same camera and style as the straight
      road, using OSM lanes / oneway / maxspeed tags.
   Map data © OpenStreetMap contributors (ODbL), shown on screen.
   Nothing here talks to the car.
   ===================================================================== */

const OSM_HW = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|service)$';
const OSM_SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OSM = {
  O: null,                 // local origin {lat, lon} for metre coordinates
  ways: new Map(), nodeWays: new Map(), feats: new Map(),   // feats: traffic lights / zebra crossings
  fetchAt: null, nextTry: 0, busy: false, status: '',
  match: null, path: null, sCar: 0, corr: 0, turn: null, shift: { x: 0, y: 0 }, hist: [], carOffS: null, Hs: null, lastFixAt: 0, fixture: false,
};

/* ---------------- geometry helpers ---------------- */
const toXY = (lat, lon) => ({ x: (lon - OSM.O.lon) * 111320 * Math.cos(OSM.O.lat * Math.PI / 180), y: (lat - OSM.O.lat) * 110540 });
const angDiff = (a, b) => { let d = Math.abs(a - b) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };
const brg = (a, b) => Math.atan2(b.x - a.x, b.y - a.y);           // radians clockwise from north
const metres = (a, b) => { const p = Math.PI / 180, x = (b.lon - a.lon) * p * Math.cos((a.lat + b.lat) * p / 2), y = (b.lat - a.lat) * p; return Math.hypot(x, y) * 6371e3; };

const isRbt = w => !!w && (w.tags.junction === 'roundabout' || w.tags.junction === 'circular');

function oneway(w) {
  const t = w.tags, o = t.oneway;
  if (o === '-1') return -1;
  if (o === 'yes' || o === 'true' || o === '1') return 1;
  if (o === 'no') return 0;
  return t.highway === 'motorway' || t.junction === 'roundabout' || t.junction === 'circular' ? 1 : 0;
}

/** Lanes in our direction / oncoming, lane width, limit and name for a way travelled in `dir`. */
function laneInfo(w, dir) {
  const t = w.tags, hw = t.highway, ow = oneway(w);
  const width = /^(motorway|trunk)/.test(hw) ? 3.6 : /^(primary|secondary)/.test(hw) ? 3.4 : /^(tertiary|unclassified)/.test(hw) ? 3.1 : 2.9;
  let fwd, bwd;
  if (ow) { fwd = +t.lanes || (hw === 'motorway' ? 3 : 1); bwd = 0; }
  else {
    const total = +t.lanes, lf = +t['lanes:forward'], lb = +t['lanes:backward'];
    fwd = lf || (total ? Math.max(1, Math.floor(total / 2)) : 1);
    bwd = lb || (total ? Math.max(1, total - fwd) : 1);
    if (dir < 0) [fwd, bwd] = [bwd, fwd];
  }
  const ms = (dir < 0 ? t['maxspeed:backward'] : t['maxspeed:forward']) || t.maxspeed;
  return { fwd: Math.min(fwd, 6), bwd: Math.min(bwd, 6), width, limit: parseLimit(ms), name: t.name || '', ref: t.ref || '', hw };
}
function parseLimit(v) {
  if (!v) return null;
  const nsl = { 'GB:nsl_single': 60, 'GB:nsl_dual': 70, 'GB:motorway': 70, 'GB:nsl_restricted': 30, national: 60 };
  if (nsl[v]) return { v: nsl[v], mph: true };
  const m = String(v).match(/(\d+)\s*(mph)?/);
  return m ? { v: +m[1], mph: !!m[2] } : null;
}

/* ---------------- fetching ---------------- */
/* ---------------- remembered map areas ----------------
   Every map download is kept on this phone (IndexedDB store 'osmcache') for 30 days, named by where and
   when it was downloaded. Driving the same roads again (a commute) loads them from here instead of asking
   the map servers, so it also works when the servers are busy or there's no signal. The newest 250 areas
   are kept (each is 100–300 kB). They're not part of a backup, and Settings → Drive screen can forget them. */
const OSMC = { keys: null, loaded: new Set(), MAX: 250, DAYS: 30 };
const osmcKey = (lat, lon, at) => `${lat.toFixed(5)},${lon.toFixed(5)},${at}`;
const osmcParse = k => { const [lat, lon, at] = String(k).split(',').map(Number); return { k, lat, lon, at }; };
async function osmcStore(mode = 'readonly') { return (await htDb()).transaction('osmcache', mode).objectStore('osmcache'); }
const osmcReq = q => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
/** The list of remembered areas (loaded once), with old ones forgotten. */
async function osmcIndex() {
  if (OSMC.keys) return OSMC.keys;
  const keys = (await osmcReq((await osmcStore()).getAllKeys())).map(osmcParse);
  const old = Date.now() - OSMC.DAYS * 864e5;
  const stale = keys.filter(e => !(e.at > old));
  if (stale.length) { const st = await osmcStore('readwrite'); stale.forEach(e => st.delete(e.k)); }
  return OSMC.keys = keys.filter(e => e.at > old);
}
/** Load every remembered area within 800 m that isn't loaded yet. Returns the nearest one's centre if it's
 *  within 350 m (its 700 m radius still reaches well ahead), else null, meaning a download is needed. */
async function osmcLoadNear(lat, lon) {
  const here = { lat, lon };
  const near = (await osmcIndex()).map(e => ({ e, d: metres(e, here) })).filter(x => x.d < 800).sort((a, b) => a.d - b.d);
  for (const { e } of near) {
    if (OSMC.loaded.has(e.k)) continue;
    const json = await osmcReq((await osmcStore()).get(e.k));
    OSMC.loaded.add(e.k);
    if (json) osmLoad(json, true);
  }
  return near.length && near[0].d < 350 ? { lat: near[0].e.lat, lon: near[0].e.lon } : null;
}
async function osmcPut(lat, lon, json) {
  try {
    const idx = await osmcIndex(), e = osmcParse(osmcKey(lat, lon, Date.now()));
    const st = await osmcStore('readwrite');
    st.put(json, e.k);
    idx.push(e); OSMC.loaded.add(e.k);
    idx.sort((a, b) => a.at - b.at);
    while (idx.length > OSMC.MAX) st.delete(idx.shift().k);       // forget the oldest
  } catch {}
}
async function osmcClear() {
  try { (await osmcStore('readwrite')).clear(); } catch {}
  OSMC.keys = []; OSMC.loaded.clear();
}
async function osmcCount() { try { return (await osmcIndex()).length; } catch { return 0; } }

async function osmFetch(lat, lon) {
  if (OSM.fixture || OSM.busy) return;
  if (OSM.fetchAt && metres(OSM.fetchAt, { lat, lon }) < 300 && OSM.ways.size) return;
  OSM.busy = true;
  // roads driven before: from the phone, no download (also while waiting to retry after a server error)
  try {
    const hit = await osmcLoadNear(lat, lon);
    if (hit) { OSM.fetchAt = hit; OSM.status = ''; OSM.busy = false; return; }
  } catch {}
  if (Date.now() < OSM.nextTry) { OSM.busy = false; return; }
  const at = `around:700,${lat.toFixed(5)},${lon.toFixed(5)}`;
  // roads; lights, crossings, mini-roundabouts; speed and red-light cameras in the usual ways they're mapped
  const q = `[out:json][timeout:15];(way(${at})[highway~"${OSM_HW}"];node(${at})[highway~"^(traffic_signals|crossing|mini_roundabout|speed_camera|red_light_camera)$"];node(${at})[man_made=surveillance][surveillance~"red_light|traffic"];rel(${at})[type=enforcement];);out body geom qt;`;
  for (const url of OSM_SERVERS) {
    try {
      // form-encoded POST is a "simple" request, so no CORS preflight is needed
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const json = await r.json();
      osmLoad(json);
      osmcPut(lat, lon, json);                                  // remember it for next time
      OSM.fetchAt = { lat, lon }; OSM.nextTry = Date.now() + 10e3; OSM.status = ''; OSM.fails = 0;
      OSM.busy = false;
      return;
    } catch (e) { OSM.status = 'map data unavailable'; window.LeafDash?.emit('osmerr', { server: new URL(url).host, why: String(e.message || e) }); }
  }
  // both servers failed (usually busy: HTTP 502/504): try again after 10 s, then 20, 40, at most 60 s
  OSM.fails = (OSM.fails || 0) + 1;
  OSM.nextTry = Date.now() + Math.min(60, 10 * 2 ** (OSM.fails - 1)) * 1000;
  OSM.busy = false;
}

/** Traffic lights (junction or crossing) and zebra crossings; other crossings are ignored. */
function featKind(t) {
  const cam = camKind(t); if (cam) return cam;
  if (t.highway === 'traffic_signals' || t.crossing === 'traffic_signals' || t['crossing:signals'] === 'yes') return 'lights';
  if (t.crossing === 'zebra' || t.crossing_ref === 'zebra') return 'zebra';
  if (t.highway === 'mini_roundabout') return 'mini';
  return null;
}
/** Speed or red-light camera, from the different ways they're tagged in OpenStreetMap (they vary a lot). */
function camKind(t) {
  const note = `${t.note || ''} ${t.description || ''} ${t.name || ''}`;
  const red = t.highway === 'red_light_camera' || t.speed_camera === 'traffic_signals' || /^(traffic_signals|red_?light(_camera)?)$/.test(t.enforcement || '') || /red.?light/i.test(note)
    || (t.man_made === 'surveillance' && /red_light|traffic_signals/.test(`${t.surveillance || ''} ${t['surveillance:type'] || ''}`));
  if (red && (t.highway === 'speed_camera' || t.highway === 'red_light_camera' || t.man_made === 'surveillance' || t.enforcement)) return 'redcam';
  if (t.highway === 'speed_camera' || t.enforcement === 'maxspeed' || t.enforcement === 'average_speed') return 'speedcam';
  return null;
}
function osmLoad(json, cached = false) {
  window.LeafDash?.emit('osm', cached ? { ...json, cached: true } : json);   // for the drive recorder
  for (const el of json.elements || []) {
    if (el.type === 'relation') {                                        // enforcement: the camera is the "device" member
      const kind = el.tags?.type === 'enforcement' ? camKind(el.tags) : null;
      if (kind) for (const m of el.members || []) if (m.role === 'device' && m.type === 'node' && m.lat != null) {
        const id = `r${el.id}:${m.ref}`;
        if (!OSM.feats.has(id)) OSM.feats.set(id, { id, kind, ...toXY(m.lat, m.lon) });
      }
      continue;
    }
    if (el.type === 'node') {
      const t = el.tags || {}, kind = featKind(t);
      if (kind && !OSM.feats.has(el.id)) OSM.feats.set(el.id, { id: el.id, kind, ...toXY(el.lat, el.lon) });
      // traffic lights that also carry a camera tag (e.g. enforcement=red_light_camera on the lights): show both
      if (t.highway === 'traffic_signals' && kind !== 'lights' && !OSM.feats.has('l' + el.id)) OSM.feats.set('l' + el.id, { id: 'l' + el.id, kind: 'lights', ...toXY(el.lat, el.lon) });
      continue;
    }
    if (el.type !== 'way' || !el.geometry || OSM.ways.has(el.id)) continue;
    const w = { id: el.id, tags: el.tags || {}, nodes: el.nodes, pts: el.geometry.map(g => toXY(g.lat, g.lon)) };
    OSM.ways.set(el.id, w);
    w.nodes.forEach(n => { (OSM.nodeWays.get(n) || OSM.nodeWays.set(n, []).get(n)).push(w); });
  }
  // forget roads far from here so memory stays small
  if (OSM.ways.size > 4000 && OSM.match) {
    const here = OSM.match.p;
    for (const [id, w] of OSM.ways) if (Math.hypot(w.pts[0].x - here.x, w.pts[0].y - here.y) > 4000) OSM.ways.delete(id);
    OSMC.loaded.clear();                                       // remembered areas can load again when we come back
  }
}

/* ---------------- map matching ---------------- */
function osmMatch(p, heading, speed) {
  let best = null;
  const prev = OSM.match;
  for (const w of OSM.ways.values()) {
    const ow = oneway(w);
    for (let i = 0; i < w.pts.length - 1; i++) {
      const a = w.pts[i], b = w.pts[i + 1], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
      if (!L2) continue;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
      const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      if (d > 40) continue;
      const b0 = Math.atan2(dx, dy);
      let dir = 1, pen = 0;
      if (heading != null && speed > 1.5) {
        const df = angDiff(b0, heading), dr = angDiff(b0 + Math.PI, heading);
        if (ow === 1) pen = df; else if (ow === -1) { pen = dr; dir = -1; } else if (dr < df) { dir = -1; pen = dr; } else pen = df;
      } else if (prev?.w === w) dir = prev.dir;
      else if (ow === -1) dir = -1;
      const score = d + pen * 57.3 * 0.3 - (prev?.w === w ? 6 : 0) + (w.tags.highway === 'service' ? 8 : 0);
      if (!best || score < best.score) best = { w, i, t, dir, score, d, p: { x: a.x + t * dx, y: a.y + t * dy } };
    }
  }
  return best && best.d < 30 ? best : null;
}

/* ---------------- tracing the road ---------------- */
/** Walk from (w, segment i, fraction t) in direction dir for up to `len` metres. */
function trace(w, i, t, dir, len) {
  const out = [];
  const a = w.pts[i], b = w.pts[i + 1];
  let cur = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  out.push({ ...cur, w, dir });
  let vi = dir > 0 ? i + 1 : i;                  // next vertex index
  let total = 0, hops = 0, lastBrg = dir > 0 ? brg(a, b) : brg(b, a);
  const ring = new Set();                        // roundabout nodes already passed: one lap, then stop
  while (total < len && hops < 12) {
    if (vi >= 0 && vi < w.pts.length) {
      const nxt = w.pts[vi];
      if (isRbt(w)) { if (ring.has(w.nodes[vi])) break; ring.add(w.nodes[vi]); }
      total += Math.hypot(nxt.x - cur.x, nxt.y - cur.y);
      if (Math.hypot(nxt.x - cur.x, nxt.y - cur.y) > 0.01) lastBrg = brg(cur, nxt);
      out.push({ ...nxt, w, dir, node: w.nodes[vi] });
      cur = nxt; vi += dir;
      continue;
    }
    // end of this way: continue onto the connected way that turns the least
    const node = w.nodes[dir > 0 ? w.nodes.length - 1 : 0];
    // a roundabout mapped as one closed loop: carry on round from its start
    if (isRbt(w) && w.nodes.length > 3 && w.nodes[0] === w.nodes[w.nodes.length - 1]) { vi = dir > 0 ? 1 : w.nodes.length - 2; hops++; continue; }
    let pick = null;
    for (const c of OSM.nodeWays.get(node) || []) {
      if (c === w) continue;
      if (isRbt(w) && !isRbt(c)) continue;         // stay on the roundabout; its exits are drawn as side roads
      const j = c.nodes.indexOf(node), ow = oneway(c);
      for (const d of [1, -1]) {
        if ((d === 1 && (j >= c.nodes.length - 1 || ow === -1)) || (d === -1 && (j <= 0 || ow === 1))) continue;
        const turn = angDiff(brg(c.pts[j], c.pts[j + d]), lastBrg);
        const same = (c.tags.ref && c.tags.ref === w.tags.ref) || (c.tags.name && c.tags.name === w.tags.name);
        const score = turn - (same ? 0.35 : 0) + (c.tags.highway === 'service' ? 0.6 : 0) - (isRbt(c) ? 1.5 : 0);
        if (!pick || score < pick.score) pick = { c, j, d, turn, score };
      }
    }
    if (!pick || (pick.turn > 1.25 && !isRbt(pick.c))) break;   // road ends (T-junction) or only sharp turns; joining a roundabout is fine
    w = pick.c; dir = pick.d; vi = pick.j + dir; hops++;
  }
  return out;
}

/** Resample a traced polyline every metre, smooth it (moving average ±r m, two passes), and add s + heading. */
function smoothLine(raw, r = 5) {
  const R = [{ x: raw[0].x, y: raw[0].y, w: raw[Math.min(1, raw.length - 1)].w, dir: raw[Math.min(1, raw.length - 1)].dir }];
  let carry = 0;
  for (let k = 1; k < raw.length; k++) {
    const A = raw[k - 1], B = raw[k], L = Math.hypot(B.x - A.x, B.y - A.y);
    if (L < 1e-6) continue;
    let d = 1 - carry;
    while (d <= L) { const f = d / L; R.push({ x: A.x + (B.x - A.x) * f, y: A.y + (B.y - A.y) * f, w: B.w, dir: B.dir }); d += 1; }
    carry = L - (d - 1);
  }
  let P = R;
  for (let pass = 0; pass < 2; pass++) {
    P = P.map((p, i) => {
      const n = Math.min(r, i, P.length - 1 - i);
      let x = 0, y = 0;
      for (let j = i - n; j <= i + n; j++) { x += P[j].x; y += P[j].y; }
      return { ...p, x: x / (2 * n + 1), y: y / (2 * n + 1) };
    });
  }
  let sAcc = 0;
  P.forEach((p, k) => {
    if (k) sAcc += Math.hypot(p.x - P[k - 1].x, p.y - P[k - 1].y);
    p.s = sAcc;
    p.h = brg(P[Math.max(0, k - 1)], P[Math.min(P.length - 1, k + 1)]);
  });
  return { pts: P, len: sAcc };
}

/** Roads joining the path at junctions (side roads, and both ways at a T-junction), each traced ~70 m. */
function findBranches(raw, P) {
  const out = [], seen = new Set();
  let sRaw = 0;
  for (let k = 0; k < raw.length; k++) {
    if (k) sRaw += Math.hypot(raw[k].x - raw[k - 1].x, raw[k].y - raw[k - 1].y);
    const node = raw[k].node;
    if (node == null || seen.has(node) || k === 0) continue;      // k = 0 is just where the traced path starts behind us
    const ways = OSM.nodeWays.get(node) || [];
    if (ways.length < 2 && !(k === raw.length - 1 && ways.length)) continue;
    seen.add(node);
    const inB = k > 0 ? brg(raw[k - 1], raw[k]) : null, outB = k < raw.length - 1 ? brg(raw[k], raw[k + 1]) : null;
    const sJ = P[Math.min(P.length - 1, Math.round(sRaw))].s;
    for (const c of ways) {
      c.nodes.forEach((nd, j) => {
        if (nd !== node) return;
        for (const d of [1, -1]) {
          if (j + d < 0 || j + d >= c.pts.length) continue;
          const b = brg(c.pts[j], c.pts[j + d]);
          if (outB != null && angDiff(b, outB) < 0.35) continue;              // the way we carry on along
          if (inB != null && angDiff(b, inB + Math.PI) < 0.35) continue;      // the way we came from
          const t = trace(c, d > 0 ? j : j - 1, d > 0 ? 0 : 1, d, 70);
          if (t.length < 2) continue;
          const line = smoothLine(t, 3);
          if (line.len < 5) continue;
          const ref = outB ?? (inB != null ? inB : b);
          const turn = Math.atan2(Math.sin(b - ref), Math.cos(b - ref));            // + = right, − = left
          out.push({ sJ, ...line, node, c, j, d, turn, atEnd: k === raw.length - 1 });
        }
      });
    }
    if (out.length > 40) break;
  }
  return out;
}

/** Traffic lights / zebras on (or right beside) the path, as arc lengths. Lights mapped once per
 *  approach at one junction are merged so each junction shows once. */
function findFeats(P) {
  const out = [];
  for (const f of OSM.feats.values()) {
    let best = null;
    for (let i = 0; i < P.length; i += 2) {
      const d = (P[i].x - f.x) ** 2 + (P[i].y - f.y) ** 2;
      if (!best || d < best.d) best = { d, s: P[i].s };
    }
    const r = f.kind === 'speedcam' || f.kind === 'redcam' ? 15 : 10;   // cameras stand a little further back than lights
    if (best && best.d < r * r) out.push({ kind: f.kind, s: best.s });
  }
  out.sort((a, b) => a.s - b.s);
  return out.filter((f, i) => !out.slice(0, i).some(g => g.kind === f.kind && Math.abs(g.s - f.s) < 25));
}

/** Roundabouts the path goes round: centre and radius (from the smoothed line, so the island fits the
 *  drawn road), and where the path joins and leaves the ring. */
function findRbts(P) {
  const out = [];
  for (let i = 0; i < P.length; i++) {
    if (!isRbt(P[i].w)) continue;
    let j = i; while (j + 1 < P.length && isRbt(P[j + 1].w)) j++;
    // every way of this ring (it may be mapped in several pieces)
    const ways = new Set([P[i].w]), todo = [P[i].w], pts = new Map();
    while (todo.length) {
      const w = todo.pop();
      w.nodes.forEach((n, k) => { pts.set(n, w.pts[k]); for (const c of OSM.nodeWays.get(n) || []) if (isRbt(c) && !ways.has(c)) { ways.add(c); todo.push(c); } });
    }
    const all = [...pts.values()], cx = all.reduce((t, q) => t + q.x, 0) / all.length, cy = all.reduce((t, q) => t + q.y, 0) / all.length;
    const rTrue = all.reduce((t, q) => t + Math.hypot(q.x - cx, q.y - cy), 0) / all.length;
    const ds = P.slice(i, j + 1).map(q => Math.hypot(q.x - cx, q.y - cy)).sort((a, b) => a - b);
    const r = ds.length > 12 ? ds[ds.length >> 1] : rTrue;
    const li = laneInfo(P[i].w, 1), half = li.fwd * li.width / 2;
    if (rTrue > 3 && rTrue < 150) out.push({ x: cx, y: cy, r, rin: Math.max(0.8, r - half - 0.6), half, sIn: P[i].s, sOut: P[j].s });
    i = j;
  }
  return out;
}

/** Build the path (behind → ahead) through the matched point, resampled every metre and smoothed,
 *  so bends are curves instead of the map's corner-to-corner straight lines. */
function buildPath(m) {
  let ahead = trace(m.w, m.i, m.t, m.dir, 320);
  const endNode = ahead[ahead.length - 1].node;
  if (OSM.turn && endNode === OSM.turn.node) {                 // we've seen which way you're turning: carry on round it
    const T = OSM.turn, ext = trace(T.c, T.d > 0 ? T.j : T.j - 1, T.d > 0 ? 0 : 1, T.d, 260);
    ahead = ahead.concat(ext.slice(1));
  }
  let behind = null;
  if (!behind) behind = trace(m.w, m.i, m.t, -m.dir, 40).reverse().map(p => ({ ...p, dir: -p.dir }));
  const raw = [...behind.slice(0, -1), ...ahead];
  let sCarRaw = 0;
  for (let k = 1; k < behind.length; k++) sCarRaw += Math.hypot(behind[k].x - behind[k - 1].x, behind[k].y - behind[k - 1].y);
  const line = smoothLine(raw, 5), P = line.pts;
  const ic = Math.min(P.length - 1, Math.round(sCarRaw));
  const branches = findBranches(raw, P);
  const last = raw[raw.length - 1], prev = raw[raw.length - 2] || last;
  return { pts: P, len: line.len, sCar: P[ic].s, branches, feats: findFeats(P), rbts: findRbts(P),
    endTurns: branches.filter(b => b.atEnd), endNode: last.node, endH: brg(prev, last), endPt: last };
}

/** At the end of the drawn road (a T-junction): work out which way you're turning from your heading
 *  (or an indicator, once that can be read) and remember it, so the road carries on round the corner. */
function osmPickTurn(heading, speed) {
  const P = OSM.path;
  if (!P || !P.endTurns.length || P.len - OSM.sCar > 45) return false;
  if (OSM.turn?.node === P.endNode) return false;
  let want = 0;
  const ind = typeof lightBit === 'function' && S.mode === 'on' ? (lightBit('indL') ? -1 : lightBit('indR') ? 1 : 0) : 0;
  if (ind) want = ind;
  else if (heading != null && speed > 1.2) {
    const dh = Math.atan2(Math.sin(heading - P.endH), Math.cos(heading - P.endH));
    if (Math.abs(dh) > 0.16) want = Math.sign(dh);
  }
  if (!want) return false;
  const opts = P.endTurns.filter(b => Math.sign(b.turn) === want);
  if (!opts.length) return false;
  const b = opts.sort((x, y) => Math.abs(x.turn) - Math.abs(y.turn))[0];
  OSM.turn = { node: P.endNode, c: b.c, j: b.j, d: b.d, at: P.endPt };
  return true;
}

/** Closest arc length on the path to a world point (searching near sGuess). */
function pathNearest(path, pt, sGuess, span = 40) {
  let best = null;
  for (const p of path.pts) {
    if (Math.abs(p.s - sGuess) > span) continue;
    const d = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
    if (!best || d < best.d) best = { d, s: p.s };
  }
  return best;
}

/* ---------------- GPS input (called from drive.js) ---------------- */
function osmOnFix(lat, lon, heading, speed, fake = false) {
  if (fake) window.LeafDash?.emit('gps', { lat, lon, hdg: heading == null ? null : heading, spd: speed, fake: true });   // demo route
  if (OSM.fixture ? !fake : !SET.realRoad) return;          // demo route ignores the phone's GPS
  if (!OSM.O || metres(OSM.O, { lat, lon }) > 20000) { OSM.O = { lat, lon }; OSM.ways.clear(); OSM.nodeWays.clear(); OSM.feats.clear(); OSM.fetchAt = null; OSMC.loaded.clear(); }
  osmFetch(lat, lon);
  const p = toXY(lat, lon);
  const h = heading != null && !Number.isNaN(heading) ? heading * Math.PI / 180 : null;
  const m = osmMatch(p, h, speed ?? 0);
  OSM.match = m;
  OSM.lastFixAt = Date.now();
  if (!m) { OSM.path = null; OSM.hist = []; return; }
  // where the car is drawn right now (dead-reckoned), before swapping in the new path
  const was = OSM.path ? pathAt(OSM.sCar) : null, oldPath = OSM.path, oldS = OSM.sCar;
  const fresh = Date.now() - (OSM.prevFixAt || 0) < 4000;
  OSM.prevFixAt = Date.now();
  if (OSM.turn && Math.hypot(OSM.turn.at.x - p.x, OSM.turn.at.y - p.y) > 80) OSM.turn = null;   // well past it
  OSM.path = buildPath(m);
  if (was && osmPickTurn(h, speed ?? 0)) OSM.path = buildPath(m);
  const near = was && fresh ? pathNearest(OSM.path, was, OSM.path.sCar) : null;
  if (near && near.d < 25 * 25) {
    // keep the road where it is on screen and ease towards the GPS position over ~1 s, instead of jumping
    OSM.sCar = near.s;
    OSM.corr = OSM.path.sCar - near.s;
    // the new road may sit a little to one side of the old one (e.g. cutting the corner at a turn):
    // remember the offset and slide it away over ~½ s instead of jumping
    const q = pathAt(near.s);
    OSM.shift = { x: OSM.shift.x + was.x - q.x, y: OSM.shift.y + was.y - q.y };
    for (const br of oldPath.branches || []) {
      if (br.sJ > oldS + 5 || br.sJ < oldS - 90) continue;
      const jp = br.pts[0];
      if (OSM.path.branches.some(b => Math.hypot(b.pts[0].x - jp.x, b.pts[0].y - jp.y) < 3 && Math.abs(b.turn - br.turn) < 0.3)) continue;
      const nb = pathNearest(OSM.path, jp, near.s - (oldS - br.sJ), 30);
      if (nb && nb.d < 6 * 6) OSM.path.branches.push({ ...br, sJ: nb.s, atEnd: false });
    }
    // GPS wobbles a metre or two: ignore small corrections when slow, so a stopped car stays put
    if (Math.abs(OSM.corr) < (speed > 3 ? 1 : 3.5)) OSM.corr = 0;
  } else { OSM.sCar = OSM.path.sCar; OSM.corr = 0; OSM.Hs = null; OSM.shift = { x: 0, y: 0 }; OSM.hist = []; OSM.carOffS = null; }
}

/** Called every frame: dead-reckon along the path between GPS fixes. */
function osmAdvance(mps, dt) {
  if (!OSM.path) return;
  if (Date.now() - OSM.lastFixAt > 8000) { OSM.path = null; OSM.hist = []; return; }   // GPS lost
  const k = Math.exp(-dt * 5); OSM.shift.x *= k; OSM.shift.y *= k;
  const c = OSM.corr * Math.min(1, dt * 1.8) * Math.min(1, Math.max(0.2, mps / 4));   // ease out the gap to the last GPS fix (gently when slow)
  OSM.corr -= c;
  OSM.sCar = Math.max(0, Math.min(OSM.path.len - 1, OSM.sCar + mps * dt + c));
}
const osmActive = () => (SET.realRoad || OSM.fixture) && !!OSM.path;

/* position + tangent at arc length s (smooth: heading is interpolated between samples) */
function pathAt(s, P = OSM.path.pts) {
  let lo = 0, hi = P.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (P[mid].s < s) lo = mid; else hi = mid; }
  const a = P[lo], b = P[hi], L = (b.s - a.s) || 1, f = Math.max(0, Math.min(1, (s - a.s) / L));
  const sx = Math.sin(a.h) * (1 - f) + Math.sin(b.h) * f, cy = Math.cos(a.h) * (1 - f) + Math.cos(b.h) * f;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, h: Math.atan2(sx, cy), seg: f < 0.5 ? a : b };
}

/* ---------------- drawing (same style as the straight road) ---------------- */
/**
 * gp(X, z) → [screenX, screenY] for a ground point; X right, z forward from the camera.
 * zCar = z of the car's middle.
 */
function osmGeometry(zCar) {
  const car = pathAt(OSM.sCar);
  // heading from ±6 m of road, then eased over time so the view never snaps round
  const hA = pathAt(Math.max(0, OSM.sCar - 6)), hB = pathAt(Math.min(OSM.path.len, OSM.sCar + 6));
  const Ht = Math.atan2(hB.x - hA.x, hB.y - hA.y), now = performance.now();
  if (OSM.Hs == null) OSM.Hs = Ht;
  else {
    const dt = Math.min(0.1, (now - (OSM.Ht0 || now)) / 1000);
    let d = Ht - OSM.Hs; d = Math.atan2(Math.sin(d), Math.cos(d));
    const step = Math.sign(d) * Math.min(Math.abs(d) * Math.min(1, dt * 9), 4.4 * dt);   // eased, at most ~250°/s
    OSM.Hs += step;
  }
  OSM.Ht0 = now;
  const H = OSM.Hs;
  const Fx = Math.sin(H), Fy = Math.cos(H), Rx = Math.cos(H), Ry = -Math.sin(H);
  const info0 = laneInfo(car.seg.w, car.seg.dir);
  const laneW = info0.width;
  // which lane we're drawn in: next to the centre line on two-way roads, left/middle lane on one-way
  const left0 = info0.bwd ? -info0.fwd * laneW : -info0.fwd * laneW / 2;
  const k = info0.bwd ? info0.fwd - 1 : info0.fwd >= 3 ? 1 : 0;
  const carOffT = left0 + (k + 0.5) * laneW;
  if (OSM.carOffS == null) OSM.carOffS = carOffT;
  OSM.carOffS += (carOffT - OSM.carOffS) * Math.min(1, ((now - (OSM.offT || now)) / 1000) * 0.9);   // drift into a new lane over ~2 s
  OSM.offT = now;
  const carOff = OSM.carOffS;
  const cN = { x: Math.cos(car.h), y: -Math.sin(car.h) };
  const cw = { x: car.x + cN.x * carOff + OSM.shift.x, y: car.y + cN.y * carOff + OSM.shift.y };
  const at = (s, o) => {                                  // ground point at arc length s, offset o (m, right +)
    const p = pathAt(s), N = { x: Math.cos(p.h), y: -Math.sin(p.h) };
    const wx = p.x + N.x * o - cw.x, wy = p.y + N.y * o - cw.y;
    return [wx * Rx + wy * Ry, zCar + wx * Fx + wy * Fy];
  };

  // samples on a fixed world grid (so they don't swim), 1 m near, coarser far
  const samples = [];
  const s0 = Math.max(0, Math.floor(OSM.sCar - 25));
  for (let s = s0; s < OSM.path.len; s += (s - OSM.sCar < 60 ? 1 : s - OSM.sCar < 140 ? 2 : 4)) {
    const p = pathAt(s), li = laneInfo(p.seg.w, p.seg.dir), w = li.width;
    samples.push({ s, li, left: li.bwd ? -li.fwd * w : -li.fwd * w / 2, right: li.bwd ? li.bwd * w : li.fwd * w / 2,
      toCar: o => at(s, o) });
  }
  // taper road-edge changes (lanes appearing / widths changing) over ~20 m instead of a step
  for (const key of ['left', 'right']) {
    const v = samples.map(x => x[key]);
    for (let pass = 0; pass < 2; pass++) { const u = samples.map(x => x[pass ? key + 'S' : key]); samples.forEach((x, i) => { let t = 0, n = 0; for (let j = Math.max(0, i - 10); j <= Math.min(u.length - 1, i + 10); j++) { t += u[j]; n++; } x[key + 'S'] = t / n; }); }
  }
  // side roads: world → car-frame transform, edges per point
  const w2c = (x, y) => { const wx = x - cw.x, wy = y - cw.y; return [wx * Rx + wy * Ry, zCar + wx * Fx + wy * Fy]; };
  const branches = [];
  for (const br of OSM.path.branches || []) {
    if (br.sJ < OSM.sCar - zCar - 80 || br.sJ > OSM.sCar + 260) continue;      // keep until it's well behind the camera
    const q = pathAt(br.sJ), N = { x: Math.cos(q.h), y: -Math.sin(q.h) };
    const far = pathAt(Math.min(br.len, 10), br.pts);
    const side = Math.sign((far.x - br.pts[0].x) * N.x + (far.y - br.pts[0].y) * N.y) || 1;
    const li0 = laneInfo(br.pts[1].w, br.pts[1].dir), w0 = li0.width;
    const half = Math.max(li0.bwd ? Math.max(li0.fwd, li0.bwd) * w0 : li0.fwd * w0 / 2, 3);
    const mi = laneInfo(q.seg.w, q.seg.dir), mw = mi.width;
    const mainH = mi.bwd ? Math.max(mi.fwd, mi.bwd) * mw : mi.fwd * mw / 2;
    const atB = (s2, o) => { const p = pathAt(s2, br.pts), n = { x: Math.cos(p.h), y: -Math.sin(p.h) }; return w2c(p.x + n.x * o, p.y + n.y * o); };
    branches.push({ ...br, side, half, mainH, li: li0, at: atB });
  }
  const feats = (OSM.path.feats || []).filter(f => f.s > OSM.sCar - zCar + 0.5 && f.s < OSM.sCar + 250).map(f => {
    const li = laneInfo(pathAt(f.s).seg.w, pathAt(f.s).seg.dir), w = li.width;
    return { ...f, left: li.bwd ? -li.fwd * w : -li.fwd * w / 2, right: li.bwd ? li.bwd * w : li.fwd * w / 2 };
  });
  // roundabouts: the island, and a give-way line across our side of the road where we join
  const rbts = (OSM.path.rbts || []).filter(r => r.sOut > OSM.sCar - zCar - 60 && r.sIn < OSM.sCar + 260).map(r => {
    const poly = [];
    for (let a = 0; a < 36; a++) poly.push(w2c(r.x + Math.sin(a * Math.PI / 18) * r.rin, r.y + Math.cos(a * Math.PI / 18) * r.rin));
    return { ...r, poly };
  });
  for (const r of OSM.path.rbts || []) {
    const sg = r.sIn - r.half - 1.2;
    if (sg < OSM.sCar - zCar + 0.5 || sg > OSM.sCar + 250 || sg < 1) continue;
    const q = pathAt(sg);
    if (isRbt(q.seg.w)) continue;                                    // the path starts on the ring: nothing to give way at
    const li = laneInfo(q.seg.w, q.seg.dir), w = li.width;
    feats.push({ kind: 'giveway', s: sg, left: li.bwd ? -li.fwd * w : -li.fwd * w / 2, right: li.bwd ? 0 : li.fwd * w / 2 });
  }
  return { samples, info: info0, at, branches, feats, rbts };
}

/** Clip a ground polygon (car-frame [X, z] points) at the camera's near plane and turn it into a screen path,
 *  so road swinging in beside the camera is trimmed at the edge of view instead of vanishing. */
function clipPath(poly, gp, zNear = 0.8) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], ina = a[1] >= zNear, inb = b[1] >= zNear;
    if (ina) out.push(a);
    if (ina !== inb) { const t = (zNear - a[1]) / (b[1] - a[1]); out.push([a[0] + (b[0] - a[0]) * t, zNear]); }
  }
  if (out.length < 3) return null;
  const q = new Path2D();
  out.forEach((p, i) => { const [x, y] = gp(...p); i ? q.lineTo(x, y) : q.moveTo(x, y); });
  q.closePath();
  return q;
}

/** Road surface. */
function osmDrawSurface(g, gp, G) {
  g.fillStyle = '#131a23';
  for (const br of G.branches || []) {                   // side roads first, the main road on top
    const BL = [], BR = [];
    for (let s2 = 0; s2 <= br.len; s2 += 1.5) {
      const li = laneInfo(pathAt(s2, br.pts).seg.w, br.pts[1].dir), w = li.width;
      const left = li.bwd ? -li.fwd * w : -li.fwd * w / 2, right = li.bwd ? li.bwd * w : li.fwd * w / 2;
      BL.push(br.at(s2, left - 0.6)); BR.push(br.at(s2, right + 0.6));
    }
    const q = clipPath([...BL, ...BR.reverse()], gp); if (q) g.fill(q);
  }
  const L = G.samples.map(sm => sm.toCar(sm.leftS - 0.6)), R = G.samples.map(sm => sm.toCar(sm.rightS + 0.6));
  const q = clipPath([...L, ...R.reverse()], gp); if (q) g.fill(q);
  // roundabout islands sit on top of the ring road
  for (const r of G.rbts || []) {
    const isl = clipPath(r.poly, gp); if (!isl) continue;
    g.fillStyle = '#0a0e13'; g.fill(isl);
    g.strokeStyle = 'rgba(232,238,245,.16)'; g.lineWidth = 1.5; g.stroke(isl);
  }
}

/** Lane lines: solid edges, dashed lane dividers and centre line. dashLen grows in warp.
 *  Each solid line is one continuous strip, each dash one shape with exact ends, so there are no joins to see. */
function osmDrawLines(g, gp, G, dist, dashLen, fade) {
  const period = 10.5, S = G.samples;
  if (S.length < 2) return;
  const base = g.fillStyle;
  // fade into the distance with a vertical gradient (screen y depends only on z)
  const grads = new Map();
  const fill = a => {
    if (!grads.has(a)) {
      const yN = gp(0, 0.8)[1], yF = gp(0, 150)[1], gr = g.createLinearGradient(0, yN, 0, yF);
      for (const z of [0.8, 10, 25, 50, 80, 110, 140, 150]) {
        const t = (gp(0, z)[1] - yN) / ((yF - yN) || 1);
        gr.addColorStop(Math.max(0, Math.min(1, t)), withAlpha(base, a * fade(z)));
      }
      grads.set(a, gr);
    }
    return grads.get(a);
  };
  const grid = S.map(x => x.s);
  const strip = (o, hw, sA, sB, at = G.at, steps = grid) => {   // polygon along a road between arc lengths sA..sB
    const L = [], R = [];
    const pts = [sA, ...steps.filter(s => s > sA && s < sB), sB];
    for (const s of pts) { L.push(at(s, o - hw)); R.push(at(s, o + hw)); }
    return clipPath([...L, ...R.reverse()], gp);
  };
  // zebra crossings: white bars across the road, each ~0.5 m wide and 3 m long
  g.fillStyle = fill(0.8);
  for (const f of G.feats || []) if (f.kind === 'zebra')
    for (let o = f.left + 0.3; o < f.right - 0.2; o += 1.0) { const q = strip(o + 0.25, 0.25, f.s - 1.5, f.s + 1.5); if (q) g.fill(q); }
  // give-way line where the road joins a roundabout: short thick dashes across our side
  for (const f of G.feats || []) if (f.kind === 'giveway')
    for (let o = f.left + 0.25; o < f.right - 0.3; o += 0.9) { const q = strip(o + 0.3, 0.3, f.s - 0.18, f.s + 0.18); if (q) g.fill(q); }
  // mini-roundabout: a painted white disc in the middle of the junction
  g.fillStyle = fill(0.5);
  for (const f of G.feats || []) if (f.kind === 'mini') {
    const poly = []; for (let a = 0; a < 20; a++) poly.push(G.at(f.s + Math.cos(a * Math.PI / 10) * 1.1, Math.sin(a * Math.PI / 10) * 1.1));
    const q = clipPath(poly, gp); if (q) g.fill(q);
  }
  // offsets that vary along the road: interpolate a per-sample value at any arc length
  const idx = sv => { let lo = 0, hi = S.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m].s < sv) lo = m; else hi = m; } return [lo, hi, Math.max(0, Math.min(1, (sv - S[lo].s) / ((S[hi].s - S[lo].s) || 1)))]; };
  const lerpOf = get => sv => { const [i, j, f] = idx(sv); return get(S[i]) * (1 - f) + get(S[j]) * f; };
  const has = (get, sv) => { const [i, j, f] = idx(sv); return f < 0.5 ? get(S[i]) : get(S[j]); };
  const stripF = (oF, hw, sA, sB) => strip(0, hw, sA, sB, (sv, o) => G.at(sv, oF(sv) + o));
  const sA0 = S[0].s, sB0 = S[S.length - 1].s;
  const kerbL = lerpOf(x => x.leftS), kerbR = lerpOf(x => x.rightS);
  // kerbs: continuous, with a gap where a side road joins on that side
  for (const [oF, side, a] of [[kerbL, -1, 0.28], [kerbR, 1, 0.24]]) {
    g.fillStyle = fill(a);
    const gaps = (G.branches || []).filter(br => br.side === side).map(br => [br.sJ - br.half - 1.5, br.sJ + br.half + 1.5]).sort((x, y) => x[0] - y[0]);
    let from = sA0;
    for (const [g0, g1] of [...gaps, [Infinity, Infinity]]) {
      const to = Math.min(sB0, g0);
      if (to - from > 0.3) { const q = stripF(oF, 0.06, from, to); if (q) g.fill(q); }
      from = Math.max(from, g1);
      if (from >= sB0) break;
    }
  }
  // dashed lines: each has an offset (following the tapered edges) and where it exists
  const two = x => x.li.bwd > 0, lw = x => x.li.width;
  const dashed = [];
  for (let k = 1; k <= 5; k++) {
    // our side: two-way roads count lanes out from the centre line, one-way roads from the left kerb
    dashed.push({ a: 0.9, o: lerpOf(x => two(x) ? -k * lw(x) : x.leftS + k * lw(x)),
      on: x => two(x) ? x.leftS <= -(k + 0.5) * lw(x) : x.leftS + (k + 0.5) * lw(x) <= x.rightS });
    dashed.push({ a: 0.45, o: lerpOf(x => k * lw(x)), on: x => two(x) && x.rightS >= (k + 0.5) * lw(x) });   // oncoming lanes
  }
  dashed.push({ a: 0.9, o: () => 0, on: two });                                                            // centre line
  for (const ln of dashed) {
    if (!S.some(ln.on)) continue;
    g.fillStyle = fill(ln.a);
    for (let d0 = Math.floor((sA0 + dist) / period) * period - dist; d0 < sB0; d0 += period) {
      const sA = Math.max(sA0, d0), sB = Math.min(sB0, d0 + dashLen);
      if (sB - sA < 0.05 || !has(ln.on, sA) || !has(ln.on, sB)) continue;
      const q = stripF(ln.o, 0.07, sA, sB); if (q) g.fill(q);
    }
  }
  // side roads: kerb lines and centre/lane lines, starting just outside the main road
  for (const br of G.branches || []) {
    const li = br.li, w = li.width, left = li.bwd ? -li.fwd * w : -li.fwd * w / 2;
    const steps = []; for (let s2 = 0; s2 <= br.len; s2 += 1.5) steps.push(s2);
    const s0 = br.mainH + 1.5, s1 = br.len;
    if (s1 - s0 < 2) continue;
    const kerbs = [left, li.bwd ? li.bwd * w : left + li.fwd * w];
    g.fillStyle = fill(0.24);
    for (const o of kerbs) { const q = strip(o, 0.06, s0, s1, br.at, steps); if (q) g.fill(q); }
    const inner = [];
    for (let k = 1; k < li.fwd; k++) inner.push(left + k * w);
    if (li.bwd) { inner.push(0); for (let k = 1; k < li.bwd; k++) inner.push(k * w); }
    g.fillStyle = fill(0.55);
    for (const o of inner) for (let d0 = s0 + 1; d0 < s1; d0 += period) {
      const q = strip(o, 0.07, d0, Math.min(s1, d0 + Math.min(dashLen, 4.5)), br.at, steps); if (q) g.fill(q);
    }
  }
  g.fillStyle = base;
}
function withAlpha(col, a) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(col);
  if (m) return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a.toFixed(3)})`;
  const r = /rgba?\(([^)]+)\)/.exec(col);
  if (r) { const [x, y, z] = r[1].split(',').map(Number); return `rgba(${x},${y},${z},${a.toFixed(3)})`; }
  return `rgba(232,238,245,${a.toFixed(3)})`;
}

/** Traffic-light posts and Belisha beacons at the kerbs. gh(X, z, Y) projects a point Y metres above the ground.
 *  OpenStreetMap only says where lights are, not their colour, so the lamps are drawn unlit. */
function osmDrawFeats(g, gh, G, fade) {
  const list = [...(G.feats || [])].sort((a, b) => b.s - a.s);            // far to near
  const blink = Math.floor(performance.now() / 500) % 2 === 0;
  for (const f of list) {
    if (f.kind === 'speedcam' || f.kind === 'redcam') {                   // a camera on a post at the left kerb
      if (SET.cameras === false) continue;
      const [X, z] = G.at(f.s, f.left - 1.2);
      if (z < 0.9) continue;
      const a = fade(z), [bx, by] = gh(X, z, 0), u = gh(X + 1, z, 0)[0] - bx;
      if (u < 0.6) continue;
      g.globalAlpha = a;
      const [, ty] = gh(X, z, 3.2), bw = Math.max(3, u * 0.55), bh = Math.max(2, u * 0.4);
      g.fillStyle = '#5b6672'; g.fillRect(bx - Math.max(1, u * 0.05), ty, Math.max(2, u * 0.1), by - ty);     // pole
      g.fillStyle = '#161b22'; g.strokeStyle = '#6b7785'; g.lineWidth = Math.max(0.8, u * 0.03);
      g.beginPath(); g.roundRect(bx - bw / 2, ty - bh, bw, bh, Math.max(1, u * 0.06)); g.fill(); g.stroke();  // camera box
      g.fillStyle = f.kind === 'redcam' ? 'rgba(255,90,90,.9)' : '#e8eef5';
      g.beginPath(); g.arc(bx, ty - bh / 2, Math.max(1, bh * 0.28), 0, Math.PI * 2); g.fill();              // lens
      continue;
    }
    if (f.kind !== 'lights' && f.kind !== 'zebra') continue;              // only these have posts at the kerb
    for (const o of [f.left - 0.9, f.right + 0.9]) {
      const [X, z] = G.at(f.s, o);
      if (z < 0.9) continue;
      const a = fade(z), [bx, by] = gh(X, z, 0), u = gh(X + 1, z, 0)[0] - bx;   // u = pixels per metre here
      if (u < 0.6) continue;
      g.globalAlpha = a;
      if (f.kind === 'lights') {
        const [, ty] = gh(X, z, 2.4);
        g.fillStyle = '#5b6672'; g.fillRect(bx - Math.max(1, u * 0.06), ty, Math.max(2, u * 0.12), by - ty);        // pole
        const hw = Math.max(3, u * 0.32), [, hy0] = gh(X, z, 3.35), hh = ty - hy0;
        g.fillStyle = '#161b22'; g.strokeStyle = '#6b7785'; g.lineWidth = Math.max(0.8, u * 0.03);
        g.beginPath(); g.roundRect(bx - hw / 2, hy0, hw, hh, Math.max(1, u * 0.06)); g.fill(); g.stroke();
        const r = Math.max(1, hh * 0.12);
        ['rgba(255,70,70,.32)', 'rgba(255,180,40,.32)', 'rgba(70,220,120,.32)'].forEach((c, i) => {
          g.fillStyle = c; g.beginPath(); g.arc(bx, hy0 + hh * (0.2 + i * 0.3), r, 0, Math.PI * 2); g.fill();
        });
      } else {
        const [, ty] = gh(X, z, 2.2), pw = Math.max(1.5, u * 0.1);
        for (let k = 0; k < 6; k++) {                                       // black and white striped pole
          const [, y1] = gh(X, z, 2.2 * k / 6), [, y2] = gh(X, z, 2.2 * (k + 1) / 6);
          g.fillStyle = k % 2 ? '#e8eef5' : '#20252c'; g.fillRect(bx - pw / 2, y2, pw, y1 - y2);
        }
        const [, gy] = gh(X, z, 2.38), gr = Math.max(2, u * 0.2);             // flashing amber globe
        g.save(); if (blink) { g.shadowColor = 'rgba(255,170,40,.9)'; g.shadowBlur = gr * 3; }
        g.fillStyle = blink ? '#ffb02e' : '#7a5a2a'; g.beginPath(); g.arc(bx, gy, gr, 0, Math.PI * 2); g.fill(); g.restore();
      }
    }
  }
  g.globalAlpha = 1;
}

/* ---------------- overlays: limit sign, road name, credit ---------------- */
function osmOverlay() {
  const sign = $('roadSign'), name = $('roadName'), credit = $('osmCredit');
  if (!sign) return;
  const on = osmActive();
  credit.classList.toggle('hidden', !(SET.realRoad || OSM.fixture));
  credit.textContent = OSM.status && SET.realRoad && !OSM.fixture ? `© OpenStreetMap · ${OSM.status}` : '© OpenStreetMap contributors';
  const next = $('roadNext');
  if (!on) { sign.classList.add('hidden'); name.classList.add('hidden'); next?.classList.add('hidden'); if (typeof limitNudge === 'function') limitNudge(null); return; }
  if (next) {
    const isCam = x => x.kind === 'speedcam' || x.kind === 'redcam';
    const ahead = [...(OSM.path.feats || []), ...(OSM.path.rbts || []).map(r => ({ kind: 'rbt', s: r.sIn }))]
      .filter(x => x.s > OSM.sCar + 3 && x.s < OSM.sCar + 300 && !(isCam(x) && SET.cameras === false)).sort((a, b) => a.s - b.s);
    // a camera wins over the lights or junction it sits at
    const f = ahead.find(x => isCam(x) && ahead[0] && x.s - ahead[0].s < 40) || ahead[0];
    next.classList.toggle('hidden', !f);
    const names = { lights: 'Lights', zebra: 'Zebra', rbt: 'Roundabout', mini: 'Mini roundabout', speedcam: 'Speed camera', redcam: 'Red-light camera' };
    // spoken once per camera (only with spoken updates on)
    for (const c of ahead.filter(isCam)) {
      const p = pathAt(c.s), key = `${c.kind}:${Math.round(p.x / 25)}:${Math.round(p.y / 25)}`;
      if (!OSM.said?.has(key)) { (OSM.said ||= new Set()).add(key); if (typeof say === 'function') say(`${names[c.kind]} ahead`); }
    }
    if (f) {
      const m = f.s - OSM.sCar, d = SET.units === 'mph' ? `${Math.max(10, Math.round(m * 1.0936 / 10) * 10)} yd` : `${Math.max(10, Math.round(m / 10) * 10)} m`;
      next.innerHTML = `<i class="rn-${f.kind === 'mini' ? 'rbt' : f.kind}"></i>${names[f.kind]} · ${d}`;
    }
  }
  const li = laneInfo(pathAt(OSM.sCar).seg.w, pathAt(OSM.sCar).seg.dir);
  const lim = li.limit;
  sign.classList.toggle('hidden', !lim);
  if (typeof limitNudge === 'function') limitNudge(lim);
  if (lim) sign.textContent = lim.mph || SET.units !== 'mph' ? lim.v : Math.round(lim.v * 0.621371 / 5) * 5;
  const label = [li.ref, li.name].filter(Boolean).join(' · ');
  name.classList.toggle('hidden', !label);
  name.textContent = label;
}
setInterval(osmOverlay, 500);

/* ---------------- test drive (?roadtest) ----------------
   A made-up network shaped like real OSM data, in London: a 30 mph
   two-way road with bends, a side road, then a 70 mph dual carriageway. */
/** ?roadtest: the demo route (demoroute.js). */
function osmFixtureDrive() { if (typeof drtStart === 'function') drtStart(); }
