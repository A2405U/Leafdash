'use strict';
/* =====================================================================
   History: things the app remembers between drives
   ---------------------------------------------------------------------
     • recent efficiency (last ~25 miles) → a range figure based on how
       the car has actually been driven lately
     • charge log → what each charge cost, with a price per charging type
     • battery health → one reading a day, shown as a trend

   Everything is stored only in this browser. Nothing here talks to the
   car: it only uses values the app has already read. In Demo mode a
   made-up history is shown and nothing is saved.
   ===================================================================== */

const HK = { eff: 'leafdash.eff', charges: 'leafdash.charges', health: 'leafdash.health', seen: 'leafdash.seen' };
const HIS = { eff: { b: [], cur: { mi: 0, kwh: 0 } }, charges: [], health: [], seen: null, live: null, demo: false, checked: false, sig: '' };

const CHG_TYPES = {
  threepin: { name: '3-pin plug', loss: 0.87 },
  wallbox:  { name: 'Home wallbox', loss: 0.90 },
  public:   { name: 'Public charger', loss: 0.90 },
  rapid:    { name: 'Rapid charger', loss: 1 },
};
const CHG_RANK = { threepin: 1, wallbox: 2, public: 2, rapid: 3 };

function hisLoad() {
  const get = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
  HIS.eff = get(HK.eff, { b: [], cur: { mi: 0, kwh: 0 } });
  HIS.charges = get(HK.charges, []);
  HIS.health = get(HK.health, []);
  HIS.seen = get(HK.seen, null);
  HIS.live = null; HIS.demo = false; HIS.checked = false; HIS.sig = '';
}
function hisSave(k) {
  if (HIS.demo || window.LD_RESTORING) return;             // demo history is never kept
  try { localStorage.setItem(HK[k], JSON.stringify(HIS[k])); } catch {}
}

/* ---------------- recent efficiency → range ---------------- */
/** Called for every new power sample while driving (from recordSample in app.js). */
function hisDrive(dtSec, kw, mps) {
  if (!dtSec || mps == null || kw == null) return;
  const mi = mps * dtSec / 1609.344;
  T.miles = (T.miles || 0) + mi;
  // charging, or sitting in P with the heater on, isn't driving: it would drag the range figure down
  if (isCharging(S.data) || S.data.gear === 'P') return;
  const c = HIS.eff.cur;
  c.mi += mi; c.kwh += kw * dtSec / 3600;
  if (c.mi >= 1) {                                         // one bucket per mile, the last 25 kept
    HIS.eff.b.push({ mi: +c.mi.toFixed(3), kwh: +c.kwh.toFixed(4) });
    while (HIS.eff.b.length > 25) HIS.eff.b.shift();
    HIS.eff.cur = { mi: 0, kwh: 0 };
    hisSave('eff');
  }
}
/** Miles per kWh over the last ~25 miles, or null until there's enough driving to trust. */
function recentEffMi() {
  const all = [...HIS.eff.b, HIS.eff.cur];
  const mi = all.reduce((t, x) => t + x.mi, 0), kwh = all.reduce((t, x) => t + x.kwh, 0);
  if (mi < 3 || kwh < 0.4) return null;
  return { eff: Math.max(1.5, Math.min(8, mi / kwh)), miles: mi };
}
const recentEffKm = () => { const r = recentEffMi(); return r ? r.eff * 1.609344 : null; };

/* ---------------- charge log + costs ---------------- */
const chgPrice = t => +(SET.prices?.[t] ?? SET_DEFAULTS.prices[t]) || 0;
const chgTariff = c => c.tariff || c.type || 'wallbox';
/** What a charge cost in pounds: energy into the battery, plus losses, at that tariff's price. */
function chgCost(c) {
  const t = chgTariff(c);
  return (c.kwh || 0) / CHG_TYPES[t].loss * (c.p ?? chgPrice(t)) / 100;
}
/** Average pence paid per kWh that reached the battery, from the last few charges. */
function avgPencePerKwh() {
  const done = HIS.charges.filter(c => !c.open && c.kwh > 0.2).slice(-8);
  const kwh = done.reduce((t, c) => t + c.kwh, 0);
  if (kwh > 1) return done.reduce((t, c) => t + chgCost(c), 0) * 100 / kwh;
  return chgPrice('wallbox') / CHG_TYPES.wallbox.loss;
}
function chgTypeNow(d) {
  if (d.chargeMode === 3) return 'rapid';
  if (d.chargeMode === 2) return 'wallbox';
  if (d.chargeMode === 1) return 'threepin';
  const pIn = -(d.kw ?? 0);
  return pIn > 10 ? 'rapid' : pIn > 2.9 ? 'wallbox' : 'threepin';
}
function chgClose(c) {
  c.open = false; delete c.lastOn;
  if ((c.kwh || 0) < 0.1) { HIS.charges = HIS.charges.filter(x => x !== c); }
  else { c.tariff = c.tariff || c.type; c.p = chgPrice(c.tariff); c.kwh = +c.kwh.toFixed(3); }
  if (HIS.live === c) HIS.live = null;
  while (HIS.charges.length > 300) HIS.charges.shift();
  hisSave('charges');
}

/** Follow a charge while the app is open. */
function hisChargeTick(d, now, dtSec) {
  if (isCharging(d)) {
    if (!HIS.live) {
      HIS.live = HIS.charges.find(c => c.open) || null;
      if (!HIS.live) { HIS.live = { id: now, start: now, socFrom: d.soc ?? null, kwh: 0, peak: 0, type: null, open: true }; HIS.charges.push(HIS.live); }
      LeafDash.emit('charge', { on: true, soc: d.soc });
    }
    const L = HIS.live, pIn = Math.max(0, -(d.kw ?? 0)), t = chgTypeNow(d);
    L.kwh += pIn * dtSec / 3600;
    L.peak = Math.max(L.peak || 0, +pIn.toFixed(1));
    if (!L.type || CHG_RANK[t] > CHG_RANK[L.type]) L.type = t;
    if (d.soc != null) { L.socTo = d.soc; if (L.socFrom == null) L.socFrom = d.soc; }
    L.end = now; L.lastOn = now;
    if (now - (L.saved || 0) > 30e3) { L.saved = now; hisSave('charges'); }
  } else if (HIS.live && now - HIS.live.lastOn > 60e3) {
    const L = HIS.live;
    LeafDash.emit('charge', { on: false, soc: d.soc });
    chgClose(L);
  }
}

/** Once per connection: did the car charge while the app wasn't watching? The battery is fuller than
 *  when we last saw it, and the car's own rapid-charge counter says which kind it was. */
function hisCheckAway(d, now) {
  const seen = HIS.seen, open = HIS.charges.find(c => c.open);
  if (seen && d.soc != null && seen.soc != null) {
    const gain = d.soc - seen.soc;
    if (gain >= 3) {
      const rapid = d.qc != null && seen.qc != null && d.qc > seen.qc;
      const kwh = gain / 100 * (SET.usableKwh || 39);
      if (open) { open.kwh += kwh; open.socTo = d.soc; open.end = now; open.est = true; if (rapid) open.type = 'rapid'; }
      else HIS.charges.push({ id: now, start: seen.at, end: now, socFrom: seen.soc, socTo: d.soc, kwh, type: rapid ? 'rapid' : 'wallbox', est: true, away: true, open: true });
    }
  }
  const o = HIS.charges.find(c => c.open);
  if (o && !isCharging(d)) chgClose(o);
}

/* ---------------- battery health, one reading a day ---------------- */
const dayKey = t => { const x = new Date(t); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
function hisHealthTick(d, now) {
  if (d.soh == null || d.ahr == null || d.soh < 40 || d.soh > 110) return;
  const key = dayKey(now);
  let r = HIS.health[HIS.health.length - 1];
  if (!r || r.d !== key) { r = { d: key }; HIS.health.push(r); while (HIS.health.length > 2000) HIS.health.shift(); }
  r.soh = +d.soh.toFixed(2); r.ahr = +d.ahr.toFixed(2);
  if (d.hx != null) r.hx = +d.hx.toFixed(1);
  if (d.odoKm != null) r.odo = d.odoKm;
  const c = validCells(d);
  if (c.length > 90 && Math.abs(d.kw ?? 99) < 3) r.spread = Math.max(...c) - Math.min(...c);   // only meaningful at rest
  if (now - (HIS.healthSaved || 0) > 60e3) { HIS.healthSaved = now; hisSave('health'); }
}

/* ---------------- the tick ---------------- */
let hisLastTick = 0, hisConnAt = 0;
setInterval(() => {
  const now = Date.now(), d = S.data;
  if ((S.mode !== 'on' && S.mode !== 'demo') || now - S.lastUpdate > 6000) { hisLastTick = 0; return; }
  const dt = hisLastTick ? Math.min(5, (now - hisLastTick) / 1000) : 0;
  hisLastTick = now;
  if (S.mode === 'on') {
    if (!hisConnAt) hisConnAt = now;
    // wait for the charge counters (or 20 s) so a rapid charge can be told from a slow one
    if (!HIS.checked && d.soc != null && ((d.qc != null && d.l1l2 != null) || now - hisConnAt > 20e3)) { HIS.checked = true; hisCheckAway(d, now); }
    if (HIS.checked) {
      hisChargeTick(d, now, dt);
      if (d.soc != null && now - (HIS.seen?.at || 0) > 30e3) { HIS.seen = { soc: +d.soc.toFixed(2), qc: d.qc ?? null, l1l2: d.l1l2 ?? null, odo: d.odoKm ?? null, at: now }; hisSave('seen'); }
      if (now - hisConnAt > 30e3) hisHealthTick(d, now);
    }
  } else hisChargeTick(d, now, dt);
  hisRender();
}, 2000);

LeafDash.on('mode', m => {
  if (m === 'demo' && !S.mirror) hisDemo();             // the car screen following a live phone uses the real history
  else if (HIS.demo) hisLoad();
  if (m !== 'on') { hisConnAt = 0; HIS.checked = false; HIS.live = null; }
  HIS.sig = '';
});

/* ---------------- display ---------------- */
const gbp = v => v == null ? '--' : '£' + v.toFixed(2);
const fmtDay = t => new Date(typeof t === 'string' ? t + 'T12:00' : t).toLocaleDateString([], { day: 'numeric', month: 'short' });

function hisRender() {
  if (S.view === 'energy') renderCosts();
  if (S.view === 'cells') renderHealth();
}

function renderCosts() {
  if (!$('costCard')) return;
  const ppk = avgPencePerKwh(), net = Math.max(0, T.used - T.regen), miles = T.miles || 0;
  $('ctTrip').textContent = gbp(net * ppk / 100);
  const rec = recentEffMi();
  const perMile = miles > 0.5 && net > 0.05 ? net * ppk / miles : rec ? ppk / rec.eff : null;
  $('ctMile').textContent = perMile == null ? '--' : perMile.toFixed(1);
  const now = new Date(), m0 = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const month = HIS.charges.filter(c => (c.end || c.start) >= m0 && !c.open);
  $('ctMonth').textContent = gbp(month.reduce((t, c) => t + chgCost(c), 0));
  $('ctMonthSub').textContent = `${month.length} charge${month.length === 1 ? '' : 's'} · ${month.reduce((t, c) => t + c.kwh, 0).toFixed(0)} kWh`;
  $('ctTripSub').textContent = miles > 0.1 ? `${(isMph() ? miles : miles * 1.609344).toFixed(1)} ${distU()}` : ' ';
  $('ctMileSub').textContent = `at ${ppk.toFixed(0)}p per kWh`;

  const list = HIS.charges.slice(-4).reverse();
  const sig = JSON.stringify(list.map(c => [c.id, c.open, Math.round((c.kwh || 0) * 10), c.tariff, c.p])) + HIS.charges.length;
  if (sig === HIS.sig) return;
  HIS.sig = sig;
  $('chgList').innerHTML = list.length ? list.map(chgRowHtml).join('')
    : '<p class="hint">Charges show here automatically. If the car charges while the app is closed, it\'s worked out the next time you connect.</p>';
  $('btnAllCharges').classList.toggle('hidden', HIS.charges.length <= 4);
}
function chgRowHtml(c) {
  const t = chgTariff(c), soc = c.socFrom != null && c.socTo != null ? `${Math.round(c.socFrom)} → ${Math.round(c.socTo)}%` : '';
  return `<button class="chg-row" data-chg="${c.id}">
    <span class="chg-when"><b>${fmtDay(c.end || c.start)}</b><span class="mini">${CHG_TYPES[t].name}${c.est ? ' · est.' : ''}</span></span>
    <span class="chg-mid">${soc}<span class="mini">${(c.kwh || 0).toFixed(1)} kWh${c.open ? ' so far' : ''}</span></span>
    <span class="chg-cost">${c.open ? '<span class="pill regen">Charging</span>' : gbp(chgCost(c))}</span></button>`;
}

/** Tap a charge: change which price applies, or remove it. */
function chgSheet(id) {
  const c = HIS.charges.find(x => String(x.id) === String(id));
  if (!c || c.open) return;
  const s = openSheet(`
    <div class="row-between"><h3>Charge on ${fmtDay(c.end || c.start)}</h3><button class="btn ghost small" data-x>Done</button></div>
    <div class="modal-body">
      <p>${c.socFrom != null ? `${Math.round(c.socFrom)}% → ${Math.round(c.socTo)}% · ` : ''}${c.kwh.toFixed(1)} kWh into the battery${c.peak ? ` · peak ${c.peak} kW` : ''}</p>
      ${c.est ? '<p class="hint">Worked out from how much fuller the battery was when you next connected, so the energy is an estimate.</p>' : ''}
    </div>
    <div class="set-group"><div class="label">Charged with</div>
      <div class="chg-pick">${Object.entries(CHG_TYPES).map(([k, v]) => `<button data-t="${k}"><b>${v.name}</b><span class="mini">${chgPrice(k)}p per kWh</span></button>`).join('')}</div>
    </div>
    <div class="row-between chg-total"><div class="label">Cost</div><div class="val sm" data-cost></div></div>
    <p class="hint">Includes charging losses of about 10% on AC charging, since you pay for what leaves the wall.</p>
    <div class="modal-actions"><button class="btn danger" data-a="del">Remove this charge</button></div>`,
    { onClose: () => { HIS.sig = ''; hisRender(); } });
  const mark = () => {
    s.box.querySelectorAll('[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === chgTariff(c)));
    s.box.querySelector('[data-cost]').textContent = gbp(chgCost(c));
  };
  s.box.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { c.tariff = b.dataset.t; c.p = chgPrice(c.tariff); hisSave('charges'); mark(); });
  s.box.querySelector('[data-a=del]').onclick = () => { HIS.charges = HIS.charges.filter(x => x !== c); hisSave('charges'); s.close(); };
  mark();
}
function allChargesSheet() {
  const done = HIS.charges.filter(c => !c.open);
  const s = openSheet(`
    <div class="row-between"><h3>All charges</h3><button class="btn ghost small" data-x>Done</button></div>
    <p class="hint">${done.length} charges · ${done.reduce((t, c) => t + c.kwh, 0).toFixed(0)} kWh · ${gbp(done.reduce((t, c) => t + chgCost(c), 0))} in total</p>
    <div class="chg-list">${HIS.charges.slice().reverse().map(chgRowHtml).join('')}</div>`);
  s.box.querySelector('.chg-list').onclick = e => { const r = e.target.closest('[data-chg]'); if (r) { s.close(); chgSheet(r.dataset.chg); } };
}

/* battery health trend */
function renderHealth() {
  const cv = $('healthChart');
  if (!cv) return;
  const H = HIS.health.filter(r => r.soh != null), last = H[H.length - 1], first = H[0];
  $('hhNow').textContent = last ? last.soh.toFixed(1) : '--';
  $('hhAh').textContent = last ? last.ahr.toFixed(1) : '--';
  $('hhSpread').textContent = [...H].reverse().find(r => r.spread != null)?.spread ?? '--';
  const ch = $('hhChange');
  if (H.length >= 2) {
    const dv = last.soh - first.soh;
    ch.textContent = `${dv > 0 ? '+' : dv < 0 ? '−' : ''}${Math.abs(dv).toFixed(1)}% since ${fmtDay(first.d)}`;
    ch.className = 'pill' + (dv < -1.5 ? ' heat' : '');
  } else { ch.textContent = 'just started'; ch.className = 'pill'; }
  $('hhNote').textContent = H.length >= 2 ? `${H.length} daily readings` : 'One reading is saved each day you connect. The trend appears after a few days.';
  $('btnHealthCsv').classList.toggle('hidden', !H.length);

  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  if (H.length < 2) return;
  const padL = 42, padB = 18, padT = 10, padR = 8;
  const t = r => new Date(r.d + 'T12:00').getTime(), t0 = t(first), t1 = Math.max(t(last), t0 + 864e5);
  let lo = Math.min(...H.map(r => r.soh)), hi = Math.max(...H.map(r => r.soh));
  const step = hi - lo > 6 ? 2 : hi - lo > 2.5 ? 1 : 0.5;
  lo = Math.floor((lo - step * 0.4) / step) * step; hi = Math.ceil((hi + step * 0.4) / step) * step;
  const x = v => padL + (v - t0) / (t1 - t0) * (w - padL - padR), y = v => padT + (hi - v) / (hi - lo) * (h - padT - padB);
  g.font = '10px system-ui'; g.textBaseline = 'middle'; g.textAlign = 'right';
  for (let v = lo; v <= hi + 1e-6; v += step) {
    g.strokeStyle = '#1a232d'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(padL, y(v)); g.lineTo(w - padR, y(v)); g.stroke();
    g.fillStyle = '#8494a6'; g.fillText(v.toFixed(step < 1 ? 1 : 0) + '%', padL - 6, y(v));
  }
  g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.fillText(fmtDay(first.d), padL, h - 3);
  g.textAlign = 'right'; g.fillText(fmtDay(last.d), w - padR, h - 3);
  // soft fill under the line, then the line and the latest point
  const area = new Path2D();
  area.moveTo(x(t0), y(lo)); H.forEach(r => area.lineTo(x(t(r)), y(r.soh))); area.lineTo(x(t(last)), y(lo)); area.closePath();
  const gr = g.createLinearGradient(0, padT, 0, h - padB);
  gr.addColorStop(0, 'rgba(61,220,151,.22)'); gr.addColorStop(1, 'rgba(61,220,151,0)');
  g.fillStyle = gr; g.fill(area);
  g.strokeStyle = '#3ddc97'; g.lineWidth = 1.8; g.lineJoin = 'round';
  g.beginPath(); H.forEach((r, i) => i ? g.lineTo(x(t(r)), y(r.soh)) : g.moveTo(x(t(r)), y(r.soh))); g.stroke();
  g.fillStyle = '#3ddc97'; g.beginPath(); g.arc(x(t(last)), y(last.soh), 3.5, 0, Math.PI * 2); g.fill();
}

function healthCsv() {
  const rows = ['date,health_percent,capacity_ah,hx_percent,cell_spread_mv,odometer_km',
    ...HIS.health.map(r => [r.d, r.soh ?? '', r.ahr ?? '', r.hx ?? '', r.spread ?? '', r.odo ?? ''].join(','))];
  const f = new File([rows.join('\n')], `leafdash-battery-health-${dayKey(Date.now())}.csv`, { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ---------------- made-up history for Demo mode ---------------- */
function hisDemo() {
  const now = Date.now(), day = 864e5;
  HIS.demo = true; HIS.live = null; HIS.sig = '';
  HIS.eff = { b: Array.from({ length: 20 }, (_, i) => ({ mi: 1, kwh: 0.235 + 0.03 * Math.sin(i * 1.7) })), cur: { mi: 0, kwh: 0 } };
  HIS.health = Array.from({ length: 150 }, (_, i) => {
    const age = 149 - i;
    return { d: dayKey(now - age * day), soh: +(93.12 + age * 0.0052 + 0.025 * Math.sin(i * 0.9) + 0.06 * Math.sin(i * 0.11)).toFixed(2),
      ahr: +(107.5 + age * 0.006).toFixed(2), hx: 98.4, spread: 12 + (i % 5), odo: 27188 - age * 38 };
  }).filter((_, i) => i % 3 !== 1);
  const mk = (ago, type, from, to, tariff) => ({ id: now - ago * day, start: now - ago * day - 3 * 3600e3, end: now - ago * day, socFrom: from, socTo: to,
    kwh: +((to - from) / 100 * 39).toFixed(2), type, tariff: tariff || type, p: chgPrice(tariff || type), peak: type === 'rapid' ? 44.1 : type === 'threepin' ? 2.3 : 6.6, est: ago % 2 === 0 });
  HIS.charges = [mk(23, 'wallbox', 22, 100), mk(17, 'rapid', 18, 80), mk(12, 'wallbox', 35, 100), mk(8, 'wallbox', 41, 90, 'public'), mk(5, 'threepin', 52, 80), mk(2, 'wallbox', 30, 100)];
}

/* ---------------- wiring ---------------- */
hisLoad();
$('chgList')?.addEventListener('click', e => { const r = e.target.closest('[data-chg]'); if (r) chgSheet(r.dataset.chg); });
$('btnAllCharges')?.addEventListener('click', allChargesSheet);
$('btnPrices')?.addEventListener('click', () => openSettings('costs'));
$('btnHealthCsv')?.addEventListener('click', healthCsv);
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => { HIS.sig = ''; setTimeout(hisRender, 0); }));
window.addEventListener('beforeunload', () => { ['eff', 'charges', 'health'].forEach(hisSave); });
