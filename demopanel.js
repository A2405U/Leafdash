'use strict';
/* =====================================================================
   Demo test panel: only in Demo mode. Switch lights, gear, ECO,
   charging etc. by hand to check how each part of the app looks.
   Nothing here talks to the car.
   ===================================================================== */

const DP = {
  open: false, manual: false, top: false, tab: 'route',
  sim: { slow: false, aux: false, tyre: false, hot: false, lock: false },   // Simulate tab: work without manual control
  dropUntil: 0,
  lights: { tail: true, low: false, high: false, brake: false, indL: false, indR: false, hazard: false, reverse: false, fog: false },
  gear: 'D', eco: false, ePedal: false,
  charging: false, chargeType: 1,             // 1 = 3-pin, 2 = wallbox, 3 = rapid
  customKw: false, chargePower: 25,           // Car tab: your own charging power (kW) for the chosen charger type
  speed: 40, kw: 20, soc: 78, temp: 14,
  hold: { speed: false, kw: false, soc: false, temp: false },
};
const CHARGE_KW = { 1: 2.3, 2: 6.6, 3: 42 };

/** Called by the demo generator after it builds S.data. */
function demoApply(d) {
  // Simulate tab: always applied
  if (DP.sim.aux) d.aux = 11.6;                                           // a low 12 V battery
  if (DP.sim.tyre) { d.tyreRL = 196; if (Array.isArray(d.tyres)) d.tyres[2] = 196; }   // about 28 psi
  if (DP.sim.hot) d.temps = [47, 48, null, 46];
  if (!DP.manual) return d;
  const L = DP.lights, hz = L.hazard;
  d.demoLights = { tail: L.tail || L.low || L.high, low: L.low, high: L.high, brake: L.brake,
    indL: L.indL || hz, indR: L.indR || hz, reverse: L.reverse || DP.gear === 'R', fog: L.fog };
  d.gear = DP.gear; d.eco = DP.eco; d.ePedal = DP.ePedal;
  if (DP.hold.speed) d.speed = DP.speed * (SET.units === 'mph' ? 1.609344 : 1);
  if (DP.hold.kw) { d.kw = DP.kw; d.motorKw = Math.max(0, DP.kw - 1.3); d.current = DP.kw * 1000 / (d.voltage || 370); }
  if (DP.hold.soc) d.soc = DP.soc;
  if (DP.hold.temp) d.temps = [DP.temp, DP.temp + 1, null, DP.temp];
  if (DP.gear === 'R' && !DP.hold.speed) { d.speed = 6; if (!DP.hold.kw) d.kw = 4; }
  if (DP.gear === 'P' || DP.gear === 'N') { d.speed = 0; d.motorKw = 0; if (!DP.hold.kw) d.kw = 0.4; }
  if (DP.charging) {
    const kw = DP.customKw ? DP.chargePower : CHARGE_KW[DP.chargeType];   // the charger type still sets the cable and colours
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
  fab.classList.toggle('hidden', !on || (typeof RP !== 'undefined' && RP.on));
  fab.classList.toggle('on', DP.open);
  el.classList.toggle('hidden', !on || !DP.open); el.classList.toggle('top', DP.top);
  if (!on || !DP.open) return;
  const t = (k, label, obj = DP.lights) => `<button class="dp-t ${obj[k] ? 'on' : ''}" data-t="${k}" data-o="${obj === DP.lights ? 'l' : obj === DP.sim ? 's' : 'm'}">${label}</button>`;
  const seg = (key, opts) => `<div class="seg dp-seg">${opts.map(([v, l]) => `<button data-s="${key}" data-v="${v}" class="${String(DP[key]) === String(v) ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const sl = (key, label, min, max, step, unit) => `<div class="dp-sl"><label><input type="checkbox" data-h="${key}" ${DP.hold[key] ? 'checked' : ''}> ${label}</label>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${DP[key]}" data-r="${key}" ${DP.hold[key] ? '' : 'disabled'}><b>${DP[key]}${unit}</b></div>`;
  const route = SET.demoRoute !== false;
  const tabs = `<div class="seg dp-tabs">${[['route', 'Route'], ['car', 'Car'], ['sim', 'Simulate']].map(([v, l]) => `<button data-tab="${v}" class="${DP.tab === v ? 'active' : ''}">${l}</button>`).join('')}</div>`;
  const body = {
    route: `
      <label class="switch-row dp-man"><span>Map route <span class="mini">(bends, junctions, lights, cameras; town, country and fast roads)</span></span><input type="checkbox" data-a="route" ${route ? 'checked' : ''}></label>
      <div class="${route ? '' : 'dp-off'}">
        <div class="label">Demo speed</div>
        <div class="seg dp-seg">${[1, 2, 4].map(x => `<button data-rate="${x}" class="${(DRT.rate || 1) === x ? 'active' : ''}">${x}×</button>`).join('')}</div>
        <div class="label">Jump to</div>
        <div class="dp-row">${[['lights', 'Lights'], ['zebra', 'Zebra'], ['speedcam', 'Speed camera'], ['dual', 'Dual carriageway'], ['redcam', 'Red-light camera'], ['rbt', 'Roundabout'], ['mini', 'Mini roundabout']].map(([k, l]) => `<button class="dp-t" data-jump="${k}">${l}</button>`).join('')}</div>
        <div class="label">GPS</div>
        <div class="dp-row"><button class="dp-t ${Date.now() < DRT.lostUntil ? 'on' : ''}" data-a="lose">${Date.now() < DRT.lostUntil ? 'GPS lost…' : 'Lose GPS 15 s'}</button></div>
        <p class="hint">Scenery follows the road: houses on Elm Road and High Road (town), hedges on Station Road (40 mph, country), lamp posts on the A40.</p>
      </div>`,
    car: `
      <label class="switch-row dp-man"><span>Manual control <span class="mini">(off = demo runs by itself)</span></span><input type="checkbox" data-a="manual" ${DP.manual ? 'checked' : ''}></label>
      <div class="${DP.manual ? '' : 'dp-off'}">
        <div class="label">Lights</div>
        <div class="dp-row">${t('tail', 'Side / tail')}${t('low', 'Dipped')}${t('high', 'Main beam')}${t('brake', 'Brake')}${t('indL', '◀ Left')}${t('indR', 'Right ▶')}${t('hazard', 'Hazards')}${t('reverse', 'Reverse')}${t('fog', 'Rear fog')}</div>
        <div class="label">Gear and modes</div>
        ${seg('gear', [['P', 'P'], ['R', 'R'], ['N', 'N'], ['D', 'D'], ['B', 'B']])}
        <div class="dp-row">${t('eco', 'ECO', DP)}${t('ePedal', 'e-Pedal', DP)}${t('charging', 'Charging', DP)}</div>
        ${DP.charging ? seg('chargeType', [[1, '3-pin'], [2, 'Wallbox'], [3, 'Rapid']]) + `
        <div class="dp-sl"><label><input type="checkbox" data-a="ckw" ${DP.customKw ? 'checked' : ''}> Custom power</label>
          <input type="range" min="0.5" max="50" step="0.5" value="${DP.chargePower}" data-ckw ${DP.customKw ? '' : 'disabled'}><b>${DP.chargePower} kW</b></div>
        <p class="hint">The charger type sets the cable and the battery colour; the power sets the flow speed and the times. 50 kW is the most the 40 kWh Leaf takes.</p>` : ''}
        <div class="label">Values <span class="mini">(tick to hold)</span></div>
        ${sl('speed', 'Speed', 0, 90, 1, SET.units === 'mph' ? ' mph' : ' km/h')}
        ${sl('kw', 'Power', -50, 110, 1, ' kW')}
        ${sl('soc', 'Charge', 0, 100, 1, '%')}
        ${sl('temp', 'Battery temp', -10, 50, 1, '°C')}
        <p class="hint">Warp needs ECO off, Drive, and a high Power value (with warp set to Auto).</p>
      </div>`,
    sim: `
      <div class="label">Adapter</div>
      <div class="dp-row">${t('slow', 'Slow link', DP.sim)}<button class="dp-t ${DP.dropUntil > Date.now() ? 'on' : ''}" data-a="drop">${DP.dropUntil > Date.now() ? 'Reconnecting…' : 'Drop out 8 s'}</button></div>
      <div class="label">Alerts</div>
      <div class="dp-row">${t('tyre', 'Low tyre', DP.sim)}${t('aux', '12 V low', DP.sim)}${t('hot', 'Hot battery', DP.sim)}</div>
      <div class="label">Driving</div>
      <div class="dp-row">${t('lock', 'Driving lock', DP.sim)}<button class="dp-t" data-a="warn">Show "Before you drive"</button><button class="dp-t" data-a="voice">Test voice</button></div>
      <p class="hint">Alerts show after a few seconds in Demo. With Driving lock on, Settings and Debug lock while the demo car is moving, as they do in the car. Nothing here talks to the car.</p>`,
  }[DP.tab];
  el.innerHTML = `
    <div class="row-between"><div class="label">Demo test panel</div><div><button class="btn ghost small" data-a="dock">${DP.top ? 'Move down ▼' : 'Move up ▲'}</button> <button class="btn ghost small" data-a="close">Hide</button></div></div>
    ${tabs}${body}`;
  el.querySelector('[data-a=dock]').onclick = () => { DP.top = !DP.top; dpRender(); };
  el.querySelector('[data-a=close]').onclick = () => { DP.open = false; dpRender(); };
  el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { DP.tab = b.dataset.tab; dpRender(); });
  el.querySelector('[data-a=route]')?.addEventListener('change', e => { SET.demoRoute = e.target.checked; saveSettings(); if (e.target.checked) drtStart(); else drtStop(); dpRender(); });
  el.querySelector('[data-a=manual]')?.addEventListener('change', e => { DP.manual = e.target.checked; if (!DP.manual && DP.charging) { DP.charging = false; S.demoCharging = false; } dpRender(); });
  el.querySelector('[data-a=ckw]')?.addEventListener('change', e => { DP.customKw = e.target.checked; dpRender(); });
  el.querySelector('[data-ckw]')?.addEventListener('input', e => { DP.chargePower = +e.target.value; e.target.nextElementSibling.textContent = `${DP.chargePower} kW`; });
  el.querySelectorAll('[data-rate]').forEach(b => b.onclick = () => { DRT.rate = +b.dataset.rate; dpRender(); });
  el.querySelectorAll('[data-jump]').forEach(b => b.onclick = () => drtJump(b.dataset.jump));
  el.querySelector('[data-a=lose]')?.addEventListener('click', () => { DRT.lostUntil = Date.now() + 15000; dpRender(); setTimeout(dpRender, 15100); });
  el.querySelector('[data-a=drop]')?.addEventListener('click', () => dpDropOut());
  el.querySelector('[data-a=warn]')?.addEventListener('click', () => safeWarn());
  el.querySelector('[data-a=voice]')?.addEventListener('click', () => say('Red-light camera ahead', true));
  el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => {
    const o = { l: DP.lights, s: DP.sim, m: DP }[b.dataset.o], k = b.dataset.t;
    o[k] = !o[k];
    if (k === 'indL' && o[k]) DP.lights.indR = false;
    if (k === 'indR' && o[k]) DP.lights.indL = false;
    if (k === 'charging') S.demoCharging = DP.charging;
    if (k === 'slow' && typeof linkTick === 'function') linkTick();
    dpRender();
  });
  el.querySelectorAll('[data-s]').forEach(b => b.onclick = () => {
    const k = b.dataset.s; DP[k] = k === 'chargeType' ? +b.dataset.v : b.dataset.v; dpRender();
  });
  el.querySelectorAll('[data-h]').forEach(c => c.onchange = () => { DP.hold[c.dataset.h] = c.checked; dpRender(); });
  el.querySelectorAll('[data-r]').forEach(r => r.oninput = () => { DP[r.dataset.r] = +r.value; r.nextElementSibling.textContent = r.value + r.nextElementSibling.textContent.replace(/^-?[\d.]+/, ''); });
}

/** Test panel: the adapter drops out for 8 s, like switching the car off at a petrol station, then comes back. */
function dpDropOut() {
  if (S.mode !== 'demo' || DP.dropUntil > Date.now()) return;
  DP.dropUntil = Date.now() + 8000;
  const st = $('status');
  st.className = 'status busy'; st.querySelector('span').textContent = 'Reconnecting…';
  log('Demo: adapter disconnected'); log('Reconnecting in 2 s (try 1)');
  dpRender();
  setTimeout(() => {
    if (S.mode !== 'demo') return;
    st.className = 'status demo'; st.querySelector('span').textContent = 'Demo';
    log('Demo: connected again');
    dpRender();
  }, 8000);
}

LeafDash.on('mode', m => { if (m !== 'demo') { DP.manual = false; DP.charging = false; DP.sim = { slow: false, aux: false, tyre: false, hot: false, lock: false }; DP.dropUntil = 0; DP.customKw = false; if (typeof DRT !== 'undefined') DRT.rate = 1; } dpRender(); });
dpRender();
