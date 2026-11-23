'use strict';
/* =====================================================================
   Drive replay (Developer mode → Debug → Drive recorder → Replay)
   ---------------------------------------------------------------------
   Plays a drive recording back in Demo mode, so a real drive can be
   watched and tested at home:
     • the GPS track drives the road drawing exactly as it did in the car
     • the map data saved in the recording is used (nothing is downloaded)
     • the car's values (speed, power, gear, cells, lights) follow the drive
   Controls: pause, 1× / 2× / 4× / 8×, a slider to jump around, and two
   test buttons: lose GPS for 15 s, and jump to the next junction.

   It's Demo mode, so nothing is sent to add-ons, nothing is saved to the
   history, and the driving lock doesn't apply. Part 2 of the navigation plan.
   ===================================================================== */

const RP = { on: false, lines: [], name: '', dur: 0, t: 0, idx: 0, rate: 1, playing: true, lostUntil: -1, timer: null, last: 0 };
const rpRate = () => (RP.on && RP.playing ? RP.rate : RP.on ? 0 : 1);   // drive.js scales the scroll by this
const rpClock = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Turn a recording (text, or a .gz file's bytes) into its lines. */
async function rpParse(blob, name = '') {
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) {                            // gzip
    if (typeof DecompressionStream !== 'function') throw new Error("This browser can't unpack .gz files.");
    blob = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
  }
  const lines = [];
  for (const row of (await blob.text()).split('\n')) {
    if (!row.trim()) continue;
    try { lines.push(JSON.parse(row)); } catch {}
  }
  if (lines[0]?.k !== 'head' || !/leafdash drive recording/.test(lines[0].format || '')) throw new Error(`${name || 'That file'} isn't a Leaf Dash drive recording.`);
  return lines;
}

/* ---------------- playing ---------------- */
function rpApply(l) {
  const d = S.data;
  switch (l.k) {
    case 'd': for (const [k, v] of Object.entries(l)) if (k !== 'k' && k !== 't') d[k] = v; break;
    case 'cells': d.cells = l.c; d.cellsAt = Date.now(); break;
    case 'app': if (typeof l.lights === 'string') { const on = new Set(l.lights.split(' ').filter(Boolean)); d.demoLights = { tail: on.has('tail'), low: on.has('low'), high: on.has('high'), brake: on.has('brake'), fog: on.has('fog'), indL: on.has('indL'), indR: on.has('indR'), reverse: on.has('reverse') }; } break;
    case 'osm': if (l.json && OSM.O) osmLoad(l.json); break;
    case 'gps':
      if (RP.t < RP.lostUntil || l.lat == null) break;                    // "lose GPS" test
      if (!OSM.O) OSM.O = { lat: l.lat, lon: l.lon };
      if (!OSM.ways.size) rpReloadMaps();                                 // the road drawing started over (far from its origin): give it the map again
      osmOnFix(l.lat, l.lon, l.hdg ?? null, l.spd ?? null, true);
      break;
  }
}
/** Load every map download from the start of the recording up to now. */
function rpReloadMaps() {
  for (let i = 0; i < RP.idx && i < RP.lines.length; i++) if (RP.lines[i].k === 'osm' && RP.lines[i].json) osmLoad(RP.lines[i].json);
}

function rpTick() {
  const now = performance.now(), dt = Math.min(0.5, (now - RP.last) / 1000); RP.last = now;
  if (!RP.on) return;
  if (RP.playing) RP.t = Math.min(RP.dur, RP.t + dt * 1000 * RP.rate);
  let n = 0;
  while (RP.idx < RP.lines.length && RP.lines[RP.idx].t <= RP.t) { rpApply(RP.lines[RP.idx++]); n++; }
  if (n) { S.lastUpdate = Date.now(); render(); LeafDash.emit('data', S.data); }
  if (RP.t >= RP.dur && RP.playing) { RP.playing = false; rpBar(); }
  rpBarTime();
}

/** Jump to a time: rebuild the car's values and the map as they were then. */
function rpSeek(t) {
  RP.t = Math.max(0, Math.min(RP.dur, t));
  S.data = {};
  const firstFix = RP.lines.find(l => l.k === 'gps' && l.t >= RP.t) || RP.lines.find(l => l.k === 'gps');
  OSM.O = firstFix ? { lat: firstFix.lat, lon: firstFix.lon } : null;
  OSM.ways.clear(); OSM.nodeWays.clear(); OSM.feats.clear(); OSM.path = null; OSM.match = null; OSM.Hs = null; OSM.prevFixAt = 0; OSM.turn = null; OSM.carOffS = null;
  RP.idx = 0;
  while (RP.idx < RP.lines.length && RP.lines[RP.idx].t <= RP.t) {
    const l = RP.lines[RP.idx++];
    if (l.k === 'gps') continue;                                         // only the last fix matters: sent below
    rpApply(l);
  }
  let i = RP.idx - 1; while (i >= 0 && RP.lines[i].k !== 'gps') i--;
  if (i >= 0) rpApply(RP.lines[i]);
  S.lastUpdate = Date.now(); render();
  rpBarTime();
}

async function rpStart(lines, name) {
  if (S.mode === 'on' || S.mode === 'busy') disconnect();
  if (S.mode === 'demo') { stopDemo(); drtStop(); }
  const gps = lines.filter(l => l.k === 'gps');
  if (!gps.length) throw new Error('That recording has no GPS track to replay.');
  Object.assign(RP, { on: true, lines, name, dur: lines[lines.length - 1].t, t: 0, idx: 0, rate: 1, playing: true, lostUntil: -1, last: performance.now() });
  S.replay = RP;
  OSM.fixture = true;
  setMode('demo');
  $('status').querySelector('span').textContent = 'Replay';
  rpSeek(0);
  RP.timer = setInterval(rpTick, 100);
  showView('drive');
  rpBar();
  log(`Replay started: ${name}`);
}

function rpStop() {
  if (!RP.on) return;
  clearInterval(RP.timer);
  RP.on = false; S.replay = null; RP.lines = [];
  OSM.fixture = false; OSM.path = null; OSM.ways.clear(); OSM.nodeWays.clear(); OSM.feats.clear(); OSM.O = null;
  rpBar();
}

/* ---------------- test buttons ---------------- */
function rpLoseGps() { RP.lostUntil = RP.t + 15000; rpBar(); }

/** Jump to just before the next junction, roundabout, lights or zebra ahead on the road being drawn. */
function rpNextJunction() {
  if (!OSM.path) return rpNote('No road matched yet, so there is no junction ahead to jump to.');
  const s0 = OSM.sCar + 15;
  const ahead = [
    ...(OSM.path.branches || []).map(b => b.sJ), ...(OSM.path.feats || []).map(f => f.s), ...(OSM.path.rbts || []).map(r => r.sIn),
  ].filter(s => s > s0).sort((a, b) => a - b)[0];
  if (ahead == null) return rpNote('Nothing ahead on this stretch of road.');
  const P = pathAt(ahead);
  const hit = RP.lines.find(l => l.k === 'gps' && l.t > RP.t && (() => { const q = toXY(l.lat, l.lon); return Math.hypot(q.x - P.x, q.y - P.y) < 20; })());
  if (!hit) return rpNote("The drive doesn't reach that junction.");
  rpSeek(hit.t - 6000);                                                   // arrive six seconds before it
}
function rpNote(text) { const n = { text }; alertNotice(n); setTimeout(() => { if (AL.notice === n) alertNotice(null); }, 4000); }

/* ---------------- control bar ---------------- */
function rpBar() {
  let el = $('rpBar');
  if (!el) {
    el = document.createElement('div'); el.id = 'rpBar'; el.className = 'rp-bar hidden';
    document.body.appendChild(el);
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-rp]'); if (!b) return;
      const a = b.dataset.rp;
      if (a === 'play') { if (RP.t >= RP.dur) rpSeek(0); RP.playing = !RP.playing; }
      else if (a === 'stop') { setMode('off'); return; }
      else if (a === 'lost') rpLoseGps();
      else if (a === 'next') rpNextJunction();
      else if (a.startsWith('x')) RP.rate = +a.slice(1);
      rpBar();
    });
    el.addEventListener('input', e => { if (e.target.matches('.rp-seek')) rpSeek(+e.target.value); });
  }
  el.classList.toggle('hidden', !RP.on || S.view !== 'drive');
  $('demoFab')?.classList.toggle('hidden', RP.on || S.mode !== 'demo');
  if (!RP.on) return;
  el.innerHTML = `
    <div class="rp-row">
      <button class="btn ghost small" data-rp="play" aria-label="${RP.playing ? 'Pause' : 'Play'}">${RP.playing ? '❚❚' : '▶'}</button>
      <span class="rp-time"></span>
      <div class="seg">${[1, 2, 4, 8].map(x => `<button data-rp="x${x}" class="${RP.rate === x ? 'active' : ''}">${x}×</button>`).join('')}</div>
      <button class="btn ghost small" data-rp="stop" aria-label="Stop replay">✕</button>
    </div>
    <input type="range" class="rp-seek" min="0" max="${RP.dur}" step="1000" value="${RP.t}" aria-label="Position in the drive">
    <div class="rp-row">
      <button class="btn ghost small" data-rp="lost">${RP.t < RP.lostUntil ? 'GPS lost…' : 'Lose GPS 15 s'}</button>
      <button class="btn ghost small" data-rp="next">Next junction ▶</button>
    </div>`;
  rpBarTime();
}
function rpBarTime() {
  const el = $('rpBar'); if (!el || !RP.on) return;
  const tm = el.querySelector('.rp-time'); if (tm) tm.textContent = `${rpClock(RP.t)} / ${rpClock(RP.dur)}`;
  const sk = el.querySelector('.rp-seek'); if (sk && document.activeElement !== sk) sk.value = RP.t;
  const lost = el.querySelector('[data-rp=lost]'); if (lost) lost.textContent = RP.t < RP.lostUntil ? 'GPS lost…' : 'Lose GPS 15 s';
}

/* ---------------- starting a replay ---------------- */
async function rpFromRecording(id) {
  try {
    if (typeof REC !== 'undefined' && REC.on && REC.id === id) return rpNote('Stop the recording before replaying it.');
    const file = await recFile(id);
    await rpStart(await rpParse(file, file.name), file.name);
  } catch (e) { rpNote(e.message); }
}
async function rpFromFile(file) {
  try { await rpStart(await rpParse(file, file.name), file.name); } catch (e) { rpNote(e.message); }
}

LeafDash.on('mode', m => { if (m !== 'demo' && RP.on) rpStop(); });
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => setTimeout(rpBar, 0)));
