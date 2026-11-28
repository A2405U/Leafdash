'use strict';
/* =====================================================================
   LeafDash core API: metrics, widgets, add-ons, events
   ---------------------------------------------------------------------
   Everything the UI shows is a "metric". Dashboard tiles ("widgets"),
   the Drive screen chips and add-ons all read from the same metrics,
   so new data only has to be added in one place.

   For add-on / widget authors, see README.md → "Extending Leaf Dash".
   ===================================================================== */

const LeafDash = window.LeafDash = {
  version: '1.9',           // shown in Settings → About and as the Android app's version. Bump it with EVERY pull request (1.1, 1.2 …), so the phone shows which one it's on. 1.0 = the first Google Play build
  metrics: {},           // id → metric definition
  widgets: {},           // id → widget definition
  addons: {},            // id → add-on definition
  _ev: {},
  registerMetric(m) { this.metrics[m.id] = m; },
  registerWidget(w) { this.widgets[w.id] = w; },
  registerAddon(a) { this.addons[a.id] = a; },
  on(ev, fn) { (this._ev[ev] ||= []).push(fn); },
  emit(ev, x) { (this._ev[ev] || []).forEach(fn => { try { fn(x); } catch (e) { console.error(e); } }); },
  snapshot: () => buildSnapshot(),
};

/* ---------------- helpers ---------------- */
const isMph = () => SET.units === 'mph';
const KM2MI = 0.621371;
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const validCells = d => (d.cells || []).filter(x => x != null);
const packTemp = d => avg((d.temps || []).filter(x => x != null));

/** Trip efficiency in km/kWh (needs a little driving first). */
function tripEffKm() {
  const net = T.used - T.regen, miles = T.miles || 0;
  return net > 0.1 && miles > 0.5 ? (miles / net) * 1.609344 : null;
}
/** Range in km: from how the car has been driven over the last ~25 miles (history.js), else this
 *  trip's efficiency, else the car's own estimate. */
function rangeKm(d) {
  const eff = (typeof recentEffKm === 'function' && recentEffKm()) || tripEffKm();
  if (eff && d.soc != null) return { km: SET.usableKwh * d.soc / 100 * eff, src: 'est.' };
  if (d.gomKm != null) return { km: d.gomKm, src: '(car)' };
  return { km: null, src: '' };
}
const dist = km => km == null ? null : isMph() ? km * KM2MI : km;
const distU = () => isMph() ? 'mi' : 'km';

/* ---------------- metric catalogue ----------------
   get(d) returns the display value (number or text) or null.
   unit() and dp give the formatting; label is long, short is for chips. */
const M = (id, label, short, get, unit = '', dp = 0, group = 'Battery') =>
  LeafDash.registerMetric({ id, label, short: short || label, get, unit: typeof unit === 'function' ? unit : () => unit, dp, group });

M('soc', 'State of charge', '% battery', d => d.soc, '%', 1);
M('range', 'Range', null, d => dist(rangeKm(d).km), () => `${distU()} ${rangeKm(S.data).src}`.trim(), 0, 'Driving');
M('rangeCar', "Range (car's guess)", null, d => dist(d.gomKm), () => `${distU()} (car)`, 0, 'Driving');
M('effRecent', 'Recent efficiency', null, () => { const e = typeof recentEffKm === 'function' ? recentEffKm() : null; return e == null ? null : isMph() ? e * KM2MI : e; }, () => `${distU()}/kWh`, 1, 'Driving');
M('eff', 'Trip efficiency', null, () => { const e = tripEffKm(); return e == null ? null : isMph() ? e * KM2MI : e; }, () => `${distU()}/kWh`, 1, 'Driving');
M('kw', 'Battery power', 'kW', d => d.kw, 'kW', 1);
M('packTemp', 'Battery temp', '°C pack', d => packTemp(d), '°C', 0);
M('soh', 'Battery health (SOH)', 'SOH %', d => d.soh, '%', 1);
M('hx', 'Hx', 'Hx %', d => d.hx, '%', 1);
M('ahr', 'Capacity', 'Ah', d => d.ahr, 'Ah', 2);
M('voltage', 'Pack voltage', 'V pack', d => d.voltage, 'V', 1);
M('current', 'Pack current', 'A pack', d => d.current, 'A', 1);
M('cellSpread', 'Cell spread', 'mV spread', d => { const c = validCells(d); return c.length ? Math.max(...c) - Math.min(...c) : null; }, 'mV', 0);
M('aux12v', '12V battery', 'V 12V', d => d.aux ?? d.aux12V, 'V', 2);
M('speed', 'Speed', null, d => { const s = currentSpeed(); return s.mps == null ? null : s.mps * (isMph() ? 2.23694 : 3.6); }, () => isMph() ? 'mph' : 'km/h', 0, 'Driving');
M('accel', 'Accelerator', '% pedal', d => d.accel, '%', 0, 'Driving');
M('brakePedal', 'Brake pedal', '% brake', d => d.brakePedal, '%', 0, 'Driving');
M('gear', 'Gear', 'gear', d => d.gear ?? null, '', 0, 'Driving');
M('eco', 'ECO mode', 'ECO', d => d.eco == null ? null : d.eco ? 'On' : 'Off', '', 0, 'Driving');
M('outside', 'Outside temp', '°C outside', d => d.ambient, '°C', 0, 'Car');
M('odometer', 'Odometer', null, d => dist(d.odoKm), () => distU(), 0, 'Car');
M('qc', 'Rapid charges', 'rapid', d => d.qc ?? null, '', 0, 'Car');
M('l1l2', 'Slow charges', 'slow', d => d.l1l2 ?? null, '', 0, 'Car');
M('charging', 'Charging', 'charging', d => d.chargeMode == null ? null : CHARGE_MODES[d.chargeMode] || '?', '', 0, 'Car');
M('motorKw', 'Motor power', 'kW motor', d => d.motorKw, 'kW', 1, 'Power');
M('heaterKw', 'Heater power', 'kW heater', d => d.heaterKw, 'kW', 2, 'Power');
M('climate', 'Climate', 'climate', d => climateText(d), '', 0, 'Climate');
M('acCoilTemp', 'A/C coil temp', '°C A/C coil', d => d.acCoilTemp, '°C', 1, 'Climate');
M('auxKw', '12V & systems power', 'kW aux', d => d.auxKw, 'kW', 2, 'Power');
M('tripUsed', 'Trip energy used', 'kWh used', () => T.used, 'kWh', 2, 'Driving');
M('tripRegen', 'Trip energy regen', 'kWh regen', () => T.regen, 'kWh', 2, 'Driving');

function climateText(d) {
  if (d.climateOn == null) return null;
  if (!d.climateOn) return 'Off';
  const parts = [d.heaterKw > 0.1 ? 'Heat' : null, d.acOn ? 'A/C' : null, d.rearDemist ? 'Rear demist' : null].filter(Boolean);
  return parts.length ? parts.join(' + ') : 'Fan';
}

/** Format a metric for display: { v: '12.3', u: 'kW' } */
function fmtMetric(id) {
  const m = LeafDash.metrics[id];
  if (!m) return { v: '--', u: '', label: id };
  let v;
  try { v = m.get(S.data); } catch { v = null; }
  const u = m.unit();
  if (v == null || (typeof v === 'number' && Number.isNaN(v))) return { v: '--', u, label: m.label, short: m.short };
  if (typeof v === 'number') v = v.toLocaleString(undefined, { minimumFractionDigits: m.dp, maximumFractionDigits: m.dp });
  return { v: String(v), u, label: m.label, short: m.short };
}

/* ---------------- snapshot for add-ons ----------------
   Fixed units regardless of display settings: km, km/h, °C, kW, V, A. */
function buildSnapshot() {
  const d = S.data, c = validCells(d), sp = currentSpeed();
  const n = v => (v == null || Number.isNaN(v)) ? null : Math.round(v * 1000) / 1000;
  return {
    utc: Math.floor(Date.now() / 1000),
    soc: n(d.soc), soh: n(d.soh), hx: n(d.hx), capacity_ah: n(d.ahr),
    voltage: n(d.voltage), current: n(d.current), power_kw: n(d.kw),
    batt_temp: n(packTemp(d)),
    cell_min_mv: c.length ? Math.min(...c) : null, cell_max_mv: c.length ? Math.max(...c) : null,
    cell_spread_mv: c.length ? Math.max(...c) - Math.min(...c) : null,
    aux_12v: n(d.aux ?? d.aux12V), aux_12v_current: n(d.aux12A),
    speed_kmh: sp.mps == null ? null : n(sp.mps * 3.6), speed_source: sp.src,
    gear: d.gear ?? null, eco: d.eco ?? null, e_pedal: d.ePedal ?? null, ready: d.ready ?? null,
    ext_temp: n(d.ambient), odometer_km: d.odoKm ?? null, est_range_km: n(d.gomKm),
    trip_eff_km_per_kwh: n(tripEffKm()), trip_used_kwh: n(T.used), trip_regen_kwh: n(T.regen),
    quick_charges: d.qc ?? null, slow_charges: d.l1l2 ?? null,
    charging: d.chargeMode == null ? null : d.chargeMode > 0, rapid_charging: d.chargeMode === 3,
    plugged_in: d.plug == null ? null : d.plug === 2,
    climate_on: d.climateOn ?? null, ac_on: d.acOn ?? null, rear_demister: d.rearDemist ?? null,
    motor_kw: n(d.motorKw), heater_kw: n(d.heaterKw), aux_kw: n(d.auxKw), charger_kw: n(d.obcKw),
    tyres_kpa: d.tyres && d.tyres.some(x => x) ? { fl: n(d.tyres[0]), fr: n(d.tyres[1]), rl: n(d.tyres[2]), rr: n(d.tyres[3]) } : null,
    lat: SPD.last?.lat ?? null, lon: SPD.last?.lon ?? null,
  };
}
