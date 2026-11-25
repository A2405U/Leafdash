'use strict';
/* =====================================================================
   Drive recorder (Developer mode → Debug)
   ---------------------------------------------------------------------
   Tap Start, drive, tap Stop. Everything the app sees is written to one
   file you can share, so a real drive can be studied (and later replayed)
   away from the car:
     • every car value as it changes, and each new set of cell voltages
     • every adapter request and its reply (only when the reply changes)
     • every GPS fix
     • the OpenStreetMap data the app downloaded for the road drawing
     • what the road drawing matched: road, limit, lanes, next junction
     • the power label, lights, alerts, current tab and the app's log
   The VIN is never recorded. The file does hold your GPS track, so only
   share it with people you trust.

   It is saved to the browser's larger store (IndexedDB) every 5 s and when
   the app goes to the background, so a closed app loses at most a few seconds. The last
   three recordings are kept. They are not part of a backup file.

   File format: JSON Lines (one JSON object per line). Each line has
   k (kind) and t (ms since the start). Kinds: head, d (car data changes),
   cells, elm (adapter command c and reply r, or err), bad (a reply that came
   back broken), link (adapter speed each minute: requests, average and slowest ms, cycle ms), osmc
   (remembered map areas: each lookup and save), gps, osm (map data), osmerr (a failed map download), road,
   app, mode, log, err, end.
   ===================================================================== */

const REC = { on: false, id: 0, t0: 0, seq: 0, buf: [], bytes: 0, lines: 0, last: {}, elm: {}, road: '', app: '',
  cellsAt: 0, km: 0, fix: null, fixes: 0, maps: 0, demo: false, flushing: null, timer: null, wake: null };
const REC_KEEP = 3, REC_MAX_MS = 4 * 3600e3, REC_FLUSH_MS = 5e3;

/* ---------------- storage (IndexedDB, shared with the health trips) ---------------- */
async function recStore(mode = 'readonly') { return (await htDb()).transaction('driverec', mode).objectStore('driverec'); }
const recReq = q => new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
async function recPut(key, val) {
  const db = await htDb();
  await new Promise((res, rej) => { const tx = db.transaction('driverec', 'readwrite'); tx.objectStore('driverec').put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
}
/** Every recording's summary, newest first. */
async function recList() {
  try {
    const st = await recStore(), keys = await recReq(st.getAllKeys());
    const metas = await Promise.all(keys.filter(k => String(k).startsWith('meta:')).map(k => recReq(st.get(k))));
    return metas.filter(Boolean).sort((a, b) => b.id - a.id);
  } catch { return []; }
}
async function recDelete(id) {
  try {
    const st = await recStore('readwrite'), keys = await recReq(st.getAllKeys());
    keys.filter(k => k === `meta:${id}` || String(k).startsWith(`${id}:`)).forEach(k => st.delete(k));
  } catch {}
}
async function recPrune() {
  const list = await recList();
  for (const m of list.slice(REC_KEEP)) await recDelete(m.id);
}
const recMeta = () => ({ id: REC.id, start: new Date(REC.id).toISOString(), end: new Date().toISOString(), minutes: (Date.now() - REC.t0) / 60e3,
  km: REC.km, fixes: REC.fixes, maps: REC.maps, lines: REC.lines, bytes: REC.bytes, demo: REC.demo, chunks: REC.seq, done: !REC.on, reason: REC.reason || null });

/** Write what's waiting to the store, as the next numbered chunk. */
function recFlush() {
  if (!REC.id || !REC.buf.length) return REC.flushing || Promise.resolve();
  const text = REC.buf.join('\n') + '\n', key = `${REC.id}:${String(REC.seq).padStart(5, '0')}`;
  REC.buf = []; REC.seq++;
  const meta = recMeta();
  const run = () => recPut(key, text).then(() => recPut(`meta:${REC.id}`, meta))
    .catch(e => { log('Drive recorder: could not save (' + (e?.message || e) + ')'); if (REC.on) recStop('storage full'); });
  return REC.flushing = (REC.flushing || Promise.resolve()).then(run, run);
}

/* ---------------- writing lines ---------------- */
function recLine(k, o = {}) {
  if (!REC.on) return;
  let s;
  try { s = JSON.stringify({ k, t: Date.now() - REC.t0, ...o }); } catch { return; }
  REC.buf.push(s); REC.bytes += s.length + 1; REC.lines++;
}
const NO_VIN = /^2181$/;                                                  // the VIN request: its reply is never kept

/** Car values that changed since the last line (cells and the VIN are left out). */
function recData() {
  const d = S.data, ch = {};
  for (const [k, v] of Object.entries(d)) {
    if (k === 'cells' || /vin/i.test(k) || typeof v === 'function') continue;
    const j = JSON.stringify(v);
    if (REC.last[k] !== j) { REC.last[k] = j; ch[k] = v ?? null; }
  }
  if (Object.keys(ch).length) recLine('d', ch);
  if (d.cells && d.cellsAt && d.cellsAt !== REC.cellsAt) { REC.cellsAt = d.cellsAt; recLine('cells', { at: d.cellsAt - REC.t0, c: d.cells }); }
}

/** What the road drawing thinks, once a second when it changes. */
function recRoad() {
  let o = { on: !!SET.realRoad, fixture: !!OSM.fixture, matched: !!OSM.path, status: OSM.status || '' };
  try {
    if (OSM.path) {
      const at = pathAt(OSM.sCar), li = laneInfo(at.seg.w, at.seg.dir);
      const ahead = [...(OSM.path.feats || []), ...(OSM.path.rbts || []).map(r => ({ kind: 'rbt', s: r.sIn }))]
        .filter(x => x.s > OSM.sCar + 3 && x.s < OSM.sCar + 300).sort((a, b) => a.s - b.s)[0];
      Object.assign(o, { name: li.name, ref: li.ref, hw: li.hw, limit: li.limit, fwd: li.fwd, bwd: li.bwd,
        next: ahead ? { kind: ahead.kind, m: Math.round(ahead.s - OSM.sCar) } : null,
        turn: OSM.turn ? { d: OSM.turn.d ?? null } : null, branches: (OSM.path.branches || []).length, corr: Math.round(OSM.corr * 10) / 10 });
    }
  } catch {}
  const j = JSON.stringify(o);
  if (j !== REC.road) { REC.road = j; recLine('road', o); }
}

/** What the app is showing, once a second when it changes. */
function recApp() {
  const o = { view: S.view, mode: S.mode };
  try { o.power = powerState(S.data).text; } catch {}
  try { const L = carLights(S.data); o.lights = Object.keys(L).filter(k => L[k]).join(' '); } catch {}
  try { const sp = currentSpeed(); o.speedSrc = sp.src; } catch {}
  try { o.alert = $('alertBar')?.classList.contains('hidden') ? '' : ($('alertBar')?.textContent || '').trim().slice(0, 120); } catch {}
  try { const e = recentEffKm(); o.rangeEff = e == null ? null : Math.round(e * 100) / 100; } catch {}
  o.visible = document.visibilityState;
  const j = JSON.stringify(o);
  if (j !== REC.app) { REC.app = j; recLine('app', o); }
}

function recTick() {
  if (!REC.on) return;
  if (S.mode === 'demo') REC.demo = true;
  recData(); recRoad(); recApp();
  if (Date.now() - (REC.linkAt || REC.t0) > 60e3) { REC.linkAt = Date.now(); const st = S.elm?.takeStats?.(); if (st) recLine('link', { ...st, cycleMs: POLL.cycleMs }); }
  if (Date.now() - REC.t0 > REC_MAX_MS) recStop('time limit');
  recCard();
}

/* ---------------- start / stop ---------------- */
async function recStart() {
  if (REC.on) return;
  const now = Date.now();
  Object.assign(REC, { on: true, id: now, t0: now, seq: 0, buf: [], bytes: 0, lines: 0, last: {}, elm: {}, road: '', app: '',
    cellsAt: 0, km: 0, fix: null, fixes: 0, maps: 0, demo: S.mode === 'demo', flushing: null, reason: null, bad: 0 });
  const settings = { ...SET }; delete settings.addons; delete settings.carImage;
  const chrome = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || null;
  recLine('head', { format: 'leafdash drive recording v1', app: LeafDash.version, start: new Date(now).toISOString(), tzOffsetMin: new Date().getTimezoneOffset(),
    mode: S.mode, screen: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio }, chrome, settings,
    note: 'The VIN is never recorded. GPS track included.' });
  recData();
  if (typeof startGps === 'function') startGps();                            // GPS even when not connected
  try { REC.wake = await navigator.wakeLock?.request('screen'); } catch {}  // keep the screen on while recording
  REC.timer = setInterval(recTick, 1000);
  REC.flushTimer = setInterval(recFlush, REC_FLUSH_MS);
  await recFlush();
  log('Drive recorder: started');
  recCard();
}

async function recStop(reason = 'stopped') {
  if (!REC.on) return;
  recTick();
  recLine('end', { reason, km: REC.km, fixes: REC.fixes, maps: REC.maps });
  REC.on = false; REC.reason = reason;
  clearInterval(REC.timer); clearInterval(REC.flushTimer);
  try { await REC.wake?.release(); } catch {}
  REC.wake = null;
  await recFlush();
  await recPrune();
  log(`Drive recorder: stopped (${reason}), ${(REC.bytes / 1e6).toFixed(1)} MB`);
  recCard();
}

/* ---------------- what gets recorded ---------------- */
LeafDash.on('data', () => { if (REC.on) recData(); });
LeafDash.on('mode', m => { if (REC.on) { recLine('mode', { m }); if (m === 'demo') REC.demo = true; } });
LeafDash.on('log', m => { if (REC.on && !/^Drive recorder/.test(m)) recLine('log', { m }); });
LeafDash.on('elm', ({ c, r, err }) => {
  if (!REC.on) return;
  const cmd = String(c).toUpperCase().replace(/\s+/g, '');
  if (NO_VIN.test(cmd)) return;
  if (err) { recLine('elm', { c: cmd, err }); REC.elm[cmd] = null; return; }   // no reply (timed out)
  if (REC.elm[cmd] === r) return;                                          // only when the reply changed
  REC.elm[cmd] = r;
  recLine('elm', { c: cmd, r });
});
LeafDash.on('gps', f => {
  if (!REC.on) return;
  REC.fixes++;
  if (REC.fix && (f.acc == null || f.acc < 50)) {
    const m = haversine(REC.fix.lat, REC.fix.lon, f.lat, f.lon);
    if (m < 500) REC.km += m / 1000;
  }
  if (f.acc == null || f.acc < 50) REC.fix = f;
  recLine('gps', f);
});
// replies that came back broken (pieces missing, NO DATA…): kept, up to 3000 a drive, to see what goes wrong
LeafDash.on('badreply', ({ why, text }) => {
  if (!REC.on || (REC.bad = (REC.bad || 0) + 1) > 3000) return;
  if (/6181/.test(String(text).replace(/\s+/g, ''))) return;                // could be the VIN reply: never kept
  recLine('bad', { why, text });
});
LeafDash.on('osmerr', e => { if (REC.on) recLine('osmerr', e); });
LeafDash.on('osmc', e => { if (REC.on) recLine('osmc', e); });              // remembered map areas: lookups and saves
LeafDash.on('osm', json => { if (REC.on) { REC.maps++; recLine('osm', { json }); } });
window.addEventListener('error', e => recLine('err', { m: String(e.message || e), src: e.filename ? `${e.filename.split('/').pop()}:${e.lineno}` : null }));
window.addEventListener('unhandledrejection', e => recLine('err', { m: 'promise: ' + String(e.reason?.message || e.reason) }));
document.addEventListener('visibilitychange', () => {
  if (!REC.on) return;
  recApp();
  if (document.visibilityState === 'visible' && !REC.wake) navigator.wakeLock?.request('screen').then(w => { REC.wake = w; }).catch(() => {});
  else if (document.visibilityState === 'hidden') { REC.wake = null; recFlush(); }   // Chrome drops the wake lock when hidden
});
// Closing the app: write what's waiting, so the recording is kept up to the last moment.
window.addEventListener('pagehide', () => {
  if (!REC.on) return;
  recLine('end', { reason: 'app closed', km: REC.km, fixes: REC.fixes, maps: REC.maps });
  REC.on = false; REC.reason = 'app closed';
  clearInterval(REC.timer); clearInterval(REC.flushTimer);
  recFlush();
});

/* ---------------- sharing a recording ---------------- */
async function recFile(id) {
  const st = await recStore(), keys = (await recReq(st.getAllKeys())).filter(k => String(k).startsWith(`${id}:`)).sort();
  const parts = [];
  for (const k of keys) parts.push(await recReq((await recStore()).get(k)));
  if (!parts.length) throw new Error('That recording is no longer on this phone.');
  const d = new Date(id), p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  let blob = new Blob(parts, { type: 'application/x-ndjson' }), name = `leafdash-drive-${stamp}.jsonl`;
  if (typeof CompressionStream === 'function') {                         // usually about a tenth of the size
    try { blob = await new Response(blob.stream().pipeThrough(new CompressionStream('gzip'))).blob(); name += '.gz'; } catch {}
  }
  return new File([blob], name, { type: name.endsWith('.gz') ? 'application/gzip' : 'application/x-ndjson' });
}
async function recShare(id) {
  try {
    if (REC.on && REC.id === id) await recFlush();
    const file = await recFile(id);
    if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: file.name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
  } catch (e) { log('Drive recorder: ' + e.message); }
}

/* ---------------- Debug card ---------------- */
const recSize = b => b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`;
const recDist = km => isMph() ? `${(km * 0.621371).toFixed(1)} mi` : `${km.toFixed(1)} km`;
function recCard() {
  const pill = $('recStatus'); if (!pill) return;
  const min = Math.floor((Date.now() - REC.t0) / 60e3);
  pill.textContent = REC.on ? `Recording · ${min} min · ${recSize(REC.bytes)}` : 'Off';
  pill.className = 'pill ' + (REC.on ? 'rec' : '');
  $('recBtn').textContent = REC.on ? 'Stop recording' : 'Start recording';
  $('recBtn').className = 'btn small ' + (REC.on ? 'danger' : 'primary');
  $('recRoadOff').classList.toggle('hidden', !!SET.realRoad);
  $('recDot')?.classList.toggle('hidden', !REC.on);
  if (!REC.on || !REC.listAt || Date.now() - REC.listAt > 15e3) recPast();
}
async function recPast() {
  REC.listAt = Date.now();
  const box = $('recPast'); if (!box) return;
  const list = await recList();
  $('recPastLabel').classList.toggle('hidden', !list.length);
  box.innerHTML = list.map(m => {
    const live = REC.on && m.id === REC.id;
    const what = [recDist(m.km || 0), recSize(live ? REC.bytes : m.bytes || 0), m.demo ? 'demo' : '', live ? 'recording' : m.reason === 'app closed' ? 'app closed' : ''].filter(Boolean).join(' · ');
    return `<div class="chg-row rec-row">
      <span class="chg-when"><b>${esc(htWhen(m.start))}</b><span class="mini">${esc(what)}</span></span>
      <span class="chg-mid">${Math.round(live ? (Date.now() - REC.t0) / 60e3 : m.minutes || 0)} min</span>
      <span class="chg-cost">${live ? '' : `<button class="btn ghost small" data-rec-play="${m.id}">Replay</button> `}<button class="btn ghost small" data-rec-share="${m.id}">Share</button>${live ? '' : ` <button class="btn ghost small" data-rec-del="${m.id}" aria-label="Delete recording">✕</button>`}</span></div>`;
  }).join('');
}
$('recBtn')?.addEventListener('click', () => REC.on ? recStop('stopped') : recStart());
$('recRoadOn')?.addEventListener('click', () => openSettings('drive'));
$('rpOpen')?.addEventListener('click', () => $('rpFile').click());
$('rpFile')?.addEventListener('change', e => { const f = e.target.files?.[0]; e.target.value = ''; if (f && typeof rpFromFile === 'function') rpFromFile(f); });
$('recPast')?.addEventListener('click', async e => {
  const pl = e.target.closest('[data-rec-play]');
  if (pl && typeof rpFromRecording === 'function') { pl.disabled = true; pl.textContent = 'Loading…'; await rpFromRecording(+pl.dataset.recPlay); pl.disabled = false; pl.textContent = 'Replay'; return; }
  const s = e.target.closest('[data-rec-share]');
  if (s) { s.disabled = true; s.textContent = 'Packing…'; await recShare(+s.dataset.recShare); s.disabled = false; s.textContent = 'Share'; return; }
  const d = e.target.closest('[data-rec-del]');
  if (d && await confirmSheet({ title: 'Delete this recording?', body: '<p>It will be removed from this phone. This can\'t be undone.</p>', ok: 'Delete', danger: true })) { await recDelete(+d.dataset.recDel); recPast(); }
});
$('recDot')?.addEventListener('click', () => showView('debug'));
// A recording cut off by the app closing is finished off on the next start, so it shows and can be shared.
LeafDash.on('ready', async () => {
  for (const m of await recList()) if (!m.done && !(REC.on && m.id === REC.id)) await recPut(`meta:${m.id}`, { ...m, done: true, reason: m.reason || 'app closed' }).catch(() => {});
  recCard();
});
