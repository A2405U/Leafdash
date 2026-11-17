'use strict';
/* =====================================================================
   Add-ons: send live car data OUT to other services.
   ---------------------------------------------------------------------
   • Off by default. Enabling one shows exactly what will be sent and
     where, and needs you to tick "I understand".
   • Only runs while connected to the real car (never in Demo).
   • Add-ons get a read-only snapshot of the data. They have no access to
     the adapter, so they can't send anything to the car.
   • Credentials are stored only in this browser.

   Writing your own: see README.md → "Extending Leaf Dash".
   ===================================================================== */

const AO = {};   // runtime state per add-on: { status, cls, lastSent, ctx }

function addonCfg(a) {
  const c = SET.addons[a.id] ||= { enabled: false };
  for (const f of a.fields) if (c[f.key] === undefined && f.default !== undefined) c[f.key] = f.default;
  return c;
}
function addonStatus(id, text, cls = '') {
  (AO[id] ||= {}).status = text; AO[id].cls = cls;
  const el = document.querySelector(`[data-addon-status="${id}"]`);
  if (el) { el.textContent = text; el.className = 'addon-status ' + cls; }
}
const addonApi = id => ({
  status: (t, cls) => addonStatus(id, t, cls),
  log: m => log(`[${LeafDash.addons[id].name}] ${m}`),
});

async function startAddon(a) {
  const c = addonCfg(a);
  AO[a.id] = { ...(AO[a.id] || {}), lastSent: 0 };
  try { AO[a.id].ctx = await a.start?.(c, addonApi(a.id)); addonStatus(a.id, S.mode === 'on' ? 'Running' : 'Enabled: waits until you connect to the car', 'ok'); }
  catch (e) { addonStatus(a.id, 'Could not start: ' + e.message, 'err'); }
}
async function stopAddon(a) {
  try { await a.stop?.(AO[a.id]?.ctx, addonCfg(a), addonApi(a.id)); } catch {}
  AO[a.id] = { status: 'Off' };
  addonStatus(a.id, 'Off');
}

/* fan live data out to enabled add-ons, each at its own interval */
LeafDash.on('data', () => {
  if (S.mode !== 'on') return;                    // never send demo data
  const snap = LeafDash.snapshot(), now = Date.now();
  for (const a of Object.values(LeafDash.addons)) {
    const c = addonCfg(a);
    if (!c.enabled) continue;
    const st = AO[a.id] ||= {};
    const every = Math.max(a.minInterval || 5, +c.interval || a.minInterval || 10) * 1000;
    if (st.busy || now - (st.lastSent || 0) < every) continue;
    st.busy = true; st.lastSent = now;
    const s = { ...snap };
    if (!c.location) { s.lat = null; s.lon = null; }
    Promise.resolve(a.send(s, c, addonApi(a.id), st.ctx))
      .catch(e => addonStatus(a.id, e.message, 'err'))
      .finally(() => { st.busy = false; });
  }
});
LeafDash.on('mode', m => {
  for (const a of Object.values(LeafDash.addons)) if (addonCfg(a).enabled) a.onMode?.(m, AO[a.id]?.ctx, addonCfg(a));
});
LeafDash.on('ready', () => { for (const a of Object.values(LeafDash.addons)) if (addonCfg(a).enabled) startAddon(a); });

/* ---------------- settings UI ---------------- */
function renderAddonsSection(box) {
  box.innerHTML = Object.values(LeafDash.addons).map(a => {
    const c = addonCfg(a);
    return `<div class="addon" data-addon="${a.id}">
      <div class="addon-head"><b>${a.name}</b>
        <label class="switch-row" style="padding:0"><input type="checkbox" data-en ${c.enabled ? 'checked' : ''} aria-label="Enable ${a.name}"></label></div>
      <p class="hint">${a.description}</p>
      <div class="addon-status ${AO[a.id]?.cls || ''}" data-addon-status="${a.id}">${AO[a.id]?.status || (c.enabled ? 'Enabled' : 'Off')}</div>
      <details><summary class="hint">Set up</summary>
        <div class="addon-cfg">${a.fields.map(f => f.type === 'bool'
          ? `<label class="switch-row"><span>${f.label}</span><input type="checkbox" data-k="${f.key}" ${c[f.key] ? 'checked' : ''}></label>`
          : `<label><span>${f.label}</span><input data-k="${f.key}" type="${f.type || 'text'}" value="${c[f.key] ?? ''}" placeholder="${f.placeholder || ''}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`).join('')}
          ${a.help ? `<p class="hint">${a.help}</p>` : ''}
          <p class="hint">Credentials are saved only in this browser on this device.</p>
        </div></details>
    </div>`;
  }).join('');

  box.querySelectorAll('.addon').forEach(card => {
    const a = LeafDash.addons[card.dataset.addon], c = addonCfg(a);
    card.querySelectorAll('[data-k]').forEach(inp => inp.onchange = () => {
      const f = a.fields.find(x => x.key === inp.dataset.k);
      c[f.key] = f.type === 'bool' ? inp.checked : f.type === 'number' ? +inp.value : inp.value.trim();
      saveSettings();
      if (c.enabled) { stopAddon(a).then(() => startAddon(a)); }   // apply changes
    });
    const en = card.querySelector('[data-en]');
    en.onchange = async () => {
      if (!en.checked) { c.enabled = false; saveSettings(); stopAddon(a); return; }
      en.checked = false;
      const problem = a.validate?.(c);
      if (problem) { addonStatus(a.id, problem, 'err'); card.querySelector('details').open = true; return; }
      const ok = await confirmSheet({
        title: `Enable ${a.name}?`,
        body: `<p>While Leaf Dash is open and connected to your car, it will send this to <b>${a.destination(c)}</b> every ${Math.max(a.minInterval || 5, +c.interval || 10)} seconds:</p>
          <ul class="sends">${a.sends(c).map(x => `<li>${x}</li>`).join('')}</ul>
          <p class="hint">Nothing is sent in Demo mode. Add-ons only send data out to this service. They can't send anything to your car. You can turn this off any time in Settings → Add-ons.</p>`,
        ok: 'Enable', requireTick: `I understand my car's data will be sent to ${a.destination(c)}`,
      });
      if (!ok) return;
      c.enabled = true; en.checked = true; saveSettings();
      startAddon(a);
    };
  });
}

/* ---------------- shared field lists ---------------- */
const HA_SENSORS = [
  // key, name, unit, device_class, snapshot field
  ['soc', 'State of charge', '%', 'battery', 'soc'],
  ['power', 'Battery power', 'kW', 'power', 'power_kw'],
  ['range', 'Range (car estimate)', 'km', 'distance', 'est_range_km'],
  ['soh', 'Battery health', '%', null, 'soh'],
  ['battery_temp', 'Battery temperature', '°C', 'temperature', 'batt_temp'],
  ['aux_12v', '12V battery', 'V', 'voltage', 'aux_12v'],
  ['speed', 'Speed', 'km/h', 'speed', 'speed_kmh'],
  ['outside_temp', 'Outside temperature', '°C', 'temperature', 'ext_temp'],
  ['odometer', 'Odometer', 'km', 'distance', 'odometer_km'],
  ['cell_spread', 'Cell spread', 'mV', null, 'cell_spread_mv'],
  ['gear', 'Gear', null, null, 'gear'],
  ['heater_power', 'Heater power', 'kW', 'power', 'heater_kw'],
  ['climate', 'Climate on', null, null, 'climate_on'],
  ['eco', 'ECO mode', null, null, 'eco'],
  ['charging', 'Charging', null, null, 'charging'],
];
const sendsList = c => [
  'Battery: charge %, health, power, voltage, current, temperature, cell spread',
  'Driving: speed, gear, ECO / e-Pedal, range, trip energy',
  'Car: odometer, outside temperature, 12V battery, charging state, charge counts',
  c.location ? '<b>Your GPS location</b> (you turned this on)' : 'Not your location (off)',
];

/* ---------------- Home Assistant (REST API) ---------------- */
LeafDash.registerAddon({
  id: 'homeassistant', name: 'Home Assistant',
  description: 'Creates sensor.leaf_* entities in your Home Assistant via its REST API.',
  minInterval: 10,
  fields: [
    { key: 'url', label: 'Home Assistant URL (https)', placeholder: 'https://ha.yourdomain.com' },
    { key: 'token', label: 'Long-lived access token', type: 'password', placeholder: 'from your HA profile → Security' },
    { key: 'prefix', label: 'Entity prefix', default: 'leaf' },
    { key: 'interval', label: 'Send every (seconds)', type: 'number', default: 15 },
    { key: 'location', label: 'Include GPS location', type: 'bool', default: false },
  ],
  help: `In HA's configuration.yaml add this app's address to <code>http: cors_allowed_origins:</code> (e.g. <code>${location.origin}</code>) and restart, otherwise the browser blocks the requests. HA must be reachable over https.`,
  validate: c => !/^https:\/\//.test(c.url || '') ? 'Enter your Home Assistant https:// URL first' : !c.token ? 'Paste a long-lived access token first' : null,
  destination: c => (c.url || '').replace(/^https:\/\//, '').replace(/\/$/, ''),
  sends: sendsList,
  async send(s, c, api) {
    const base = c.url.replace(/\/$/, ''), pre = (c.prefix || 'leaf').replace(/[^a-z0-9_]/gi, '_').toLowerCase();
    const post = (entity, state, attributes) => fetch(`${base}/api/states/${entity}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, attributes }),
    }).then(r => { if (r.status === 401) throw new Error('Token rejected (401)'); if (!r.ok) throw new Error(`HA replied ${r.status}`); });
    try {
      for (const [k, name, unit, dc, field] of HA_SENSORS) {
        let v = s[field];
        if (v == null) continue;
        if (typeof v === 'boolean') v = v ? 'on' : 'off';
        await post(`sensor.${pre}_${k}`, v, {
          friendly_name: `Leaf ${name}`, ...(unit && { unit_of_measurement: unit }),
          ...(dc && { device_class: dc }), ...(typeof s[field] === 'number' && { state_class: 'measurement' }), icon: 'mdi:car-electric',
        });
      }
      if (s.lat != null) await post(`sensor.${pre}_location`, 'tracked', { friendly_name: 'Leaf location', latitude: s.lat, longitude: s.lon, icon: 'mdi:map-marker' });
      api.status(`Sent ${new Date().toLocaleTimeString()}`, 'ok');
    } catch (e) {
      api.status(e instanceof TypeError ? `Can't reach Home Assistant. Check the URL and that cors_allowed_origins includes ${location.origin}` : e.message, 'err');
    }
  },
});

/* ---------------- MQTT (over secure WebSockets) ---------------- */
function loadMqttLib() {
  if (window.mqtt) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/mqtt.min.js'; s.onload = res; s.onerror = () => rej(new Error('MQTT library failed to load'));
    document.head.appendChild(s);
  });
}
LeafDash.registerAddon({
  id: 'mqtt', name: 'MQTT',
  description: 'Publishes live data to an MQTT broker. Optional Home Assistant auto-discovery creates a "Nissan Leaf" device.',
  minInterval: 3,
  fields: [
    { key: 'url', label: 'Broker WebSocket URL (wss)', placeholder: 'wss://mqtt.yourdomain.com:8884/mqtt' },
    { key: 'username', label: 'Username' },
    { key: 'password', label: 'Password', type: 'password' },
    { key: 'topic', label: 'Base topic', default: 'leafdash' },
    { key: 'discovery', label: 'Home Assistant MQTT discovery', type: 'bool', default: true },
    { key: 'interval', label: 'Send every (seconds)', type: 'number', default: 5 },
    { key: 'location', label: 'Include GPS location', type: 'bool', default: false },
  ],
  help: 'The broker needs a WebSocket listener with a valid TLS certificate (wss://). Browsers block plain ws:// from an https page. Topics: <code>&lt;base&gt;/state</code> (JSON, retained) and <code>&lt;base&gt;/availability</code>.',
  validate: c => !/^wss:\/\//.test(c.url || '') ? 'Enter a wss:// broker URL first' : null,
  destination: c => (c.url || '').replace(/^wss:\/\//, '').split('/')[0],
  sends: sendsList,
  async start(c, api) {
    await loadMqttLib();
    const base = (c.topic || 'leafdash').replace(/\/$/, '');
    const client = mqtt.connect(c.url, {
      username: c.username || undefined, password: c.password || undefined,
      clientId: 'leafdash-' + Math.random().toString(16).slice(2, 8), reconnectPeriod: 5000, connectTimeout: 10000,
      will: { topic: `${base}/availability`, payload: 'offline', retain: true, qos: 1 },
    });
    const ctx = { client, base, discovered: false };
    client.on('connect', () => {
      api.status('Connected to broker', 'ok');
      client.publish(`${base}/availability`, S.mode === 'on' ? 'online' : 'offline', { retain: true, qos: 1 });
      if (c.discovery && !ctx.discovered) {
        ctx.discovered = true;
        const device = { identifiers: ['leafdash_' + base], name: 'Nissan Leaf (Leaf Dash)', manufacturer: 'Nissan', model: 'Leaf', sw_version: 'Leaf Dash ' + LeafDash.version };
        for (const [k, name, unit, dc, field] of HA_SENSORS) {
          client.publish(`homeassistant/sensor/${base}_${k}/config`, JSON.stringify({
            name, unique_id: `${base}_${k}`, object_id: `leaf_${k}`, state_topic: `${base}/state`,
            value_template: `{{ value_json.${field} }}`, availability_topic: `${base}/availability`,
            ...(unit && { unit_of_measurement: unit }), ...(dc && { device_class: dc }),
            ...(unit && { state_class: 'measurement' }), device,
          }), { retain: true });
        }
      }
    });
    client.on('error', e => api.status('Broker: ' + e.message, 'err'));
    client.on('offline', () => api.status('Broker offline, retrying…', 'err'));
    return ctx;
  },
  send(s, c, api, ctx) {
    if (!ctx?.client?.connected) return;
    ctx.client.publish(`${ctx.base}/availability`, 'online', { retain: true });
    ctx.client.publish(`${ctx.base}/state`, JSON.stringify(s), { retain: true });
    api.status(`Published ${new Date().toLocaleTimeString()}`, 'ok');
  },
  onMode(m, ctx) { if (ctx?.client?.connected && m === 'off') ctx.client.publish(`${ctx.base}/availability`, 'offline', { retain: true }); },
  stop(ctx) {
    if (!ctx?.client) return;
    try { ctx.client.publish(`${ctx.base}/availability`, 'offline', { retain: true }); } catch {}
    ctx.client.end(true);
  },
});

/* ---------------- A Better Route Planner (Iternio telemetry) ---------------- */
LeafDash.registerAddon({
  id: 'abrp', name: 'A Better Route Planner',
  description: 'Sends live charge, power and location to ABRP so route plans follow your real battery.',
  minInterval: 5,
  fields: [
    { key: 'token', label: 'ABRP user token', type: 'password', placeholder: 'ABRP → car settings → Live data → Generic' },
    { key: 'apiKey', label: 'API key (optional)', placeholder: 'only if Iternio gave you one' },
    { key: 'interval', label: 'Send every (seconds)', type: 'number', default: 10 },
    { key: 'location', label: 'Include GPS location (ABRP needs this for live planning)', type: 'bool', default: true },
  ],
  help: 'Get the token in ABRP: open your car\'s settings → Live data → link a "Generic" source and copy the token.',
  validate: c => !c.token ? 'Paste your ABRP user token first' : null,
  destination: () => 'A Better Route Planner (api.iternio.com)',
  sends: c => ['Charge %, health, power, voltage, current, battery & outside temperature',
    'Speed, parked / charging / rapid-charging state, odometer, car\'s range estimate',
    c.location ? '<b>Your GPS location</b>' : 'Not your location (off; live planning will be limited)'],
  async send(s, c, api) {
    const tlm = {
      utc: s.utc, soc: s.soc, soh: s.soh, power: s.power_kw, speed: s.speed_kmh,
      lat: s.lat, lon: s.lon, is_charging: s.charging ? 1 : 0, is_dcfc: s.rapid_charging ? 1 : 0,
      is_parked: s.gear === 'P' ? 1 : 0, batt_temp: s.batt_temp, ext_temp: s.ext_temp,
      voltage: s.voltage, current: s.current, odometer: s.odometer_km, est_battery_range: s.est_range_km,
    };
    Object.keys(tlm).forEach(k => tlm[k] == null && delete tlm[k]);
    const q = new URLSearchParams({ token: c.token, tlm: JSON.stringify(tlm) });
    if (c.apiKey) q.set('api_key', c.apiKey);
    // ABRP doesn't allow reading the reply from a web page, so this is fire-and-forget
    await fetch(`https://api.iternio.com/1/tlm/send?${q}`, { mode: 'no-cors' });
    api.status(`Sent ${new Date().toLocaleTimeString()}. Check ABRP's live data screen to confirm`, 'ok');
  },
});
