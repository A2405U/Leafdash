'use strict';
/* =====================================================================
   Customisable dashboard
   ---------------------------------------------------------------------
   Tiles ("widgets") are picked, ordered and (in Advanced mode) resized
   by the user. Every metric is automatically available as a simple stat
   tile; richer tiles are registered below. Add-ons can register their
   own with LeafDash.registerWidget({ id, name, group, w, h, render }).

   Sizes are in grid units: phones have 2 columns, tablets 4.
   ===================================================================== */

const DEFAULT_LAYOUT = [
  'socRing', 'power', 'm:range', 'm:packTemp', 'm:soh', 'm:cellSpread',
  'carStatus', 'powerSplit', 'm:aux12v', 'm:outside',
].map(id => ({ id }));

const DASH = { edit: false, drag: null };

/* ---------------- built-in rich widgets ---------------- */
LeafDash.registerWidget({
  id: 'socRing', name: 'Charge ring', group: 'Widgets', w: 2, h: 2,
  render(el, d) {
    const pct = Math.max(0, Math.min(100, d.soc ?? 0));
    const col = pct < 15 ? 'var(--red)' : pct < 30 ? 'var(--amber)' : 'var(--green)';
    const r = rangeKm(d);
    el.innerHTML = `<div class="w-ring">
      <svg viewBox="0 0 120 120"><circle class="track" cx="60" cy="60" r="52"/>
        <circle cx="60" cy="60" r="52" style="stroke:${col};stroke-dasharray:326.7;stroke-dashoffset:${326.7 * (1 - pct / 100)}"/></svg>
      <div><div class="label">State of charge</div>
        <div class="w-big">${d.soc == null ? '--' : d.soc.toFixed(1)}<small>%</small></div>
        <div class="mini">${r.km == null ? '' : `${Math.round(dist(r.km))} ${distU()} ${r.src}`}</div></div></div>`;
  },
});

LeafDash.registerWidget({
  id: 'power', name: 'Battery power', group: 'Widgets', w: 2, h: 1,
  render(el, d) {
    const kw = d.kw;
    const p = kw == null ? 0 : kwToPct(kw), z = ZERO_PCT;
    el.innerHTML = `<div class="row-between"><div class="label">Battery power</div>
      <div class="pill ${kw == null || Math.abs(kw) < .5 ? '' : kw < 0 ? 'regen' : 'drive'}">${kw == null ? '—' : Math.abs(kw) < .5 ? 'Idle' : kw < 0 ? 'Regen / charging' : 'Drawing'}</div></div>
      <div class="w-big">${kw == null ? '--' : kw.toFixed(1)}<small>kW</small></div>
      <div class="ps-bar"><div class="ps-zero" style="left:${z}%"></div>
        <i class="w-pbar ${kw < 0 ? 'regen' : ''}" style="left:${Math.min(p, z)}%;width:${Math.abs(p - z)}%"></i></div>`;
  },
});

LeafDash.registerWidget({
  id: 'carStatus', name: 'Gear · ECO · e-Pedal', group: 'Widgets', w: 2, h: 1,
  render(el, d) {
    const pill = (on, txt, cls) => `<span class="pill ${on ? cls : ''}">${txt}</span>`;
    el.innerHTML = `<div class="label">Status</div>
      <div class="w-status">
        <span class="w-gear">${esc(d.gear ?? '–')}</span>
        ${pill(d.ready, d.ready == null ? 'Status —' : d.ready ? 'READY' : 'Not ready', 'drive')}
        ${pill(d.eco, 'ECO', 'eco')}
        ${pill(d.ePedal, 'e-Pedal', 'regen')}
      </div>`;
  },
});

LeafDash.registerWidget({
  id: 'powerSplit', name: 'Where the power goes', group: 'Widgets', w: 2, h: 2,
  render(el, d) {
    const rows = [['Motor', d.motorKw, 80, 'var(--text)'], ['Heater', d.heaterKw, 5, '#ff8a5c'],
      ['12V & systems', d.auxKw, 1.5, 'var(--green)'], ['Charger', d.obcKw, 7.4, 'var(--amber)']];
    el.innerHTML = `<div class="label">Where the power goes</div><div class="pw">${rows.map(([n, v, max, c]) => `
      <div class="pw-row"><span>${n}</span><div class="pw-bar"><i style="width:${v == null ? 0 : Math.min(100, Math.max(0, v) / max * 100)}%;background:${c}"></i></div>
      <b>${v == null ? '--' : v < 10 ? v.toFixed(2) : v.toFixed(0)}<small>kW</small></b></div>`).join('')}</div>`;
  },
});

LeafDash.registerWidget({
  id: 'climateCard', name: 'Climate', group: 'Widgets', w: 2, h: 1,
  render(el, d) {
    const on = (x, t, c) => `<span class="pill ${x ? c : ''}">${t}</span>`;
    el.innerHTML = `<div class="row-between"><div class="label">Climate</div><span class="mini">${d.heaterKw > 0.05 ? `heater ${d.heaterKw.toFixed(2)} kW` : ''}</span></div>
      <div class="w-status">
        <span class="w-gear" style="font-size:22px">${climateText(d) ?? '--'}</span>
        ${on(d.climateOn, 'Fan', 'drive')} ${on(d.heaterKw > 0.1, 'Heat', 'heat')} ${on(d.acOn, 'A/C', 'eco')} ${on(d.rearDemist, 'Rear demist', 'regen')}
      </div>`;
  },
});

LeafDash.registerWidget({
  id: 'tyres', name: 'Tyre pressures', group: 'Widgets', w: 2, h: 2,
  render(el, d) {
    const t = d.tyres || [], has = t.some(x => x);
    el.innerHTML = `<div class="label">Tyres (psi)</div>${has ? `<div class="tyres">${['Front left', 'Front right', 'Rear left', 'Rear right'].map((n, i) =>
      `<div class="${t[i] && t[i] * KPA_PSI < 30 ? 'low' : ''}"><b>${t[i] ? (t[i] * KPA_PSI).toFixed(1) : '--'}</b><span>${n}</span></div>`).join('')}</div>`
      : '<p class="hint">Not reported by this car.</p>'}`;
  },
});

LeafDash.registerWidget({
  id: 'cellsMini', name: 'Cell voltages (mini)', group: 'Widgets', w: 2, h: 1,
  render(el, d) {
    const c = d.cells || [], v = c.filter(x => x != null);
    if (!v.length) { el.innerHTML = '<div class="label">Cells</div><p class="hint">Waiting for data…</p>'; return; }
    const lo = Math.min(...v) - 3, hi = Math.max(...v) + 1;
    el.innerHTML = `<div class="row-between"><div class="label">Cells</div><span class="mini">${Math.min(...v)}–${Math.max(...v)} mV</span></div>
      <div class="w-cells">${c.map(x => `<i style="height:${x == null ? 0 : 15 + 85 * (x - lo) / (hi - lo)}%"></i>`).join('')}</div>`;
  },
});

LeafDash.registerWidget({
  id: 'energySpark', name: 'Power graph (5 min)', group: 'Widgets', w: 2, h: 1,
  render(el) {
    const now = Date.now(), pts = hist.filter(p => p.t > now - 5 * 60e3);
    if (pts.length < 2) { el.innerHTML = '<div class="label">Power · 5 min</div><p class="hint">Building up…</p>'; return; }
    const hi = Math.max(10, ...pts.map(p => p.kw)), lo = Math.min(-5, ...pts.map(p => p.kw));
    const X = t => ((t - (now - 5 * 60e3)) / (5 * 60e3) * 100).toFixed(2), Y = k => ((hi - k) / (hi - lo) * 100).toFixed(2);
    const line = pts.map(p => `${X(p.t)},${Y(p.kw)}`).join(' ');
    el.innerHTML = `<div class="label">Power · 5 min</div>
      <svg class="w-spark" viewBox="0 0 100 100" preserveAspectRatio="none">
        <line x1="0" x2="100" y1="${Y(0)}" y2="${Y(0)}" stroke="#3a4756" stroke-width="1" vector-effect="non-scaling-stroke"/>
        <polyline points="${line}" fill="none" stroke="var(--text)" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
  },
});

/* every metric becomes a simple stat tile: id "m:<metric>" */
function statWidget(id) {
  const m = LeafDash.metrics[id.slice(2)];
  if (!m) return null;
  return {
    id, name: m.label, group: m.group, w: 1, h: 1,
    render(el) { const f = fmtMetric(m.id); el.innerHTML = `<div class="label">${esc(m.label)}</div><div class="w-val">${esc(f.v)}<small>${esc(f.u)}</small></div>`; },
  };
}
const getWidget = id => id.startsWith('m:') ? statWidget(id) : LeafDash.widgets[id];

/* ---------------- layout ---------------- */
function layout() {
  if (!Array.isArray(SET.layout) || !SET.layout.length) SET.layout = structuredClone(DEFAULT_LAYOUT);
  return SET.layout.filter(t => getWidget(t.id));
}
const cols = () => parseInt(getComputedStyle($('dash')).getPropertyValue('--cols')) || 2;

function tileSize(t) {
  const w = getWidget(t.id), c = cols();
  const adv = SET.layoutMode === 'advanced';
  return { w: Math.min(c, adv ? (t.w || w.w) : w.w), h: adv ? (t.h || w.h) : w.h };
}

/** Rebuild tiles if the set/order/sizes changed, then refresh their contents. */
function renderDash() {
  const el = $('dash');
  if (!el || S.view !== 'dash' || DASH.drag) return;
  const L = layout();
  const sig = L.map(t => { const s = tileSize(t); return `${t.id}:${s.w}x${s.h}`; }).join('|') + (DASH.edit ? '#e' : '') + SET.layoutMode + cols();
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.classList.toggle('editing', DASH.edit);
    el.classList.toggle('advanced', SET.layoutMode === 'advanced');
    el.innerHTML = L.map((t, i) => {
      const s = tileSize(t);
      return `<div class="w" data-i="${i}" data-id="${t.id}" style="grid-column:span ${s.w};grid-row:span ${s.h}">
        <div class="w-body"></div>
        ${DASH.edit ? `<span class="w-h" aria-label="Drag to move">⠿</span><button class="w-x" data-x="${i}" aria-label="Remove">×</button>
          ${SET.layoutMode === 'advanced' ? '<span class="w-rs" aria-label="Resize"></span>' : ''}` : ''}
      </div>`;
    }).join('') || '<p class="hint">No tiles. Tap Edit → + Add tile.</p>';
  }
  el.querySelectorAll('.w').forEach(tile => {
    try { getWidget(tile.dataset.id).render(tile.querySelector('.w-body'), S.data); } catch (e) { console.error(e); }
  });
}
setInterval(() => { if (S.view === 'dash' && S.mode !== 'on') renderDash(); }, 1000);
window.addEventListener('resize', () => { if ($('dash')) $('dash').dataset.sig = ''; renderDash(); });

/* ---------------- edit mode ---------------- */
function dashEdit(on) {
  DASH.edit = on;
  $('btnDashEdit').textContent = on ? 'Done' : 'Edit';
  $('btnDashEdit').className = 'btn small ' + (on ? 'primary' : 'ghost');
  $('btnDashAdd').classList.toggle('hidden', !on);
  if (!on) saveSettings();
  $('dash').dataset.sig = '';
  renderDash();
}

function openAddTile() {
  const inUse = new Set(layout().map(t => t.id));
  const all = [...Object.values(LeafDash.widgets), ...Object.keys(LeafDash.metrics).map(id => statWidget('m:' + id))]
    .filter(w => !inUse.has(w.id));
  const groups = {};
  all.forEach(w => (groups[w.group || 'Other'] ||= []).push(w));
  const s = openSheet(`<div class="row-between"><h3>Add a tile</h3><button class="btn ghost small" data-x>Close</button></div>
    ${Object.entries(groups).map(([g, ws]) => `<div class="set-group"><div class="label">${g}</div>
      <div class="add-list">${ws.map(w => `<button data-add="${w.id}">${w.name}<small>${w.w > 1 ? 'wide' : 'small'}</small></button>`).join('')}</div></div>`).join('')
      || '<p class="hint">Everything is already on the dashboard.</p>'}`);
  s.box.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    SET.layout = layout(); SET.layout.push({ id: b.dataset.add }); saveSettings();
    b.remove(); $('dash').dataset.sig = ''; renderDash();
  });
}

/* drag to reorder (any mode) and drag the corner to resize (advanced) */
function setupDashPointer() {
  const el = $('dash');
  el.addEventListener('click', e => {
    const x = e.target.closest('[data-x]');
    if (!x || !DASH.edit) return;
    SET.layout = layout(); SET.layout.splice(+x.dataset.x, 1); saveSettings();
    el.dataset.sig = ''; renderDash();
  });
  el.addEventListener('pointerdown', e => {
    if (!DASH.edit || !e.target.closest('.w-h, .w-rs')) return;   // only the handles grab; the rest scrolls
    const tile = e.target.closest('.w'); if (!tile) return;
    e.preventDefault();
    const resize = !!e.target.closest('.w-rs');
    const i = +tile.dataset.i, L = layout(), t = L[i], s0 = tileSize(t);
    const rect = el.getBoundingClientRect(), gap = 12;
    const colW = (rect.width - gap * (cols() - 1)) / cols(), rowH = parseFloat(getComputedStyle(el).gridAutoRows) + gap;
    DASH.drag = { tile, resize, x0: e.clientX, y0: e.clientY, t, s0, colW, rowH };
    tile.classList.add(resize ? 'resizing' : 'dragging');
    tile.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', e => {
    const D = DASH.drag; if (!D) return;
    if (D.resize) {
      const w = Math.max(1, Math.min(cols(), Math.round(D.s0.w + (e.clientX - D.x0) / D.colW)));
      const h = Math.max(1, Math.min(4, Math.round(D.s0.h + (e.clientY - D.y0) / D.rowH)));
      D.t.w = w; D.t.h = h;
      D.tile.style.gridColumn = `span ${w}`; D.tile.style.gridRow = `span ${h}`;
      return;
    }
    // reorder: move the dragged tile before/after whatever is under the finger
    D.tile.style.pointerEvents = 'none';
    const under = document.elementFromPoint(e.clientX, e.clientY)?.closest('.w');
    D.tile.style.pointerEvents = '';
    if (under && under !== D.tile && under.parentNode === el) {
      const r = under.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2 || (e.clientX > r.left + r.width / 2 && e.clientY > r.top);
      el.insertBefore(D.tile, after ? under.nextSibling : under);
    }
    // nudge the page when dragging near the screen edges
    if (e.clientY < 90) window.scrollBy(0, -12); else if (e.clientY > innerHeight - 110) window.scrollBy(0, 12);
  });
  const end = () => {
    const D = DASH.drag; if (!D) return;
    DASH.drag = null;
    D.tile.classList.remove('dragging', 'resizing');
    const old = layout();
    SET.layout = [...el.querySelectorAll('.w')].map(n => old[+n.dataset.i]);
    saveSettings(); el.dataset.sig = ''; renderDash();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

$('btnDashEdit').addEventListener('click', () => dashEdit(!DASH.edit));
$('btnDashAdd').addEventListener('click', openAddTile);
setupDashPointer();
