'use strict';
/* =====================================================================
   Offline maps (Android app → Settings → Drive screen → Offline maps)
   ---------------------------------------------------------------------
   County map packs, built every week by .github/workflows/maps.yml from OpenStreetMap (maptools/build_pack.py)
   and published on the repo's "maps" release. The Android app downloads a pack (NativeBridge.mapDownload: the
   website can't, because GitHub doesn't allow other sites to fetch release files), serves it to this page at
   /maps/<id>.ldmap, and it's unpacked here into the phone's database, tile by tile (about 2.2 × 2.2 km each).

   After that, osmFetch() asks offmapLoadNear() first: roads in a downloaded county load from the phone, with
   nothing sent anywhere. Outside the downloaded counties the map servers are used as before, unless
   "Only use offline maps" is on.

   Map data © OpenStreetMap contributors, under the ODbL.
   ===================================================================== */

const OFFM = {
  TILE_LAT: 0.02, TILE_LON: 0.032,         // the same as maptools/build_pack.py
  REACH: 900,                              // m around the position, like the map servers' 830 m area
  regions: null,                           // installed packs, from the database
  mem: new Map(),                          // tiles read recently (key → records)
  busy: null,                              // the pack being downloaded or unpacked
};
const offTile = (lat, lon) => `${Math.floor(lat / OFFM.TILE_LAT)},${Math.floor(lon / OFFM.TILE_LON)}`;
const offmapCanDownload = () => typeof window.LeafNative?.mapDownload === 'function';

/* ---------------- the database ---------------- */
async function offStore(mode = 'readonly') { return (await htDb()).transaction('offmap', mode).objectStore('offmap'); }
const offReq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/** The packs on this phone: [{ id, name, built, tiles, bytes, at }]. */
async function offmapRegions() {
  if (OFFM.regions) return OFFM.regions;
  try { OFFM.regions = await offReq((await offStore()).getAll(IDBKeyRange.bound('m|', 'm|￿'))); }
  catch { OFFM.regions = []; }
  return OFFM.regions;
}

async function offmapRemove(id) {
  const meta = (await offmapRegions()).find(r => r.id === id);
  if (!meta) return;
  const db = await htDb();
  await new Promise((res, rej) => {
    const tx = db.transaction('offmap', 'readwrite'), st = tx.objectStore('offmap');
    for (const k of meta.keys || []) st.delete(`t|${k}|${id}`);
    st.delete(`m|${id}`);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
  });
  OFFM.regions = null; OFFM.mem.clear();
}

/** Unpack a pack (gzipped JSON Lines, see build_pack.py) from a URL on this page's own address. */
async function offmapImport(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Couldn't open the downloaded map (${r.status})`);
  const text = r.body.pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream());
  const reader = text.getReader(), db = await htDb();
  let buf = '', head = null, batch = [], keys = [], done = 0;
  const flush = () => new Promise((res, rej) => {
    const tx = db.transaction('offmap', 'readwrite'), st = tx.objectStore('offmap');
    for (const [k, e] of batch) st.put(e, `t|${k}|${head.region}`);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    batch = [];
  });
  const line = async row => {
    if (!row.trim()) return;
    const d = JSON.parse(row);
    if (!head) {
      if (!/^leafdash map pack v1$/.test(d.format || '') || !/^[a-z0-9-]{1,60}$/.test(d.region || '')) throw new Error("That isn't a Leaf Dash map pack.");
      if (d.tile?.[0] !== OFFM.TILE_LAT || d.tile?.[1] !== OFFM.TILE_LON) throw new Error('That map pack is for a different version of the app.');
      head = d;
      await offmapRemove(d.region);                                      // replacing an older copy
      return;
    }
    if (typeof d.k !== 'string' || !Array.isArray(d.e)) return;
    batch.push([d.k, { f: d.f ? 1 : 0, e: d.e }]); keys.push(d.k); done++;
    if (batch.length >= 150) { await flush(); onProgress?.(done, head.tiles); }
  };
  for (;;) {
    const { value, done: end } = await reader.read();
    if (value) buf += value;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const row = buf.slice(0, i); buf = buf.slice(i + 1); await line(row); }
    if (end) break;
  }
  await line(buf);
  if (!head) throw new Error('The map pack was empty.');
  if (batch.length) await flush();
  const meta = { id: head.region, name: head.name, built: head.built, tiles: done, ways: head.ways, keys, at: Date.now() };
  await offReq((await offStore('readwrite')).put(meta, `m|${head.region}`));
  OFFM.regions = null; OFFM.mem.clear();
  return meta;
}

/* ---------------- reading roads ---------------- */
async function offTileRecords(k) {
  if (OFFM.mem.has(k)) return OFFM.mem.get(k);
  const recs = await offReq((await offStore()).getAll(IDBKeyRange.bound(`t|${k}|`, `t|${k}|￿`)));
  OFFM.mem.set(k, recs);
  if (OFFM.mem.size > 12) OFFM.mem.delete(OFFM.mem.keys().next().value);   // keep the last few tiles
  return recs;
}

/** Turn a pack's compact element back into what the map servers return, for osmLoad(). */
function offExpand(e) {
  if (e.w != null) { const geometry = []; for (let i = 0; i < e.g.length; i += 2) geometry.push({ lat: e.g[i], lon: e.g[i + 1] }); return { type: 'way', id: e.w, nodes: e.n, tags: e.t || {}, geometry }; }
  if (e.p != null) return { type: 'node', id: e.p, lat: e.a, lon: e.o, tags: e.t || {} };
  if (e.r != null) return { type: 'relation', id: e.r, tags: e.t || {}, members: e.m.map(([ref, role, lat, lon]) => ({ type: 'node', ref, role, lat, lon })) };
  return null;
}

/**
 * Load the roads around a position from the downloaded packs. Returns true if every tile around it is fully known
 * (so the map servers aren't needed), false if not. A tile is fully known when it lies entirely inside a downloaded
 * county ("f"), or when two or more downloaded counties share it (a tile on the border between them).
 */
async function offmapLoadNear(lat, lon) {
  if (!(await offmapRegions()).length) return false;
  const dLat = OFFM.REACH / 111320, dLon = OFFM.REACH / (111320 * Math.cos(lat * Math.PI / 180));
  const box = { s: lat - dLat, n: lat + dLat, w: lon - dLon, e: lon + dLon };
  const inBox = (a, o) => a >= box.s && a <= box.n && o >= box.w && o <= box.e;
  const r0 = Math.floor(box.s / OFFM.TILE_LAT), r1 = Math.floor(box.n / OFFM.TILE_LAT);
  const c0 = Math.floor(box.w / OFFM.TILE_LON), c1 = Math.floor(box.e / OFFM.TILE_LON);
  const seen = new Set(), elements = [];
  let covered = true, tiles = 0;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const recs = await offTileRecords(`${r},${c}`);
    if (!recs.some(x => x.f) && recs.length < 2) covered = false;
    if (!recs.length) continue;
    tiles++;
    for (const rec of recs) for (const e of rec.e) {
      const id = (e.w != null ? 'w' + e.w : e.p != null ? 'n' + e.p : 'r' + e.r);
      if (seen.has(id)) continue;
      const near = e.w != null ? (() => { for (let i = 0; i < e.g.length; i += 2) if (inBox(e.g[i], e.g[i + 1])) return true; return false; })()
        : e.p != null ? inBox(e.a, e.o) : e.m.some(m => inBox(m[2], m[3]));
      if (!near) continue;
      seen.add(id);
      const x = offExpand(e); if (x) elements.push(x);
    }
  }
  if (tiles) osmLoad({ elements, offline: true }, true);
  window.LeafDash?.emit('osmc', { op: 'offline', tiles, covered, elements: elements.length });
  return covered;
}

/* ---------------- choosing and downloading counties (Android app) ---------------- */
function offmapNative(fn, ...args) {
  return new Promise((res, rej) => {
    const id = 'm' + Date.now() + Math.random().toString(36).slice(2, 6);
    (window.__leafMapCbs ||= {})[id] = { res, rej };
    try { window.LeafNative[fn](id, ...args); } catch (e) { delete window.__leafMapCbs[id]; rej(e); }
  });
}
// answers from NativeBridge's map calls
window.__leafMapCb = (id, ok, data) => { const w = window.__leafMapCbs?.[id]; if (!w) return; delete window.__leafMapCbs[id]; ok ? w.res(data) : w.rej(new Error(data || 'Failed')); };
window.__leafMapProgress = (name, done, total) => { OFFM.onProgress?.(name, done, total); };

const mb = b => b >= 1e6 ? `${(b / 1e6).toFixed(b >= 1e7 ? 0 : 1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`;

/** Download a county from the "maps" release (native), unpack it here, then delete the downloaded file. */
async function offmapInstall(pack, status) {
  OFFM.busy = pack.id;
  try {
    OFFM.onProgress = (name, done, total) => { if (name === pack.id) status(`Downloading ${mb(done)}${total > 0 ? ` of ${mb(total)}` : ''}…`); };
    const path = await offmapNative('mapDownload', pack.id);
    status('Unpacking…');
    const meta = await offmapImport(path, (n, of) => status(`Unpacking ${Math.round(100 * n / Math.max(1, of))}%…`));
    try { window.LeafNative.mapDelete(pack.id); } catch {}
    log(`Offline map installed: ${meta.name} (${meta.tiles} tiles, map of ${meta.built})`);
    return meta;
  } finally { OFFM.busy = null; OFFM.onProgress = null; }
}

async function offmapSheet() {
  const s = openSheet(`<h3>Offline maps</h3>
    <div class="modal-body">
      <p class="hint">Download the counties you drive in. Their roads then load from the phone: no map server, nothing sent, and it works with no signal. Each one is a few MB; Wi-Fi is best. They're rebuilt from OpenStreetMap every Monday: tap <b>Update</b> to get the latest.</p>
      <div data-off-list><p class="hint">Getting the list…</p></div>
      <p class="hint">Map data © OpenStreetMap contributors, ODbL.</p>
    </div>
    <div class="modal-actions"><button class="btn primary" data-x>Done</button></div>`);
  const list = s.box.querySelector('[data-off-list]');
  let index;
  try { index = JSON.parse(await offmapNative('mapIndex')); }
  catch (e) { list.innerHTML = `<p class="hint">Couldn't get the list of counties: ${esc(e.message)}. Check the internet connection and try again.</p>`; return; }
  const draw = async () => {
    const have = new Map((await offmapRegions()).map(r => [r.id, r]));
    const packs = (index.packs || []).filter(p => /^[a-z0-9-]{1,60}$/.test(p.id));
    packs.sort((a, b) => (have.has(b.id) - have.has(a.id)) || a.name.localeCompare(b.name));
    list.innerHTML = packs.map(p => {
      const h = have.get(p.id), old = h && p.built > h.built;
      return `<div class="row-between off-row" data-id="${esc(p.id)}">
        <div><div>${esc(p.name)}</div><div class="mini" data-st>${h ? `On this phone · map of ${esc(h.built)}${old ? ' · newer one available' : ''}` : mb(p.bytes)}</div></div>
        <div class="off-btns">${h ? `${old ? '<button class="btn ghost small" data-act="get">Update</button>' : ''}<button class="btn ghost small" data-act="rm">Remove</button>` : '<button class="btn ghost small" data-act="get">Download</button>'}</div>
      </div>`;
    }).join('') || '<p class="hint">No counties are available yet.</p>';
  };
  await draw();
  list.addEventListener('click', async e => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const row = b.closest('[data-id]'), id = row.dataset.id, st = row.querySelector('[data-st]');
    if (OFFM.busy) { st.textContent = 'Wait for the other download to finish.'; return; }
    const pack = index.packs.find(p => p.id === id);
    row.querySelectorAll('button').forEach(x => { x.disabled = true; });
    try {
      if (b.dataset.act === 'rm') { await offmapRemove(id); log(`Offline map removed: ${pack.name}`); }
      else await offmapInstall(pack, t => { st.textContent = t; });
      await draw(); offmapSummary();
    } catch (err) {
      st.textContent = `Failed: ${err.message}`;
      row.querySelectorAll('button').forEach(x => { x.disabled = false; });
    }
  });
}

/** The one-line summary under "Offline maps" in Settings. */
async function offmapSummary() {
  const el = document.querySelector('[data-off-n]'); if (!el) return;
  const r = await offmapRegions();
  el.textContent = r.length ? `${r.length} ${r.length === 1 ? 'area' : 'areas'}: ${r.map(x => x.name).join(', ')}` : 'None downloaded';
}
