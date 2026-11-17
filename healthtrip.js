'use strict';
/* =====================================================================
   Health trip recording (Developer mode)
   ---------------------------------------------------------------------
   Arm it, then drive. The trip starts when the car moves, and ends after
   3 minutes parked in P, when you disconnect, or when you tap Stop.
   During the trip cell voltages are read every ~2 s (instead of 10 s)
   so the report can estimate internal resistance per cell.

   Everything is read-only, recorded on the phone, and only leaves it if
   you share the report or raw log.
   ===================================================================== */

const HT = { armed: false, on: false, t0: 0, samples: [], cells: [], parkedSince: 0, report: null, lastCellsAt: 0, meta: {}, savedAt: 0 };
const HT_MAX_MS = 3 * 3600e3;

/* ---------------- keeping reports ----------------
   A finished report used to live only on screen, so closing the app lost it. Now the last ten
   reports are kept in this browser (localStorage, included in backups) and can be reopened from
   the Debug tab. The raw logs are much bigger, so only the last three are kept, in the browser's
   larger store (IndexedDB), and they are not part of a backup file.
   While a trip is recording it is saved once a minute, so a closed or killed app loses at most
   the last minute. Demo trips are never kept. */
const HT_KEY = 'leafdash.healthtrips';
const htTrips = () => { try { return JSON.parse(localStorage.getItem(HT_KEY)) || []; } catch { return []; } };
function htTripsSave(list) {
  if (window.LD_RESTORING) return;
  try { localStorage.setItem(HT_KEY, JSON.stringify(list.slice(-10))); } catch {}
}
const htDb = () => new Promise((res, rej) => {
  const r = indexedDB.open('leafdash', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('healthraw');
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
async function htRawPut(id, text) {
  try {
    const db = await htDb();
    await new Promise((res, rej) => { const tx = db.transaction('healthraw', 'readwrite'); tx.objectStore('healthraw').put(text, String(id)); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  } catch {}
}
async function htRawGet(id) {
  try {
    const db = await htDb();
    return await new Promise((res, rej) => { const q = db.transaction('healthraw').objectStore('healthraw').get(String(id)); q.onsuccess = () => res(q.result ?? null); q.onerror = () => rej(q.error); });
  } catch { return null; }
}
async function htRawPrune(keep) {
  try {
    const db = await htDb(), st = db.transaction('healthraw', 'readwrite').objectStore('healthraw');
    const q = st.getAllKeys();
    q.onsuccess = () => q.result.forEach(k => { if (!keep.includes(String(k))) st.delete(k); });
  } catch {}
}
/** Save the trip as it stands: the report into the list, the raw log into the larger store. */
function htSave(final) {
  if (S.mode === 'demo' || S.demoHealth || !HT.t0) return;
  const report = final ? HT.report : htAnalyse();
  if (!report || HT.samples.length <= 20) return;
  const list = htTrips().filter(t => t.id !== HT.t0);
  list.push({ id: HT.t0, meta: { ...HT.meta, end: HT.meta.end || new Date().toISOString() }, report, partial: !final, seen: false });
  list.sort((a, b) => a.id - b.id);
  htTripsSave(list);
  HT.savedAt = Date.now();
  htRawPut(HT.t0, htRawText(report)).then(() => htRawPrune(htTrips().slice(-3).map(t => String(t.id))));
}

function htArm(on) {
  HT.armed = on;
  if (!on && HT.on) htStop('stopped');
  htCard();
}

function htStart() {
  const d = S.data;
  Object.assign(HT, { on: true, t0: Date.now(), samples: [], cells: [], parkedSince: 0, lastCellsAt: 0, report: null,
    meta: { start: new Date().toISOString(), soc0: d.soc, ahr: d.ahr, soh: d.soh, hx: d.hx, odo0: d.odoKm, ambient: d.ambient } });
  log('Health trip: recording started');
  htCard();
}

function htStop(reason) {
  if (!HT.on) return;
  HT.on = false; HT.armed = false;
  HT.meta.end = new Date().toISOString(); HT.meta.reason = reason;
  HT.meta.soc1 = S.data.soc; HT.meta.odo1 = S.data.odoKm;
  HT.report = htAnalyse();
  log(`Health trip: finished (${reason}), ${HT.samples.length} samples, ${HT.cells.length} cell snapshots`);
  htSave(true);
  htCard();
  if (HT.samples.length > 20) htShowReport();
}

/* sample on every live update */
LeafDash.on('data', () => {
  if (S.mode !== 'on' && !S.demoHealth) return;
  const d = S.data, now = Date.now();
  const moving = (d.speed ?? 0) > 5 || ['D', 'B', 'R'].includes(d.gear);
  if (HT.armed && !HT.on && moving) htStart();
  if (!HT.on) return;
  const last = HT.samples[HT.samples.length - 1];
  if (!last || now - last.t >= 400) {
    const temps = (d.temps || []).filter(x => x != null);
    HT.samples.push({ t: now, soc: d.soc, v: d.voltage, i: d.current, kw: d.kw, spd: d.speed ?? null,
      bt: temps.length ? Math.max(...temps) : null, amb: d.ambient ?? null, aux: d.aux ?? null, heat: d.heaterKw ?? null, gear: d.gear });
  }
  if (d.cells && d.cellsAt && d.cellsAt !== HT.lastCellsAt) {
    HT.lastCellsAt = d.cellsAt;
    HT.cells.push({ t: d.cellsAt, i: d.current, v: d.voltage, c: d.cells.slice() });
  }
  // end: parked in P for 3 minutes, or too long
  if (d.gear === 'P' && (d.speed ?? 0) < 1) { HT.parkedSince ||= now; if (now - HT.parkedSince > 180e3) htStop('parked'); }
  else HT.parkedSince = 0;
  if (now - HT.t0 > HT_MAX_MS) htStop('time limit');
  if (now - (HT.cardAt || 0) > 5000) { HT.cardAt = now; htCard(); }
  if (now - Math.max(HT.savedAt, HT.t0) > 60e3) htSave(false);          // once a minute, so a closed app loses little
});
// Closing the app mid-trip: finish the report now, so it's there next time.
window.addEventListener('pagehide', () => { if (HT.on) { HT.on = false; HT.meta.end = new Date().toISOString(); HT.meta.reason = 'app closed'; HT.meta.soc1 = S.data.soc; HT.report = htAnalyse(); htSave(true); } });
LeafDash.on('mode', m => { if (m === 'off' && HT.on) htStop('disconnected'); });

/* ---------------- analysis ---------------- */
/** Least squares: y = a + b·x (+ c·t). Returns coefficients and r². */
function regress(rows) {
  // rows: [y, x, t]; solves for a, b, c with normal equations (3×3)
  const n = rows.length; if (n < 8) return null;
  let S = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (const [y, x, t] of rows) {
    const v = [1, x, t];
    for (let r = 0; r < 3; r++) { for (let c = 0; c < 3; c++) S[r][c] += v[r] * v[c]; S[r][3] += v[r] * y; }
  }
  for (let i = 0; i < 3; i++) {                          // Gaussian elimination
    let p = i; for (let r = i + 1; r < 3; r++) if (Math.abs(S[r][i]) > Math.abs(S[p][i])) p = r;
    [S[i], S[p]] = [S[p], S[i]];
    if (Math.abs(S[i][i]) < 1e-12) return null;
    for (let r = 0; r < 3; r++) if (r !== i) { const f = S[r][i] / S[i][i]; for (let c = i; c < 4; c++) S[r][c] -= f * S[i][c]; }
  }
  const [a, b, c] = [0, 1, 2].map(i => S[i][3] / S[i][i]);
  const mean = rows.reduce((s, r) => s + r[0], 0) / n;
  let ssT = 0, ssE = 0;
  for (const [y, x, t] of rows) { ssT += (y - mean) ** 2; ssE += (y - (a + b * x + c * t)) ** 2; }
  return { a, b, c, r2: ssT ? 1 - ssE / ssT : 0 };
}

function htAnalyse() {
  const Sm = HT.samples.filter(s => s.v != null && s.i != null), C = HT.cells;
  if (Sm.length < 5) return null;
  const t0 = Sm[0].t, hrs = s => (s.t - t0) / 3600e3;
  let km = 0, used = 0, regen = 0;
  for (let k = 1; k < Sm.length; k++) {
    const dt = (Sm[k].t - Sm[k - 1].t) / 3600e3; if (dt <= 0 || dt > 0.01) continue;
    km += (Sm[k].spd ?? 0) * dt;
    const kw = Sm[k].kw ?? 0; if (kw > 0) used += kw * dt; else regen += -kw * dt;
  }
  // pack resistance: V = a + b·I + c·t  (I positive = discharge, so R = -b)
  const rPack = regress(Sm.map(s => [s.v, s.i, hrs(s)]));
  const iMax = Math.max(...Sm.map(s => s.i)), iMin = Math.min(...Sm.map(s => s.i));
  const peak = Sm.reduce((a, b) => (b.kw ?? 0) > (a.kw ?? 0) ? b : a, Sm[0]);
  const peakRegen = Sm.reduce((a, b) => (b.kw ?? 0) < (a.kw ?? 0) ? b : a, Sm[0]);
  // per-cell resistance (each "cell" is a parallel pair) from cell mV vs pack current
  const perCell = [];
  if (C.length >= 8) {
    for (let k = 0; k < 96; k++) {
      const rows = C.filter(s => s.c[k] != null && s.i != null).map(s => [s.c[k], s.i, (s.t - t0) / 3600e3]);
      const r = regress(rows);
      perCell.push(r ? -r.b : null);                       // mV per A = mΩ
    }
  }
  // spread at rest vs under load, and which cell is lowest under load
  const spread = s => { const v = s.c.filter(Boolean); return v.length ? Math.max(...v) - Math.min(...v) : null; };
  const rest = C.filter(s => Math.abs(s.i ?? 0) < 5).map(spread).filter(x => x != null);
  const load = C.filter(s => (s.i ?? 0) > 40).map(spread).filter(x => x != null);
  const lowCount = Array(96).fill(0);
  C.filter(s => (s.i ?? 0) > 20).forEach(s => { const v = s.c; let m = 0; v.forEach((x, j) => { if (x != null && (v[m] == null || x < v[m])) m = j; }); lowCount[m]++; });
  const lowest = lowCount.map((n, j) => ({ cell: j + 1, n })).filter(x => x.n).sort((a, b) => b.n - a.n).slice(0, 5);
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const bts = Sm.map(s => s.bt).filter(x => x != null);
  const rc = perCell.filter(x => x != null);
  const rcMed = rc.length ? rc.slice().sort((a, b) => a - b)[Math.floor(rc.length / 2)] : null;
  const outliers = perCell.map((r, j) => ({ cell: j + 1, r })).filter(x => x.r != null && rcMed && x.r > rcMed * 1.25).sort((a, b) => b.r - a.r).slice(0, 6);
  return {
    minutes: (Sm[Sm.length - 1].t - Sm[0].t) / 60e3, km, used, regen,
    effKmPerKwh: used - regen > 0.05 ? km / (used - regen) : null,
    soc0: HT.meta.soc0 ?? Sm[0].soc, soc1: HT.meta.soc1 ?? Sm[Sm.length - 1].soc, ahr: HT.meta.ahr, soh: HT.meta.soh, hx: HT.meta.hx,
    rPack: rPack && rPack.r2 > 0.3 ? -rPack.b * 1000 : null, rPackR2: rPack?.r2 ?? null,   // mΩ
    iMax, iMin, peakKw: peak.kw, peakV: peak.v, peakRegenKw: peakRegen.kw,
    sagV: rPack ? -rPack.b * iMax : null,
    perCell, rcMed, outliers,
    spreadRest: avg(rest), spreadLoad: avg(load), spreadMax: Math.max(0, ...C.map(spread).filter(x => x != null)),
    lowest, bt0: bts[0] ?? null, bt1: bts[bts.length - 1] ?? null, btMax: bts.length ? Math.max(...bts) : null,
    nSamples: Sm.length, nCells: C.length,
  };
}

/* ---------------- report ---------------- */
const svgLine = (pts, w, h, col, opts = {}) => {
  if (pts.length < 2) return '';
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = opts.y0 ?? Math.min(...ys), y1 = opts.y1 ?? Math.max(...ys);
  const X = x => ((x - x0) / ((x1 - x0) || 1) * w).toFixed(1), Y = y => (h - (y - y0) / ((y1 - y0) || 1) * h).toFixed(1);
  return `<polyline points="${pts.map(p => `${X(p[0])},${Y(p[1])}`).join(' ')}" fill="none" stroke="${col}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>`;
};
function chart(title, series, unit) {
  const w = 300, h = 90;
  return `<div class="ht-chart"><div class="label">${title}</div>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${series.map(s => svgLine(s.pts, w, h, s.col)).join('')}</svg>
    <div class="ht-legend">${series.map(s => `<span style="color:${s.col}">● ${s.name}</span>`).join(' ')}${unit ? ` <span class="mini">${unit}</span>` : ''}</div></div>`;
}

function htReportHtml(R) {
  const f = (v, dp = 1, u = '') => v == null || Number.isNaN(v) ? '—' : `${(+v).toFixed(dp)}${u}`;
  const mi = SET.units === 'mph';
  const dist = mi ? R.km * 0.621371 : R.km, du = mi ? 'mi' : 'km';
  const eff = R.effKmPerKwh == null ? null : mi ? R.effKmPerKwh * 0.621371 : R.effKmPerKwh;
  const t0 = HT.samples[0]?.t || 0, m = s => (s.t - t0) / 60e3;
  const Sm = HT.samples;
  const verdict = [];
  if (R.spreadMax > 50) verdict.push(`Cell spread reached <b>${R.spreadMax} mV</b>. That's worth keeping an eye on (under ~30 mV is typical).`);
  else verdict.push(`Cell spread stayed within <b>${R.spreadMax} mV</b>, which is good balance.`);
  if (R.outliers.length) verdict.push(`Cell${R.outliers.length > 1 ? 's' : ''} <b>${R.outliers.map(o => o.cell).join(', ')}</b> showed noticeably higher resistance than the pack median.`);
  else if (R.perCell.length) verdict.push('No cells stood out with high resistance.');
  if (R.btMax != null && R.btMax >= 40) verdict.push(`Battery reached <b>${R.btMax} °C</b>, warm enough to limit rapid charging.`);
  const bars = R.perCell.length ? (() => {
    const v = R.perCell, mx = Math.max(...v.filter(x => x != null), 0.001);
    return `<div class="ht-chart"><div class="label">Resistance per cell pair (higher = weaker)</div>
      <div class="ht-bars">${v.map((x, j) => `<i title="cell ${j + 1}: ${f(x, 2)} mΩ" class="${R.outliers.some(o => o.cell === j + 1) ? 'hi' : ''}" style="height:${x == null ? 0 : Math.max(4, x / mx * 100)}%"></i>`).join('')}</div>
      <div class="ht-legend"><span class="mini">1</span><span class="mini">median ${f(R.rcMed, 2)} mΩ</span><span class="mini">96</span></div></div>`;
  })() : '<p class="hint">Not enough cell snapshots for per-cell resistance. Drive a bit longer with some acceleration.</p>';
  return `
    <div class="ht-sum">
      <div><b>${f(dist, 1)}</b><span>${du}</span></div><div><b>${f(R.minutes, 0)}</b><span>minutes</span></div>
      <div><b>${f(eff, 1)}</b><span>${du}/kWh</span></div><div><b>${f(R.soc0, 0)}→${f(R.soc1, 0)}</b><span>% charge</span></div>
    </div>
    <div class="ht-verdict">${verdict.map(v => `<p>${v}</p>`).join('')}</div>
    <div class="ht-kv">
      <div><span>Capacity / SOH</span><b>${f(R.ahr, 2)} Ah · ${f(R.soh, 1)}%</b></div>
      <div><span>Hx</span><b>${f(R.hx, 1)}%</b></div>
      <div><span>Pack resistance</span><b>${f(R.rPack, 0)} mΩ</b></div>
      <div><span>Voltage sag at peak</span><b>${f(R.sagV, 1)} V @ ${f(R.iMax, 0)} A</b></div>
      <div><span>Peak power / regen</span><b>${f(R.peakKw, 0)} / ${f(-R.peakRegenKw, 0)} kW</b></div>
      <div><span>Energy used / regen</span><b>${f(R.used, 2)} / ${f(R.regen, 2)} kWh</b></div>
      <div><span>Cell spread rest / load / max</span><b>${f(R.spreadRest, 0)} / ${f(R.spreadLoad, 0)} / ${R.spreadMax} mV</b></div>
      <div><span>Lowest cell under load</span><b>${R.lowest.length ? R.lowest.map(l => `#${l.cell} (${l.n}×)`).join(', ') : '—'}</b></div>
      <div><span>Battery temp start / end / max</span><b>${f(R.bt0, 0)} / ${f(R.bt1, 0)} / ${f(R.btMax, 0)} °C</b></div>
    </div>
    ${chart('Pack voltage and current', [{ name: 'V', col: '#e8eef5', pts: Sm.filter(s => s.v != null).map(s => [m(s), s.v]) }, { name: 'A', col: '#4cc3ff', pts: Sm.filter(s => s.i != null).map(s => [m(s), s.i]) }], 'over the trip')}
    ${chart('Cell spread', [{ name: 'mV', col: '#ffb84d', pts: HT.cells.map(s => { const v = s.c.filter(Boolean); return [(s.t - t0) / 60e3, Math.max(...v) - Math.min(...v)]; }) }])}
    ${chart('Battery temperature', [{ name: '°C', col: '#ff8a5c', pts: Sm.filter(s => s.bt != null).map(s => [m(s), s.bt]) }])}
    ${bars}
    <p class="hint">Resistance figures are estimates from how voltage drops as current rises during the drive. They're most reliable after a trip with a few firm accelerations. Recorded ${R.nSamples} samples and ${R.nCells} cell snapshots.</p>`;
}

const htWhen = iso => new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const HT_ENDED = { parked: 'ended when parked', stopped: 'stopped by hand', disconnected: 'ended when the adapter disconnected', 'app closed': 'ended when the app was closed', 'time limit': 'ended at the 3 hour limit', demo: 'demo' };

/** Show a report: the one just finished, or a kept one from the list (pass its entry). */
function htShowReport(entry) {
  const cur = { id: HT.t0, meta: HT.meta, report: HT.report };
  const E = entry && entry.report ? entry : cur;
  if (!E.report) return alert('No report yet. Arm it and do a trip first.');
  const s = openSheet(`<div class="row-between"><h3>Battery health trip</h3><button class="btn ghost small" data-x>Close</button></div>
    <p class="hint">${htWhen(E.meta.start)} · ${HT_ENDED[E.meta.reason] || (E.partial ? 'cut short: saved up to the last minute' : E.meta.reason || '')}</p>
    ${htReportHtml(E.report)}
    <div class="modal-actions"><button class="btn ghost" data-a="raw">Share raw log</button><button class="btn primary" data-a="rep">Share report</button></div>`,
    { onClose: () => htMarkSeen(E.id) });
  s.box.querySelector('[data-a=raw]').onclick = () => htShare('raw', E);
  s.box.querySelector('[data-a=rep]').onclick = () => htShare('report', E);
}
/** A report counts as seen once its sheet has been closed by hand. */
function htMarkSeen(id) {
  const list = htTrips(), t = list.find(x => x.id === id);
  if (t && !t.seen) { t.seen = true; htTripsSave(list); }
  if (typeof alertNotice === 'function') alertNotice(null);
  htCard();
}

/** The raw log as text, for sharing and for keeping. */
function htRawText(report) {
  return ['# Leaf Dash health trip raw log (read-only data)', `# ${JSON.stringify(HT.meta)}`, `# summary ${JSON.stringify({ ...report, perCell: undefined })}`,
    '', '## samples: t_ms,soc,voltage,current,kw,speed_kmh,batt_temp_max,ambient,aux_12v,heater_kw,gear',
    ...HT.samples.map(s => [s.t - HT.t0, s.soc, s.v, s.i, s.kw, s.spd, s.bt, s.amb, s.aux, s.heat, s.gear].map(x => x ?? '').join(',')),
    '', '## cells: t_ms,current,voltage,cell1..cell96 (mV)',
    ...HT.cells.map(s => [s.t - HT.t0, s.i, s.v, ...s.c].map(x => x ?? '').join(',')),
    '', '## per-cell resistance estimate (mΩ)', report.perCell.map((r, j) => `${j + 1}:${r == null ? '' : r.toFixed(3)}`).join(' ')].join('\n');
}

async function htShare(kind, E) {
  const d = new Date(E.meta.start), p = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  let file;
  if (kind === 'raw') {
    // the trip still in memory, or a kept copy (only the last three trips keep their raw log)
    const text = E.id === HT.t0 && HT.samples.length ? htRawText(E.report) : await htRawGet(E.id);
    if (!text) return alert('The raw log for this trip is no longer kept. Only the last three trips keep theirs.');
    file = new File([text], `leafdash-healthtrip-${stamp}.csv`, { type: 'text/csv' });
  } else {
    const css = [...document.styleSheets].map(ss => { try { return [...ss.cssRules].map(r => r.cssText).join('\n'); } catch { return ''; } }).join('\n');
    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Leaf Dash health trip ${stamp}</title><style>${css} body{padding:16px;max-width:720px}</style>
      <h2>Battery health trip</h2><p class="hint">${htWhen(E.meta.start)}</p>${htReportHtml(E.report)}`;
    file = new File([html], `leafdash-healthtrip-${stamp}.html`, { type: 'text/html' });
  }
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: file.name }); return; } catch (e) { if (e.name === 'AbortError') return; } }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
}

/* ---------------- Debug card ---------------- */
function htCard() {
  const el = $('htStatus'); if (!el) return;
  el.textContent = HT.on ? `Recording · ${Math.round((Date.now() - HT.t0) / 60e3)} min · ${HT.cells.length} cell snapshots`
    : HT.armed ? 'Armed: starts when you drive off' : HT.report ? 'Report ready' : 'Off';
  el.className = 'pill ' + (HT.on ? 'regen' : HT.armed ? 'eco' : '');
  $('htArm').checked = HT.armed || HT.on;
  $('htStop').classList.toggle('hidden', !HT.on);
  $('htView').classList.toggle('hidden', !HT.report);
  // kept reports, newest first
  const past = $('htPast'); if (!past) return;
  const list = htTrips().slice().reverse();
  $('htPastLabel').classList.toggle('hidden', !list.length);
  past.innerHTML = list.map(t => {
    const mi = (t.report.km || 0) * 0.621371, far = isMph() ? `${mi.toFixed(1)} mi` : `${(t.report.km || 0).toFixed(1)} km`;
    return `<button class="chg-row" data-trip="${t.id}">
      <span class="chg-when"><b>${htWhen(t.meta.start)}</b><span class="mini">${HT_ENDED[t.meta.reason] || (t.partial ? 'cut short' : '')}</span></span>
      <span class="chg-mid">${Math.round(t.report.minutes)} min<span class="mini">${far}</span></span>
      <span class="chg-cost">${t.seen ? '' : '<span class="pill regen">New</span>'}</span></button>`;
  }).join('');
}
$('htPast')?.addEventListener('click', e => {
  const r = e.target.closest('[data-trip]'); if (!r) return;
  const t = htTrips().find(x => String(x.id) === r.dataset.trip); if (t) htShowReport(t);
});
// A report that was never looked at (the app was closed as it appeared): offer it on the next start.
LeafDash.on('ready', () => {
  const t = htTrips().filter(x => !x.seen).pop();
  if (t && typeof alertNotice === 'function') alertNotice({ text: `Health trip report from ${htWhen(t.meta.start)} is ready`, action: () => htShowReport(t), dismiss: () => htMarkSeen(t.id) });
});
$('htArm')?.addEventListener('change', e => htArm(e.target.checked));
$('htStop')?.addEventListener('click', () => htStop('stopped'));
$('htView')?.addEventListener('click', () => htShowReport());
htCard();

/* demo: ?healthdemo builds a report from simulated data */
function htDemo() {
  S.demoHealth = true; HT.armed = true;
  const t0 = Date.now() - 20 * 60e3;
  htStart(); HT.t0 = t0;
  const base = Array.from({ length: 96 }, (_, j) => 3950 + (j % 7));
  for (let k = 0; k < 2400; k++) {
    const t = t0 + k * 500, ph = k / 60, i = Math.max(-40, 25 + 70 * Math.sin(ph) + 40 * Math.sin(ph * 2.7));
    const v = 370 - i * 0.095 - k * 0.002;
    HT.samples.push({ t, soc: 80 - k * 0.004, v, i, kw: v * i / 1000, spd: 40 + 25 * Math.sin(ph / 2), bt: 14 + k / 400, amb: 9, aux: 13.9, heat: 1, gear: 'D' });
    if (k % 4 === 0) HT.cells.push({ t, i, v, c: base.map((b, j) => Math.round(b - k * 0.02 - i * (j === 41 ? 1.45 : j === 70 ? 1.3 : 0.98) + (Math.random() - 0.5) * 2)) });
  }
  Object.assign(HT.meta, { soc0: 80, ahr: 108.7, soh: 93.1, hx: 98.4 });
  HT.samples.at(-1).soc = 70.4; S.data.soc = 70.4;
  htStop('demo');
}
