'use strict';
/* =====================================================================
   Settings: stored in this browser only (localStorage).
   ===================================================================== */

const SET_KEY = 'leafdash.settings';
/** Make text safe to put inside HTML (saved values, logins, messages from other services). */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CAR_COLOURS = [
  ['Pearl white', '#e6e8eb'], ['Silver', '#b4bac1'], ['Grey', '#5b626b'], ['Black', '#17191c'],
  ['Red', '#b3141f'], ['Blue', '#1f4fa3'], ['Copper', '#a8643a'], ['Teal', '#2c8c8a'],
];
const SET_DEFAULTS = {
  carColour: '#e6e8eb', carImage: null, carModel: 'model', warp: 'auto', units: 'mph', usableKwh: 39,
  chips: ['soc', 'range', 'eff', 'packTemp'],     // Drive screen bottom row
  realRoad: false, demoRoute: true, scenery: true,
  chargeScreen: true,                              // side view with the battery while charging                                 // draw the real road shape from OpenStreetMap
  layoutMode: 'simple',                            // 'simple' | 'advanced'
  layout: null,                                    // dashboard widgets (see dashboard.js)
  alerts: true,                                    // gentle alert banner (tyres, hot battery, cell drift, 12 V)
  voice: false,                                    // spoken updates
  nightDim: 'auto',                                // dim the screen with the headlights: 'auto' | 'off'
  limitNudge: true,                                // pulse the speed-limit sign when over it
  cameras: true,                                   // speed and red-light cameras from OpenStreetMap on the Drive screen
  autoReconnect: true,                             // get back to the adapter by itself
  lastBackup: 0,                                   // when a backup file was last saved (ms)
  lastAdapter: null,                               // { id, name } of the adapter used last
  prices: { threepin: 28, wallbox: 28, public: 55, rapid: 79 },   // pence per kWh, by how the car was charged
  dev: false,                                      // Developer mode shows the Debug tab
  addons: {},                                      // per add-on: { enabled, ...config }
};
const SET = Object.assign(structuredClone(SET_DEFAULTS),
  (() => { try { return JSON.parse(localStorage.getItem(SET_KEY)) || {}; } catch { return {}; } })());
function saveSettings() {
  if (window.LD_RESTORING) return;
  try { localStorage.setItem(SET_KEY, JSON.stringify(SET)); }
  catch (e) { typeof log === 'function' && log('Could not save settings: ' + e.message); }
}

/* ---------------- generic sheet ---------------- */
function openSheet(html, { onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal sheet">${html}</div>`;
  document.body.appendChild(wrap);
  const close = () => { wrap.remove(); onClose?.(); };
  wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
  wrap.querySelectorAll('[data-x]').forEach(b => b.onclick = close);
  return { wrap, box: wrap.querySelector('.sheet'), close };
}

/** Yes/no confirmation sheet. Resolves true/false. */
function confirmSheet({ title, body, ok = 'OK', danger = false, requireTick = null }) {
  return new Promise(res => {
    const s = openSheet(`
      <h3>${title}</h3><div class="modal-body">${body}</div>
      ${requireTick ? `<label class="tick"><input type="checkbox" data-tick> <span>${requireTick}</span></label>` : ''}
      <div class="modal-actions"><button class="btn ghost" data-a="no">Cancel</button>
      <button class="btn ${danger ? 'danger' : 'primary'}" data-a="yes" ${requireTick ? 'disabled' : ''}>${ok}</button></div>`,
      { onClose: () => res(false) });
    const yes = s.box.querySelector('[data-a=yes]');
    s.box.querySelector('[data-tick]')?.addEventListener('change', e => { yes.disabled = !e.target.checked; });
    s.box.querySelector('[data-a=no]').onclick = () => { s.wrap.remove(); res(false); };
    yes.onclick = () => { s.wrap.remove(); res(true); };
  });
}

/* ---------------- the settings sheet ---------------- */
function openSettings(section) {
  if (typeof SAFE !== 'undefined' && SAFE.locked) return safeBlocked('Settings are');   // locked while the car is moving (alerts.js)
  const metricOpts = sel => Object.values(LeafDash.metrics)
    .map(m => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${m.label}</option>`).join('');
  const s = openSheet(`
    <div class="row-between"><h3>Settings</h3><button class="btn ghost small" data-x>Done</button></div>

    <details class="set-sec" data-sec="dashboard" name="ldset">
      <summary><span class="ss-title">Dashboard</span><span class="ss-sub" data-sub="dashboard"></span></summary>
      <div class="ss-body">
      <div class="set-group"><div class="label">Layout editor</div>
        <div class="seg" data-g="layoutMode">
          <button data-v="simple">Simple: pick &amp; reorder</button><button data-v="advanced">Advanced: resize too</button>
        </div>
      </div>
      <button class="btn ghost small" data-a="editDash">Edit dashboard…</button>
      </div>
    </details>

    <details class="set-sec" data-sec="drive" name="ldset">
      <summary><span class="ss-title">Drive screen</span><span class="ss-sub" data-sub="drive"></span></summary>
      <div class="ss-body">
      <div class="set-group"><div class="label">Bottom row</div>
        <div class="chip-pick">${SET.chips.map((c, i) => `<select data-chip="${i}">${metricOpts(c)}</select>`).join('')}</div>
      </div>
      <div class="set-group"><div class="label">Charging screen</div>
        <label class="switch-row"><span>Show the battery view while the car is charging</span><input type="checkbox" data-chg ${SET.chargeScreen !== false ? 'checked' : ''}></label>
      </div>
      <div class="set-group"><div class="label">Real road shape</div>
        <label class="switch-row"><span>Draw the road you're on (curves, lanes, speed limit) from OpenStreetMap</span><input type="checkbox" data-real ${SET.realRoad ? 'checked' : ''}></label>
        <p class="hint">Uses GPS and a little mobile data. Falls back to the straight road when there's no GPS or map data. Map areas you've driven are kept on this phone for 30 days, so the same roads load without downloading again.</p>
        <p class="hint"><button class="btn ghost small" data-osmc-clear>Forget saved map areas</button> <span data-osmc-n></span></p>
      </div>
      <div class="set-group"><div class="label">Offline maps</div>
        ${offmapCanDownload() ? `<p class="hint">Download the counties you drive in, and their roads load from the phone: no map server, nothing sent, works with no signal. They're used when Real road shape (above) is on. <span data-off-n></span></p>
        <p class="hint"><button class="btn ghost small" data-off-open>Choose counties…</button></p>
        <label class="switch-row"><span>Only use offline maps (never ask the map servers)</span><input type="checkbox" data-sw="offlineOnly" ${SET.offlineOnly ? 'checked' : ''}></label>`
        : `<p class="hint">In the Leaf Dash Android app you can download county maps, so roads load from the phone without the map servers. The website can't download them. <span data-off-n></span></p>`}
      </div>
      <div class="set-group"><div class="label">Scenery</div>
        <label class="switch-row"><span>Trees, hedges, houses and lamp posts beside the road</span><input type="checkbox" data-sw="scenery" ${SET.scenery !== false ? 'checked' : ''}></label>
        <p class="hint">Drawn by the app to suit the road (town, countryside or fast road); nothing extra is downloaded.</p>
      </div>
      <div class="set-group"><div class="label">Warp effect</div>
        <div class="seg" data-g="warp"><button data-v="auto">Auto (off in ECO)</button><button data-v="always">Always</button><button data-v="off">Off</button></div>
      </div>
      </div>
    </details>

    <details class="set-sec" data-sec="car" name="ldset">
      <summary><span class="ss-title">Car picture</span><span class="ss-sub" data-sub="car"></span></summary>
      <div class="ss-body">
      <div class="set-group"><div class="label">Car model</div>
        <div class="seg" data-g="carModel"><button data-v="model">Leaf model</button><button data-v="drawn">Simple drawn car</button></div>
      </div>
      <div class="set-group"><div class="label">Car colour</div>
        <div class="swatches">${CAR_COLOURS.map(([n, c]) => `<button class="sw" data-c="${c}" title="${n}" style="background:${c}"></button>`).join('')}</div>
      </div>
      <div class="set-group"><div class="label">Your own car picture</div>
        <p class="hint">A photo from behind and a little above. In Samsung Gallery, long-press the car → <b>Save as image</b> for a cut-out.</p>
        <div class="row-between">
          <label class="btn ghost small">Choose image<input type="file" accept="image/*" hidden data-img></label>
          <button class="btn ghost small" data-a="rmimg">Use drawn car</button>
        </div>
      </div>
      </div>
    </details>

    <details class="set-sec" data-sec="units" name="ldset">
      <summary><span class="ss-title">Units and battery</span><span class="ss-sub" data-sub="units"></span></summary>
      <div class="ss-body">
      <div class="set-group"><div class="label">Units</div>
        <div class="seg" data-g="units"><button data-v="mph">miles</button><button data-v="kmh">km</button></div>
      </div>
      <div class="set-group"><div class="label">Usable battery (kWh) for range estimate</div>
        <input class="num" type="number" min="10" max="80" step="0.5" value="${SET.usableKwh}" data-kwh>
      </div>
      </div>
    </details>

    <details class="set-sec" data-sec="driving" name="ldset">
      <summary><span class="ss-title">Alerts and driving aids</span><span class="ss-sub" data-sub="driving"></span></summary>
      <div class="ss-body">
      <label class="switch-row"><span>Gentle alerts <span class="mini">a quiet banner for a low tyre, a hot battery, a drifting cell or a low 12 V battery</span></span>
        <input type="checkbox" data-sw="alerts" ${SET.alerts !== false ? 'checked' : ''}></label>
      <label class="switch-row"><span>Speed limit nudge <span class="mini">the limit sign pulses when you're more than 3 mph over (needs the real road shape)</span></span>
        <input type="checkbox" data-sw="limitNudge" ${SET.limitNudge !== false ? 'checked' : ''}></label>
      <label class="switch-row"><span>Cameras <span class="mini">speed and red-light cameras mapped on OpenStreetMap, shown ahead (and spoken, with spoken updates on). Needs the real road shape</span></span>
        <input type="checkbox" data-sw="cameras" ${SET.cameras !== false ? 'checked' : ''}></label>
      <label class="switch-row"><span>Dim the screen at night <span class="mini">while the headlights are on</span></span>
        <input type="checkbox" data-night ${SET.nightDim !== 'off' ? 'checked' : ''}></label>
      <label class="switch-row"><span>Spoken updates <span class="mini">battery milestones, charging started and stopped, alerts</span></span>
        <input type="checkbox" data-sw="voice" ${SET.voice ? 'checked' : ''}></label>
      <button class="btn ghost small" data-a="testVoice">Test the voice</button>
      <label class="switch-row"><span>Reconnect by itself <span class="mini">after a dropped connection, and when the app opens if the browser allows it</span></span>
        <input type="checkbox" data-sw="autoReconnect" ${SET.autoReconnect !== false ? 'checked' : ''}></label>
      </div>
    </details>

    <details class="set-sec" data-sec="costs" name="ldset">
      <summary><span class="ss-title">Running costs</span><span class="ss-sub" data-sub="costs"></span></summary>
      <div class="ss-body">
      <p class="hint">Price per kWh for each way of charging. Tap a charge on the Energy tab to change its type.</p>
      <div class="price-grid">${Object.entries(CHG_TYPES).map(([k, v]) => `<label><span>${v.name}</span>
        <span class="price-in"><input class="num" type="number" inputmode="decimal" min="0" max="500" step="0.1" value="${chgPrice(k)}" data-price="${k}"><em>p / kWh</em></span></label>`).join('')}</div>
      </div>
    </details>

    <details class="set-sec" data-sec="addons" name="ldset">
      <summary><span class="ss-title">Add-ons</span><span class="ss-sub" data-sub="addons"></span></summary>
      <div class="ss-body">
      <p class="hint">Each one asks before it sends anything. Add-ons only send data <b>out</b>; they can't send anything to the car.</p>
      <div id="addonList"></div>
      </div>
    </details>

    ${bkSectionHtml()}

    <details class="set-sec" data-sec="dev" name="ldset">
      <summary><span class="ss-title">Developer mode</span><span class="ss-sub" data-sub="dev"></span></summary>
      <div class="ss-body">
      <label class="switch-row"><span>Show the Debug tab (raw data, log, read-only tools)</span>
        <input type="checkbox" data-dev ${SET.dev ? 'checked' : ''}></label>
      </div>
    </details>

    <details class="set-sec" data-sec="about" name="ldset">
      <summary><span class="ss-title">About</span><span class="ss-sub" data-sub="about"></span></summary>
      <div class="ss-body">
      <p class="hint">Leaf Dash ${LeafDash.version}. <b>Read-only by design:</b> the app can only send adapter set-up commands and read requests (21 xx / 22 xx xx). Anything that could change the car is blocked before it reaches the adapter, with no override. Settings and any add-on credentials are stored only in this browser. What leaves this phone is listed in Your data, and in the <a href="https://a2405u.github.io/Leafdash/privacy.html" target="_blank" rel="noopener">privacy policy</a>.</p>
      <p class="hint">Don't use your phone while driving. Settings and the Debug tab lock while the car is moving.</p>
      <p class="hint">Copyright (C) 2026 A2405U and contributors. Free software under the GNU GPL v3.0, with no warranty. Not affiliated with Nissan; Nissan and Leaf are trademarks of Nissan.</p>
      </div>
    </details>`,
    { onClose: () => { saveSettings(); render(); renderDash?.(); } });

  const box = s.box;
  // segmented controls bound to SET keys
  box.querySelectorAll('.seg[data-g]').forEach(seg => {
    const key = seg.dataset.g;
    const mark = () => seg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.v === SET[key]));
    seg.querySelectorAll('button').forEach(b => b.onclick = () => { SET[key] = b.dataset.v; mark(); saveSettings(); if (key === 'layoutMode') renderDash?.(); });
    mark();
  });
  const markSw = () => box.querySelectorAll('[data-c]').forEach(x => x.classList.toggle('on', !SET.carImage && x.dataset.c === SET.carColour));
  box.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { SET.carColour = b.dataset.c; SET.carImage = null; markSw(); renderCar(); saveSettings(); });
  markSw();
  box.querySelectorAll('[data-chip]').forEach(sel => sel.onchange = () => { SET.chips[+sel.dataset.chip] = sel.value; saveSettings(); });
  box.querySelector('[data-kwh]').onchange = e => { const v = parseFloat(e.target.value); if (v >= 10 && v <= 80) { SET.usableKwh = v; saveSettings(); } };
  box.querySelector('[data-a=rmimg]').onclick = () => { SET.carImage = null; markSw(); renderCar(); saveSettings(); };
  box.querySelector('[data-img]').onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 900 / img.width), c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      SET.carImage = c.toDataURL('image/png'); URL.revokeObjectURL(img.src);
      markSw(); renderCar(); saveSettings();
    };
    img.src = URL.createObjectURL(f);
  };
  box.querySelector('[data-chg]').onchange = e => { SET.chargeScreen = e.target.checked; saveSettings(); };
  box.querySelector('[data-real]').onchange = async e => {
    if (!e.target.checked) { SET.realRoad = false; saveSettings(); return; }
    e.target.checked = false;
    const ok = await confirmSheet({
      title: 'Use OpenStreetMap road data?',
      body: '<p>To download the roads around you, Leaf Dash sends your <b>rough location</b> (which block of about 220 × 140 m you\'re in, not the exact spot) to the public Overpass API servers that serve OpenStreetMap data, roughly every 300 m you travel.</p><p class="hint">No car data is sent. Map data © OpenStreetMap contributors.</p>',
      ok: 'Turn on', requireTick: 'I understand my location is sent to download map data',
    });
    if (ok) { SET.realRoad = true; e.target.checked = true; saveSettings(); }
  };
  box.querySelectorAll('[data-sw]').forEach(c => c.onchange = () => { SET[c.dataset.sw] = c.checked; saveSettings(); });
  // remembered map areas (osmroad.js): how many, and a button to forget them
  const osmcShow = () => osmcCount().then(n => { const el = box.querySelector('[data-osmc-n]'); if (el) el.textContent = n ? `${n} saved` : 'none saved'; });
  if (typeof osmcCount === 'function') osmcShow();
  box.querySelector('[data-osmc-clear]')?.addEventListener('click', async () => { await osmcClear(); osmcShow(); });
  if (typeof offmapSummary === 'function') offmapSummary();
  box.querySelector('[data-off-open]')?.addEventListener('click', () => offmapSheet());
  box.querySelector('[data-night]').onchange = e => { SET.nightDim = e.target.checked ? 'auto' : 'off'; saveSettings(); };
  box.querySelector('[data-a=testVoice]').onclick = () => {
    if (!window.speechSynthesis) return alert('This browser has no built-in voice.');
    say('Battery 20 percent. About 25 miles left.', true);
  };
  box.querySelectorAll('[data-price]').forEach(inp => inp.onchange = () => {
    const v = parseFloat(inp.value);
    if (v >= 0 && v <= 500) { (SET.prices ||= {})[inp.dataset.price] = v; saveSettings(); }
  });
  bkBind(box);
  box.querySelector('[data-dev]').onchange = e => { SET.dev = e.target.checked; saveSettings(); applyDevMode(); };
  box.querySelector('[data-a=editDash]').onclick = () => { s.close(); showView('dash'); dashEdit(true); };
  renderAddonsSection(box.querySelector('#addonList'));

  // one line under each heading saying how it's set, refreshed whenever a section is opened or closed
  const subs = () => {
    const on = Object.values(LeafDash.addons).filter(x => SET.addons?.[x.id]?.enabled).map(x => x.name);
    const t = {
      dashboard: SET.layoutMode === 'advanced' ? 'Advanced editor' : 'Simple editor',
      drive: [SET.realRoad ? 'Real road on' : 'Real road off', `warp ${SET.warp}`].join(' · '),
      car: SET.carImage ? 'Your own photo' : SET.carModel === 'drawn' ? 'Simple drawn car' : 'Leaf model',
      units: `${SET.units === 'mph' ? 'Miles' : 'Kilometres'} · ${SET.usableKwh} kWh`,
      driving: [SET.alerts !== false ? 'Alerts on' : 'Alerts off', SET.voice ? 'voice on' : 'voice off'].join(' · '),
      costs: `${chgPrice('wallbox')}p home · ${chgPrice('rapid')}p rapid`,
      addons: on.length ? on.join(', ') : 'None on',
      data: `Last backup ${bkAgo(SET.lastBackup)}`,
      dev: SET.dev ? 'On' : 'Off',
      about: `Version ${LeafDash.version} · read-only`,
    };
    box.querySelectorAll('[data-sub]').forEach(el => { el.textContent = t[el.dataset.sub] || ''; });
  };
  subs();
  box.querySelectorAll('details.set-sec').forEach(d => d.addEventListener('toggle', () => {
    // only one section open at a time (for browsers that don't do this from the shared name)
    if (d.open) box.querySelectorAll('details.set-sec[open]').forEach(o => { if (o !== d) o.open = false; });
    subs();
    if (d.open) d.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }));

  if (section) { const d = box.querySelector(`[data-sec="${section}"]`); if (d) { d.open = true; d.scrollIntoView({ block: 'start' }); } }
}

/* Debug tab only in Developer mode */
function applyDevMode() {
  const b = document.querySelector('.tabs button[data-view="debug"]');
  if (b) b.classList.toggle('hidden', !SET.dev);
  if (!SET.dev && S.view === 'debug') showView('drive');
}

function showView(v) {
  document.querySelector(`.tabs button[data-view="${v}"]`)?.click();
}
