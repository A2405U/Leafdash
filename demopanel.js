'use strict';
/* =====================================================================
   Demo test panel: only in Demo mode. Switch lights, gear, ECO,
   charging etc. by hand to check how each part of the app looks.
   Nothing here talks to the car.
   ===================================================================== */

const DP = {
  open: false, manual: false, top: false,
  lights: { tail: true, low: false, high: false, brake: false, indL: false, indR: false, hazard: false, reverse: false, fog: false },
  gear: 'D', eco: false, ePedal: false,
  charging: false, chargeType: 1,             // 1 = 3-pin, 2 = wallbox, 3 = rapid
  speed: 40, kw: 20, soc: 78, temp: 14, lowTyre: false,
  hold: { speed: false, kw: false, soc: false, temp: false },
};
const CHARGE_KW = { 1: 2.3, 2: 6.6, 3: 42 };

/** Called by the demo generator after it builds S.data. */
function demoApply(d) {
  if (!DP.manual) return d;
  const L = DP.lights, hz = L.hazard;
  d.demoLights = { tail: L.tail || L.low || L.high, low: L.low, high: L.high, brake: L.brake,
    indL: L.indL || hz, indR: L.indR || hz, reverse: L.reverse || DP.gear === 'R', fog: L.fog };
  d.gear = DP.gear; d.eco = DP.eco; d.ePedal = DP.ePedal;
  if (DP.hold.speed) d.speed = DP.speed * (SET.units === 'mph' ? 1.609344 : 1);
  if (DP.hold.kw) { d.kw = DP.kw; d.motorKw = Math.max(0, DP.kw - 1.3); d.current = DP.kw * 1000 / (d.voltage || 370); }
  if (DP.hold.soc) d.soc = DP.soc;
  if (DP.hold.temp) d.temps = [DP.temp, DP.temp + 1, null, DP.temp];
  if (DP.lowTyre) d.tyreRL = 196;                    // about 28 psi, to try the gentle alert
  if (DP.gear === 'R' && !DP.hold.speed) { d.speed = 6; if (!DP.hold.kw) d.kw = 4; }
  if (DP.gear === 'P' || DP.gear === 'N') { d.speed = 0; d.motorKw = 0; if (!DP.hold.kw) d.kw = 0.4; }
  if (DP.charging) {
    const kw = CHARGE_KW[DP.chargeType];
    Object.assign(d, { demoCharging: true, kw: -kw, current: -kw * 1000 / (d.voltage || 370), chargeMode: DP.chargeType, plug: 2, speed: 0, gear: 'P', motorKw: 0 });
  }
  return d;
}

function dpPanel() {
  let el = $('demoPanel');
  if (!el) {
    el = document.createElement('div'); el.id = 'demoPanel'; el.className = 'demo-panel hidden';
    document.body.appendChild(el);
    const fab = document.createElement('button'); fab.id = 'demoFab'; fab.className = 'demo-fab hidden'; fab.textContent = 'Test panel';
    fab.onclick = () => { DP.open = !DP.open; dpRender(); };
    document.body.appendChild(fab);
  }
  return el;
}

function dpRender() {
  const el = dpPanel(), fab = $('demoFab'), on = S.mode === 'demo';
  fab.classList.toggle('hidden', !on);
  fab.classList.toggle('on', DP.open);
  el.classList.toggle('hidden', !on || !DP.open); el.classList.toggle('top', DP.top);
  if (!on || !DP.open) return;
  const t = (k, label, obj = DP.lights) => `<button class="dp-t ${obj[k] ? 'on' : ''}" data-t="${k}" data-o="${obj === DP.lights ? 'l' : 'm'}">${label}</button>`;
  const seg = (key, opts) => `<div class="seg dp-seg">${opts.map(([v, l]) => `<button data-s="${key}" data-v="${v}" class="${String(DP[key]) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const sl = (key, label, min, max, step, unit) => `<div class="dp-sl"><label><input type="checkbox" data-h="${key}" ${DP.hold[key] ? 'checked' : ''}> ${label}</label>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${DP[key]}" data-r="${key}" ${DP.hold[key] ? '' : 'disabled'}><b>${DP[key]}${unit}</b></div>`;
  el.innerHTML = `
    <div class="row-between"><div class="label">Demo test panel</div><div><button class="btn ghost small" data-a="dock">${DP.top ? 'Move down ▼' : 'Move up ▲'}</button> <button class="btn ghost small" data-a="close">Hide</button></div></div>
    <label class="switch-row dp-man"><span>Map route <span class="mini">(bends, junctions, lights)</span></span><input type="checkbox" data-a="route" ${SET.demoRoute !== false ? 'checked' : ''}></label>
    <label class="switch-row dp-man"><span>Manual control <span class="mini">(off = demo runs by itself)</span></span><input type="checkbox" data-a="manual" ${DP.manual ? 'checked' : ''}></label>
    <div class="${DP.manual ? '' : 'dp-off'}">
      <div class="label">Lights</div>
      <div class="dp-row">${t('tail', 'Side / tail')}${t('low', 'Dipped')}${t('high', 'Main beam')}${t('brake', 'Brake')}${t('indL', '◀ Left')}${t('indR', 'Right ▶')}${t('hazard', 'Hazards')}${t('reverse', 'Reverse')}${t('fog', 'Rear fog')}</div>
      <div class="label">Gear and modes</div>
      ${seg('gear', [['P', 'P'], ['R', 'R'], ['N', 'N'], ['D', 'D'], ['B', 'B']])}
      <div class="dp-row">${t('eco', 'ECO', DP)}${t('ePedal', 'e-Pedal', DP)}${t('charging', 'Charging', DP)}${t('lowTyre', 'Low tyre', DP)}</div>
      ${DP.charging ? seg('chargeType', [[1, '3-pin'], [2, 'Wallbox'], [3, 'Rapid']]) : ''}
      <div class="label">Values <span class="mini">(tick to hold)</span></div>
      ${sl('speed', 'Speed', 0, 90, 1, SET.units === 'mph' ? ' mph' : ' km/h')}
      ${sl('kw', 'Power', -50, 110, 1, ' kW')}
      ${sl('soc', 'Charge', 0, 100, 1, '%')}
      ${sl('temp', 'Battery temp', -10, 50, 1, '°C')}
      <p class="hint">Dipped or Main beam dims the screen after a few seconds (night dimming). Low tyre and a Battery temp of 45°C or more show a gentle alert.</p>
      <p class="hint">Warp needs ECO off, Drive, and a high Power value (with warp set to Auto).</p>
    </div>`;
  el.querySelector('[data-a=dock]').onclick = () => { DP.top = !DP.top; dpRender(); };
  el.querySelector('[data-a=close]').onclick = () => { DP.open = false; dpRender(); };
  el.querySelector('[data-a=route]').onchange = e => { SET.demoRoute = e.target.checked; saveSettings(); if (e.target.checked) drtStart(); else drtStop(); };
  el.querySelector('[data-a=manual]').onchange = e => { DP.manual = e.target.checked; if (!DP.manual && DP.charging) { DP.charging = false; S.demoCharging = false; } dpRender(); };
  el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => {
    const o = b.dataset.o === 'l' ? DP.lights : DP, k = b.dataset.t;
    o[k] = !o[k];
    if (k === 'indL' && o[k]) DP.lights.indR = false;
    if (k === 'indR' && o[k]) DP.lights.indL = false;
    if (k === 'charging') S.demoCharging = DP.charging;
    dpRender();
  });
  el.querySelectorAll('[data-s]').forEach(b => b.onclick = () => {
    const k = b.dataset.s; DP[k] = k === 'chargeType' ? +b.dataset.v : b.dataset.v; dpRender();
  });
  el.querySelectorAll('[data-h]').forEach(c => c.onchange = () => { DP.hold[c.dataset.h] = c.checked; dpRender(); });
  el.querySelectorAll('[data-r]').forEach(r => r.oninput = () => { DP[r.dataset.r] = +r.value; r.nextElementSibling.textContent = r.value + r.nextElementSibling.textContent.replace(/^-?[\d.]+/, ''); });
}

LeafDash.on('mode', m => { if (m !== 'demo') { DP.manual = false; DP.charging = false; } dpRender(); });
dpRender();
