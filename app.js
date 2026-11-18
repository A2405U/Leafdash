'use strict';

/* =====================================================================
   Leaf Dash: Nissan Leaf battery dashboard over a BLE ELM327 (LELink)
   ---------------------------------------------------------------------
   The battery controller (LBC) answers on CAN id 0x7BB to requests sent
   to 0x79B. Group 01 = main battery data, 02 = cell voltages,
   04 = temperatures.

   CALIBRATION: byte offsets below are best-known community values and
   may differ on your car. Offsets index the reassembled response where
   [0] = 0x61 and [1] = the group number. Use the Debug tab to compare
   raw bytes with LeafSpy and adjust here.
   ===================================================================== */
const G1 = {
  current: { at: 2,  len: 4, signed: true, scale: 1 / 1024 },  // A
  voltage: { at: 20, len: 2, scale: 1 / 100 },                 // V
  // Calibrated on a 2021 ZE1 (53-byte reply): voltage, SOC and Ah confirmed
  // against cell voltages. SOH isn't in this group on 2018+ cars (see G61).
  hx:      { at: 30, len: 2, scale: 1 / 102.4 },               // % (to verify against LeafSpy)
  soc:     { at: 33, len: 3, scale: 1 / 10000 },               // %
  ahr:     { at: 37, len: 3, scale: 1 / 10000 },               // Ah (ZE1: one byte later than 2011-17 cars)
};
const CURRENT_SIGN = -1;     // ZE1 reports discharge as negative; flipped so driving shows positive kW

/* SOH: group 0x61 on 2018+ cars. Offset unconfirmed: the raw reply is shown
   in Debug so it can be calibrated. Until then SOH is estimated from Ah. */
const G61_SOH = null;        // e.g. { at: 9, len: 2, scale: 1 / 100 } once confirmed
const NEW_AH = 115.44;       // new 40 kWh pack Ah: matches LeafSpy (105.89 Ah → 91.73%)

/* DRIVE MODE: not decoded yet. Use the Debug → CAN sniffer to find which
   byte/bit changes when you press ECO or shift D↔B, then fill in decode().
   Community docs point at broadcast ID 0x11A, which may or may not reach
   the OBD port on a 2018+ Leaf. */
/* VCM (vehicle control module): request 0x797, reply 0x79A. On 2018+ cars
   the gateway only passes request/reply traffic to the OBD port, so gear and
   ECO have to be asked for here rather than sniffed. All reads use service
   0x22 (read data by identifier), which can't change anything. */
const ECUS = { lbc: { tx: '79B', rx: '7BB' }, vcm: { tx: '797', rx: '79A' }, meter: { tx: '743', rx: '763' } };
const VCM_GEAR = '1156';     // reply byte: 1=P 2=R 3=N 4=D (community-documented)
const GEARS = { 1: 'P', 2: 'R', 3: 'N', 4: 'D', 7: 'B' };   // confirmed on a 2021 ZE1 (B reports 7)
// ECO comes from VCM 22 13 1B bit 0x10 (see cardata.js).

const DRIVE = {
  id: '11A',
  decode: null,   // e.g. bytes => ({ gear: ['P','R','N','D','B'][bytes[0] >> 4], eco: !!(bytes[1] & 0x10) })
};
const KW_MIN = -50, KW_MAX = 110; // power strip range (Leaf 40 kWh: 110 kW motor)

const INIT = [
  'ATZ', 'ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATSP6', 'ATCAF1', 'ATAT2',
  'ATSH79B', 'ATCRA7BB', 'ATFCSH79B', 'ATFCSD300000', 'ATFCSM1'
];

/* BLE UART profiles used by common adapters (LELink = FFE0/FFE1) */
const BLE_SERVICES = [
  0xffe0, 0xfff0, 0x18f0,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2'
];

/* ---------------- helpers ---------------- */
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmt = (v, d = 1) => (v == null || Number.isNaN(v)) ? '--' : v.toFixed(d);

function readField(p, f) {
  if (!p || p.length < f.at + f.len) return null;
  let v = 0;
  for (let i = 0; i < f.len; i++) v = v * 256 + p[f.at + i];
  if (f.signed && v >= 2 ** (8 * f.len - 1)) v -= 2 ** (8 * f.len);
  return v * f.scale;
}

const logLines = [];
function log(msg) {
  const t = new Date().toLocaleTimeString();
  logLines.push(`${t}  ${msg}`);
  window.LeafDash?.emit('log', msg);
  if (logLines.length > 300) logLines.shift();
  $('log').textContent = logLines.slice().reverse().join('\n');
}

/* ---------------- ELM327 over BLE ---------------- */
class Elm {
  constructor() {
    this.buf = '';
    this.waiter = null;
    this.chain = Promise.resolve();
    this.enc = new TextEncoder();
    this.dec = new TextDecoder();
  }

  /* `device` is given when reconnecting to an adapter that was already chosen; otherwise the picker opens. */
  async connect(onDisconnect, device = null) {
    this.device = device || await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: BLE_SERVICES
    });
    // one listener per adapter, however many times it reconnects
    if (this.device._ldLost) this.device.removeEventListener('gattserverdisconnected', this.device._ldLost);
    this.device._ldLost = onDisconnect;
    this.device.addEventListener('gattserverdisconnected', onDisconnect);
    log(`Connecting to ${this.device.name || 'adapter'}…`);
    // an adapter that's out of range can leave this hanging, so give up after 20 s
    const server = await Promise.race([
      this.device.gatt.connect(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('adapter not in range')), 20000)),
    ]);

    for (const uuid of BLE_SERVICES) {
      let svc;
      try { svc = await server.getPrimaryService(uuid); } catch { continue; }
      const chars = await svc.getCharacteristics();
      const rx = chars.find(c => c.properties.notify || c.properties.indicate);
      const tx = chars.find(c => c.properties.write || c.properties.writeWithoutResponse);
      if (rx && tx) {
        this.rx = rx; this.tx = tx;
        log(`Using service ${svc.uuid}`);
        break;
      }
    }
    if (!this.rx) throw new Error('No serial service found on this adapter');

    this.rx.addEventListener('characteristicvaluechanged', e => {
      this.buf += this.dec.decode(e.target.value).replace(/\0/g, '');   // some ELM chips insert NULL bytes
      // Streaming mode (sniffer): hand over complete lines as they arrive
      if (this.onLine) {
        let i;
        while ((i = this.buf.search(/[\r\n]/)) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (line && line !== '>') this.onLine(line);
        }
        // A prompt while monitoring means ATMA stopped by itself (usually
        // BUFFER FULL on a busy bus): restart it so capture continues.
        if (this.buf.includes('>')) {
          this.buf = this.buf.replace(/>/g, '');
          this.onPrompt?.();
        }
        return;
      }
      if (this.buf.includes('>') && this.waiter) {
        const out = this.buf.slice(0, this.buf.indexOf('>'));
        this.buf = this.buf.slice(this.buf.indexOf('>') + 1);
        const w = this.waiter; this.waiter = null; w.resolve(out);
      }
    });
    await this.rx.startNotifications();
  }

  disconnect() {
    try { this.device?.gatt?.disconnect(); } catch {}
  }

  /* Commands are queued so only one is ever in flight.
     READ-ONLY GUARD: every command goes through isReadOnly() first. */
  send(cmd, timeout = 4000) {
    if (!isReadOnly(cmd)) return Promise.reject(new Error(`Blocked (not read-only): ${cmd}`));
    const run = async () => {
      this.buf = '';
      const reply = new Promise((resolve, reject) => {
        this.waiter = { resolve };
        setTimeout(() => {
          if (this.waiter?.resolve === resolve) { this.waiter = null; reject(new Error(`Timeout: ${cmd}`)); }
        }, timeout);
      });
      await this.write(cmd + '\r');
      const r = (await reply).trim();
      window.LeafDash?.emit('elm', { c: cmd, r });   // for the drive recorder
      return r;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async write(str) {
    const bytes = this.enc.encode(str);
    for (let i = 0; i < bytes.length; i += 20) {
      const chunk = bytes.slice(i, i + 20);
      if (this.tx.properties.writeWithoutResponse) await this.tx.writeValueWithoutResponse(chunk);
      else await this.tx.writeValue(chunk);
    }
  }

  /* Passive monitor (ATMA). Holds the command queue until stop() is called. */
  async monitor(cmd, onLine) {
    let release;
    const gate = new Promise(r => (release = r));
    const prev = this.chain;
    this.chain = prev.then(() => gate);
    await prev;
    this.buf = '';
    this.onLine = onLine;
    this.restarts = 0;
    this.onPrompt = () => { this.restarts++; this.write(cmd + '\r').catch(() => {}); };
    await this.write(cmd + '\r');
    return async () => {
      this.onPrompt = null;
      this.onLine = null;
      this.buf = '';
      const done = new Promise(r => (this.waiter = { resolve: r }));
      await this.write('\r');                       // any character stops ATMA
      await Promise.race([done, sleep(2000)]);
      this.waiter = null; this.buf = '';
      release();
    };
  }
}

/* =====================================================================
   READ-ONLY ALLOWLIST
   This is the only gate to the adapter. It allows:
     • adapter set-up / info commands (they configure the LELink only)
     • 21 xx      read data by local identifier
     • 22 xx xx   read data by identifier
   Everything else (clearing codes, resets, writes, routines, session
   changes, adapter EEPROM changes) is rejected here and never sent.
   ===================================================================== */
const AT_ALLOWED = [
  /^ATZ$/, /^ATWS$/, /^ATI$/, /^AT@1$/, /^ATDPN?$/, /^ATRV$/,
  /^ATE0$/, /^ATL0$/, /^ATS0$/, /^ATH[01]$/, /^ATSP6$/, /^ATCAF1$/, /^ATAT[012]$/,
  /^ATST[0-9A-F]{2}$/, /^ATSH[0-9A-F]{3}$/, /^ATCRA([0-9A-F]{3})?$/,
  /^ATFCSH[0-9A-F]{3}$/, /^ATFCSD300000$/, /^ATFCSM1$/,
  /^ATCSM1$/,            // silent monitoring ON (listen without acknowledging)
  /^ATMA$/,              // monitor all (only used with silent mode confirmed)
];
function isReadOnly(raw) {
  const c = String(raw).toUpperCase().replace(/\s+/g, '');
  if (c.startsWith('AT')) return AT_ALLOWED.some(re => re.test(c));
  return /^21[0-9A-F]{2}$/.test(c) || /^22[0-9A-F]{4}$/.test(c);
}

/* Reassemble an ELM multi-frame (CAF on, headers off) reply into bytes. */
function parseReply(text) {
  const lines = text.split(/[\r\n]+/).map(s => s.replace(/\s+/g, '')).filter(Boolean);
  const bad = lines.find(l => /NODATA|ERROR|STOPPED|UNABLE|BUFFERFULL|\?/i.test(l));
  if (bad) throw new Error(bad);
  let len = null, frames = [], single = null;
  for (const l of lines) {
    if (/SEARCHING/i.test(l)) continue;
    const m = l.match(/^([0-9A-F]):([0-9A-F]+)$/i);
    if (m) { frames.push({ n: parseInt(m[1], 16), hex: m[2] }); continue; }
    if (len === null && /^[0-9A-F]{3}$/i.test(l)) { len = parseInt(l, 16); continue; }
    if (/^[0-9A-F]+$/i.test(l)) single = l;
  }
  if (frames.length) {
    // Multi-frame: pieces must arrive complete and in order (0,1,2…F,0,1…).
    // A lost piece would shift every byte after it, so reject the whole reply.
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].n !== i % 16) throw new Error('Incomplete reply (piece missing)');
      if (frames[i].hex.length % 2) throw new Error('Incomplete reply (piece cut short)');
    }
  }
  const hex = frames.length ? frames.map(f => f.hex).join('') : (single || '');
  const bytes = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
  if (len && bytes.length < len) throw new Error(`Incomplete reply (${bytes.length}/${len} bytes)`);
  return len ? bytes.slice(0, len) : bytes;
}

/* ---------------- state ---------------- */
const S = {
  mode: 'off',   // off | busy | on | demo
  view: 'drive',
  data: {},
  raw: {},
  lastUpdate: 0,
  elm: null,
  wake: null,
};

/* ---------------- decoding ---------------- */
function decodeG1(p) {
  const d = {};
  for (const k in G1) d[k] = readField(p, G1[k]);
  if (d.current != null) d.current *= CURRENT_SIGN;
  if (d.current != null && d.voltage != null) d.kw = d.current * d.voltage / 1000;
  if (S.data.sohSrc !== 'bms' && d.ahr != null) { d.soh = d.ahr / NEW_AH * 100; d.sohSrc = 'est'; }
  return d;
}

function decodeCells(p) {
  if (p.length < 2 + 96 * 2) return null;               // not the full set: keep the last good one
  const cells = [];
  for (let i = 0; i < 96; i++) {
    const mv = (p[2 + i * 2] << 8) | p[3 + i * 2];
    cells.push(mv > 2000 && mv < 4400 ? mv : null);
  }
  // a reading with several impossible cells is a garbled reply, not 96 real cells
  if (cells.filter(x => x == null).length > 2) return null;
  return cells;
}

function decodeTemps(p) {
  const t = [];
  for (let i = 0; i < 4; i++) {
    const at = 2 + i * 3;
    if (at + 2 >= p.length) break;
    const adc = (p[at] << 8) | p[at + 1];
    const c = p[at + 2] > 127 ? p[at + 2] - 256 : p[at + 2];
    t.push(adc === 0xffff || adc === 0 ? null : c);
  }
  return t;
}

/* ---------------- polling ---------------- */
async function useEcu(name, fc = false) {
  const e = ECUS[name];
  if (S.ecu !== name) {
    // switching costs two commands; flow-control (for long replies) is only
    // re-addressed when the caller needs it, which saves a third
    await S.elm.send('ATSH' + e.tx);
    await S.elm.send('ATCRA' + e.rx);
    S.ecu = name;
  }
  if (fc && S.fc !== name) { await S.elm.send('ATFCSH' + e.tx); S.fc = name; }
}

/** Read one VCM data identifier (service 0x22, read-only). Returns data bytes or null. */
async function vcmRead(did, timeout = 2000) {
  await useEcu('vcm');
  let text;
  try { text = await S.elm.send('22' + did, timeout); } catch { return null; }
  let b;
  try { b = parseReply(text); } catch { return null; }   // NO DATA etc.
  const d = parseInt(did, 16);
  if (b[0] !== 0x62 || ((b[1] << 8) | b[2]) !== d) return null;   // 7F = negative response
  return b.slice(3);
}

async function query(group) {
  await useEcu('lbc', true);
  const text = await S.elm.send('21' + group, 5000);
  const bytes = parseReply(text);
  if (bytes[0] !== 0x61) throw new Error(`Group ${group}: unexpected reply ${text.slice(0, 40)}`);
  S.raw[group] = bytes;
  return bytes;
}

/* =====================================================================
   Polling: a fast lane every cycle (battery power, speed, motor, gear),
   then a few "slow" items that are due, round-robin, within a small time
   budget. No fixed sleep, so a cycle takes ~0.3–0.5 s instead of ~1.5 s.
   ===================================================================== */
const POLL = { last: {}, cycleMs: 0 };

function slowItems() {
  const items = [
    { id: 'g04', ecu: 'lbc', every: 5, run: async () => { S.data.temps = decodeTemps(await query('04')); } },
    { id: 'g02', ecu: 'lbc', every: (typeof HT !== 'undefined' && HT.on) ? 2 : S.view === 'cells' ? 3 : 10,
      run: async () => { const c = decodeCells(await query('02')); if (c) { S.data.cells = c; S.data.cellsAt = Date.now(); } } },
    { id: 'g06', ecu: 'lbc', every: 15, run: async () => { S.raw['06'] = await query('06'); } },
    { id: 'g61', ecu: 'lbc', every: 30, run: async () => {
        try {
          const p = await query('61'); const v = G61_SOH && readField(p, G61_SOH);
          if (v > 0 && v <= 110) { S.data.soh = v; S.data.sohSrc = 'bms'; }
        } catch (e) { if (!S.g61warned) { log('Group 61 (SOH): ' + e.message); S.g61warned = true; } }
      } },
    { id: 'rv', ecu: null, every: 10, run: async () => { const rv = await S.elm.send('ATRV'); S.data.aux = parseFloat(rv.replace(/[^\d.]/g, '')) || null; } },
    { id: 'vin', ecu: 'vcm', every: 1e9, run: readVin },
  ];
  if (Object.values(LIGHT_BITS).some(Boolean)) items.push({ id: 'lights', ecu: null, prio: true, every: lightsEvery(), run: pollLights });   // lights rarely change, which keeps speed/power quick; read faster while an indicator flashes
  for (const d of CAR_DIDS) if (!d.fast) items.push({ id: d.key, ecu: d.ecu, every: d.tier, run: () => readCarDid(d), skip: () => CD.skip[d.key] && (Date.now() - (POLL.last[d.key] || 0) < 120e3) });
  return items;
}

async function pollLoop() {
  let errors = 0;
  POLL.last = {};
  const elm = S.elm;                                     // a loop belongs to one connection, and ends with it
  while (S.mode === 'on' && S.elm === elm) {
    if (S.sniffing) { await sleep(300); continue; }
    const t0 = performance.now();
    try {
      // ---- fast lane ----
      Object.assign(S.data, decodeG1(await query('01')));
      S.lastUpdate = Date.now();
      render();
      for (const d of CAR_DIDS) if (d.fast) await readCarDid(d);
      deriveCarData();
      render();
      LeafDash.emit('data', S.data);
      errors = 0;

      // ---- slow lane: what's due, same ECU first, within ~200 ms ----
      const now = Date.now();
      const due = slowItems().filter(it => now - (POLL.last[it.id] || 0) >= it.every * 1000 && !(it.skip && it.skip()))
        .sort((x, y) => (y.prio ? 1 : 0) - (x.prio ? 1 : 0) || ((x.ecu === S.ecu || !x.ecu) ? 0 : 1) - ((y.ecu === S.ecu || !y.ecu) ? 0 : 1) || (POLL.last[x.id] || 0) - (POLL.last[y.id] || 0));
      const budget = performance.now() + 200;
      for (const it of due) {
        if (performance.now() > budget) break;
        POLL.last[it.id] = Date.now();
        try { await it.run(); } catch (e) { if (!/Incomplete/.test(e.message)) log(`${it.id}: ${e.message}`); }
      }
      deriveCarData();
    } catch (e) {
      log('Poll: ' + e.message);
      if (++errors >= 6) { log('Too many errors. Is the car switched on?'); await sleep(3000); errors = 0; }
    }
    POLL.cycleMs = Math.round(performance.now() - t0);
    await sleep(10);                                     // just yield to the UI
  }
}

/* ---------------- connect / disconnect ----------------
   RC remembers the adapter so the app can get back to it by itself: after
   a dropped connection, and (where the browser allows it) when the app is
   opened. Reconnecting only repeats the same read-only set-up as the
   Connect button. */
const RC = { device: null, wanted: false, tries: 0, timer: null, watch: null };
const RC_WAITS = [2, 3, 5, 8, 12, 20, 30, 30, 60, 60];

function connect() {
  if (S.mode === 'on' || S.mode === 'busy') return disconnect();
  if (S.mode === 'demo') stopDemo();
  rcStopWatch();
  return openAdapter(null);
}

/** Open the adapter (asking which one if `device` is null), set it up and start polling. */
async function openAdapter(device) {
  setMode('busy');
  const elm = S.elm = new Elm();
  try {
    await elm.connect(() => { if (S.elm === elm && !elm.closing) adapterLost(); }, device);
    for (const c of INIT) {
      try {
        const r = await elm.send(c, c === 'ATZ' ? 6000 : 3000);
        log(`${c} → ${r.replace(/\s+/g, ' ')}`);
      } catch (e) { log(`${c} failed: ${e.message}`); }
      if (c === 'ATZ') await sleep(500);
    }
    if (S.elm !== elm || elm.closing) return false;          // cancelled while setting up
    S.ecu = 'lbc'; S.fc = 'lbc';
    RC.device = elm.device; RC.wanted = true; RC.tries = 0;
    SET.lastAdapter = { id: elm.device.id, name: elm.device.name || 'adapter' }; saveSettings();
    setMode('on');
    keepAwake();
    pollLoop();
    return true;
  } catch (e) {
    log('Connect failed: ' + e.message);
    elm.closing = true; elm.disconnect();
    if (S.elm === elm) setMode('off');
    return false;
  }
}

/** The link dropped without being asked to (adapter unplugged, out of range, car off). */
function adapterLost() {
  log('Adapter disconnected');
  S.sniffing = false; SN.stop = null; setSnStatus();
  setMode('off');
  if (RC.wanted && RC.device && SET.autoReconnect !== false) rcRetry();
}
function rcRetry() {
  if (RC.tries >= RC_WAITS.length) { RC.wanted = false; log('Gave up reconnecting. Tap Connect adapter to try again.'); setMode('off'); return; }
  const wait = RC_WAITS[RC.tries++];
  setMode('busy');
  $('status').querySelector('span').textContent = 'Reconnecting…';
  log(`Reconnecting in ${wait} s (try ${RC.tries})`);
  clearTimeout(RC.timer);
  RC.timer = setTimeout(async () => {
    if (!RC.wanted) return;
    const ok = await openAdapter(RC.device);
    if (!ok && RC.wanted) rcRetry();
  }, wait * 1000);
}

function disconnect() {
  RC.wanted = false; clearTimeout(RC.timer); rcStopWatch();
  S.sniffing = false; SN.stop = null; setSnStatus();
  if (S.elm) { S.elm.closing = true; S.elm.disconnect(); }
  setMode('off');
}

/** When the app opens: if the browser remembers the adapter, connect as soon as it's in range.
 *  Needs Chrome's "getDevices" support; where that's missing, the Connect button works as before. */
async function autoConnect() {
  if (SET.autoReconnect === false || !SET.lastAdapter || S.mode !== 'off' || !navigator.bluetooth?.getDevices) return;
  let dev;
  try { dev = (await navigator.bluetooth.getDevices()).find(x => x.id === SET.lastAdapter.id); } catch { return; }
  if (!dev) return;
  const go = () => { rcStopWatch(); if (S.mode === 'off') openAdapter(dev); };
  if (!dev.watchAdvertisements) return go();
  try {
    const ac = new AbortController();
    RC.watch = { ac, dev, go };
    dev.addEventListener('advertisementreceived', go);
    await dev.watchAdvertisements({ signal: ac.signal });
    log(`Waiting for ${dev.name || 'the adapter'} to come into range…`);
    $('status').querySelector('span').textContent = 'Looking for adapter…';
    setTimeout(() => { if (RC.watch?.ac === ac) { rcStopWatch(); if (S.mode === 'off') setMode('off'); } }, 180e3);
  } catch { rcStopWatch(); go(); }
}
function rcStopWatch() {
  if (!RC.watch) return;
  try { RC.watch.dev.removeEventListener('advertisementreceived', RC.watch.go); RC.watch.ac.abort(); } catch {}
  RC.watch = null;
}

async function keepAwake() {
  try { S.wake = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (S.mode === 'on' || S.mode === 'demo')) keepAwake();
});

/* ---------------- demo mode ---------------- */
let demoTimer = null;
function startDemo() {
  if (S.mode === 'on' || S.mode === 'busy') disconnect();
  setMode('demo');
  let t = 0, soc = 78.4, spd = 40;
  const base = Array.from({ length: 96 }, () => 3950 + Math.round(Math.random() * 18));
  demoTimer = setInterval(() => {
    t += 1;
    const burst = t % 26 > 19 ? 38 : 0;   // a hard-acceleration burst every ~26 s (shows the warp)
    const kw = 12 + 28 * Math.sin(t / 7) + 14 * Math.sin(t / 2.7) + burst + (Math.random() - .5) * 4;
    spd += (clamp((38 + kw * 0.9), 0, 125) - spd) * 0.25;
    if (S.demoCharging) { soc = Math.min(100, soc + 0.02); }
    soc = Math.max(5, soc - Math.max(kw, 0) * 0.0006);
    const v = 380 - kw * 0.35;
    S.data = {
      soc, kw, voltage: v, current: kw * 1000 / v,
      soh: 93.12, hx: 98.4, ahr: 108.7, aux: 12.6 + Math.random() * 0.1,
      temps: [14, 15, null, 14].map(x => x == null ? null : x + Math.round(t / 60)),
      cells: base.map(c => c - Math.round(kw * 0.4) + Math.round(Math.random() * 3)),
      gear: Math.floor(t / 15) % 3 === 2 ? 'B' : 'D',
      speed: spd,
      ...demoCarData(t, kw, spd),
      ...(S.demoCharging ? { demoCharging: true, kw: -2.28 - Math.random() * 0.05, current: -5.7, chargeMode: 1, plug: 2, speed: 0, gear: 'P', motorKw: 0 } : {}),
      demoLights: (() => { const ph = Math.floor(t / 10) % 6; return {
        tail: ph > 0, low: ph >= 1 && ph <= 4, high: ph === 2, brake: kw < -8 || ph === 3,
        indL: ph === 4, indR: ph === 5, reverse: ph === 5 }; })(),
    };
    if (typeof demoRouteApply === 'function') demoRouteApply(S.data);
    if (typeof demoApply === 'function') demoApply(S.data);
    S.lastUpdate = Date.now();
    render();
  }, 500);
  log('Demo mode started (simulated data)');
}
function stopDemo() { clearInterval(demoTimer); demoTimer = null; }

/* ---------------- UI ---------------- */
function setMode(m) {
  S.mode = m;
  window.LeafDash?.emit('mode', m);
  const st = $('status');
  st.className = 'status ' + { off: 'off', busy: 'busy', on: 'on', demo: 'demo' }[m];
  st.querySelector('span').textContent =
    { off: 'Disconnected', busy: 'Connecting…', on: 'Live', demo: 'Demo' }[m];
  const b = $('btnConnect');
  b.textContent = (m === 'on' || m === 'busy') ? 'Disconnect' : 'Connect adapter';
  b.className = 'btn ' + ((m === 'on' || m === 'busy') ? 'danger' : 'primary');
  $('btnDemo').textContent = m === 'demo' ? 'Stop demo' : 'Demo';
  // once connected (or in demo) the connect bar folds away; tap the status to disconnect
  $('connectBar').classList.toggle('hidden', m === 'on' || m === 'demo');
  if (typeof fitScene === 'function') setTimeout(fitScene, 0);
  if (m === 'off') { S.wake?.release?.(); S.wake = null; }
}

function render() {
  deriveCarData();
  const d = S.data;

  renderPower(d.kw);
  recordSample(d.kw);
  if (S.view === 'energy') renderEnergy();

  // drive mode badges in the power strip (only once known)
  $('driveMode').classList.toggle('hidden', !d.gear);
  if (d.gear) $('driveMode').textContent = d.gear;
  $('ecoMode').classList.toggle('hidden', !d.eco);
  document.querySelector('.powerstrip').classList.toggle('eco', !!d.eco);

  // cells view
  $('tempList').innerHTML = (d.temps || []).map((t, i) =>
    `<div>${t == null ? '–' : t + '°'}<span>T${i + 1}</span></div>`).join('');
  const cells = d.cells || [];
  const valid = cells.filter(x => x != null);
  if (valid.length) {
    const min = Math.min(...valid), max = Math.max(...valid);
    const avg = valid.reduce((a, b) => a + b) / valid.length;
    $('cMin').textContent = min; $('cMax').textContent = max;
    $('cDelta').textContent = max - min;
    $('cMinIdx').textContent = 'cell ' + (cells.indexOf(min) + 1);
    $('cMaxIdx').textContent = 'cell ' + (cells.indexOf(max) + 1);
    $('cellAvg').textContent = `avg ${avg.toFixed(0)} mV`;
    if (S.view === 'cells') drawCells(cells, min, max);
  }

  if (S.view === 'dash') renderDash();
  if (S.view === 'debug') { renderRaw(); renderCarDataList(); }
  if (typeof hisRender === 'function') hisRender();
}

const KM_MI = 0.621371, KPA_PSI = 0.145038;
function renderCarDataList() {
  $('cdList').innerHTML = CAR_DIDS.map(dd => {
    const raw = CD.raw[dd.key], v = S.data[dd.key];
    const shown = v == null ? (CD.skip[dd.key] ? 'no reply' : '--') : typeof v === 'number' ? (Number.isInteger(v) ? v : v.toFixed(2)) + (dd.unit ? ' ' + dd.unit : '') : String(v);
    return `<div><b>${dd.key}${dd.verify ? ' ✱' : ''}</b><span>${dd.ecu} ${dd.did}</span><code>${raw ? raw.map(x => x.toString(16).padStart(2, '0')).join(' ') : ''}</code><em>${shown}</em></div>`;
  }).join('') + Object.entries(LIGHT_BITS).filter(([, b]) => b).map(([k, b]) => {
    const raw = LIGHT_RAW[`${b.ecu}:${b.did}`], on = lightBit(k);
    return `<div><b>light ${k}</b><span>${b.ecu} ${b.did} [${b.byte}]</span><code>${raw ? raw.map(x => x.toString(16).padStart(2, '0')).join(' ') : ''}</code><em>${on == null ? '--' : on ? 'on' : 'off'}</em></div>`;
  }).join('');
}

/* ---------------- Tesla-style power strip ---------------- */
const ZERO_PCT = (-KW_MIN) / (KW_MAX - KW_MIN) * 100;
const kwToPct = kw => (Math.max(KW_MIN, Math.min(KW_MAX, kw)) - KW_MIN) / (KW_MAX - KW_MIN) * 100;

/** What the battery power is being used for, in one word. Drawing power isn't the same as driving:
 *  parked with the heater on, or waiting in gear at the lights, the car is using power but going nowhere. */
function powerState(d) {
  const kw = d.kw;
  if (kw == null || Math.abs(kw) < 0.5) return { text: 'Idle', cls: '', driving: false };
  if (typeof isCharging === 'function' && isCharging(d)) return { text: 'Charging', cls: 'regen', driving: false };
  const sp = typeof currentSpeed === 'function' ? currentSpeed().mps : null;
  const moving = sp != null && sp > 0.4;                                   // about 1 mph
  const parked = d.gear === 'P' || (d.gear == null && sp != null && !moving && (d.motorKw ?? 0) < 0.5);
  if (parked) return { text: kw > 0 && d.climateOn ? 'Climate' : 'Parked', cls: '', driving: false };
  if (!moving && sp != null && (d.motorKw ?? 0) < 0.5) return { text: 'Stopped', cls: '', driving: false };   // in gear, standing still, motor not pulling
  return kw < 0 ? { text: 'Regen', cls: 'regen', driving: true } : { text: 'Drive', cls: 'drive', driving: true };
}

function renderPower(kw) {
  const bar = $('kwBar'), mode = $('kwMode');
  $('kw').textContent = kw == null ? '0' : Math.abs(kw) < 10 ? kw.toFixed(1) : kw.toFixed(0);
  if (kw == null) return;
  const p = kwToPct(kw);
  bar.style.left = Math.min(p, ZERO_PCT) + '%';
  bar.style.width = Math.abs(p - ZERO_PCT) + '%';
  bar.classList.toggle('regen', kw < 0);
  const st = powerState(S.data);
  mode.textContent = st.text;
  mode.className = 'pill ' + st.cls;
  bar.classList.toggle('aux', kw > 0 && !st.driving);                      // power used while not driving: a quieter bar
  // session peak markers
  const pk = $('pkDrive'), pr = $('pkRegen');
  if (T.peak > 1) { pk.style.left = kwToPct(T.peak) + '%'; pk.style.opacity = .5; }
  if (T.peakRegen > 1) { pr.style.left = kwToPct(-T.peakRegen) + '%'; pr.style.opacity = .6; }
}

/* ---------------- trip energy (persists across app restarts) ---------------- */
const TRIP_KEY = 'leafdash.trip';
const newTrip = () => ({ used: 0, regen: 0, peak: 0, peakRegen: 0, since: Date.now() });
let T = (() => { try { return { ...newTrip(), ...JSON.parse(localStorage.getItem(TRIP_KEY)) }; } catch { return newTrip(); } })();
const saveTrip = () => { if (window.LD_RESTORING) return; try { localStorage.setItem(TRIP_KEY, JSON.stringify(T)); } catch {} };

const hist = [];          // { t, kw } for the graph (last 15 min)
let lastSampleAt = 0, chartMinutes = 5;

function recordSample(kw) {
  if (kw == null || S.lastUpdate === lastSampleAt) return;
  const now = S.lastUpdate;
  if (lastSampleAt) {
    const dt = Math.min((now - lastSampleAt) / 1000, 5);  // cap gaps so a pause doesn't add phantom energy
    if (kw > 0) T.used += kw * dt / 3600; else T.regen += -kw * dt / 3600;
    if (typeof hisDrive === 'function') hisDrive(dt, kw, currentSpeed().mps);   // trip miles + recent efficiency
  }
  T.peak = Math.max(T.peak, kw);
  T.peakRegen = Math.max(T.peakRegen, -kw);
  lastSampleAt = now;
  hist.push({ t: now, kw });
  while (hist.length && hist[0].t < now - 15 * 60e3) hist.shift();
  if (hist.length % 10 === 0) saveTrip();
}

function renderEnergy() {
  $('eUsed').textContent = T.used.toFixed(2);
  $('eRegen').textContent = T.regen.toFixed(2);
  $('eNet').textContent = (T.used - T.regen).toFixed(2);
  $('eShare').textContent = T.used > 0 ? Math.round(T.regen / T.used * 100) : 0;
  $('ePeak').textContent = T.peak.toFixed(0);
  $('ePeakR').textContent = T.peakRegen.toFixed(0);
  $('eSince').textContent = 'Trip started ' + new Date(T.since).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  drawEnergy();
}

function drawEnergy() {
  const cv = $('energyChart'), dpr = devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const padL = 30, padB = 18, padT = 8, cw = w - padL, ch = h - padB;
  const now = hist.length ? hist[hist.length - 1].t : Date.now();
  const span = chartMinutes * 60e3, t0 = now - span;
  const pts = hist.filter(p => p.t >= t0);

  // scale: round to 25 kW steps, always show some regen space
  const hi = Math.max(25, Math.ceil(Math.max(0, ...pts.map(p => p.kw)) / 25) * 25);
  const lo = Math.min(-25, Math.floor(Math.min(0, ...pts.map(p => p.kw)) / 25) * 25);
  const y = kw => padT + (hi - kw) / (hi - lo) * (ch - padT);
  const x = t => padL + (t - t0) / span * cw;

  g.font = '10px system-ui'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let v = lo; v <= hi; v += 25) {
    g.strokeStyle = v === 0 ? '#3a4756' : '#1a232d';
    g.lineWidth = v === 0 ? 1.5 : 1;
    g.beginPath(); g.moveTo(padL, y(v)); g.lineTo(w, y(v)); g.stroke();
    g.fillStyle = '#8494a6'; g.fillText(v, padL - 6, y(v));
  }
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.fillText(`-${chartMinutes} min`, padL + 18, h - 3);
  g.fillText('now', w - 12, h - 3);
  if (pts.length < 2) return;

  const path = new Path2D();
  path.moveTo(x(pts[0].t), y(0));
  pts.forEach(p => path.lineTo(x(p.t), y(p.kw)));
  path.lineTo(x(pts[pts.length - 1].t), y(0));
  path.closePath();

  const zero = y(0);
  // drive area above zero, regen area below zero
  [[padT, zero, 'rgba(232,238,245,.22)', '#e8eef5'], [zero, ch, 'rgba(61,220,151,.28)', '#3ddc97']].forEach(([top, bot, fill, stroke]) => {
    g.save();
    g.beginPath(); g.rect(padL, top, cw, bot - top + 1); g.clip();
    g.fillStyle = fill; g.fill(path);
    g.strokeStyle = stroke; g.lineWidth = 1.6; g.lineJoin = 'round';
    g.beginPath(); pts.forEach((p, i) => i ? g.lineTo(x(p.t), y(p.kw)) : g.moveTo(x(p.t), y(p.kw))); g.stroke();
    g.restore();
  });
}

function drawCells(cells, min, max) {
  const cv = $('cellChart'), dpr = devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight || 260;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const lo = min - 10, hi = max + 5, n = cells.length;
  const gap = 1, bw = (w - gap * (n - 1)) / n;
  cells.forEach((c, i) => {
    if (c == null) return;
    const bh = Math.max(2, (c - lo) / (hi - lo) * (h - 24));
    g.fillStyle = c === min ? '#ff5d6c' : c === max ? '#4cc3ff' : '#3ddc97';
    g.globalAlpha = c === min || c === max ? 1 : 0.75;
    g.beginPath();
    if (g.roundRect) g.roundRect(i * (bw + gap), h - 18 - bh, bw, bh, 2);
    else g.rect(i * (bw + gap), h - 18 - bh, bw, bh);
    g.fill();
  });
  g.globalAlpha = 1;
  g.fillStyle = '#8494a6';
  g.font = '11px system-ui';
  g.fillText('1', 0, h - 4);
  g.textAlign = 'center'; g.fillText('48', w / 2, h - 4);
  g.textAlign = 'right'; g.fillText('96', w, h - 4);
}

function renderRaw() {
  const names = { '01': 'Group 01 · battery', '02': 'Group 02 · cells', '04': 'Group 04 · temps', '06': 'Group 06 · shunts', '61': 'Group 61 · health (SOH)' };
  $('raw').innerHTML = Object.keys(names).map(k => {
    const b = S.raw[k];
    if (!b) return `<h4>${names[k]}</h4><div class="mini">no data yet</div>`;
    return `<h4>${names[k]} (${b.length} bytes)</h4>` +
      b.map((x, i) => `<span class="b"><i>${i}:</i>${x.toString(16).padStart(2, '0').toUpperCase()}</span>`).join('');
  }).join('');
}

function rawAsText() {
  return Object.entries(S.raw).map(([k, b]) =>
    `21${k}: ` + b.map(x => x.toString(16).padStart(2, '0')).join(' ')).join('\n') +
    '\n\nCar data (22 xx xx):\n' + CAR_DIDS.map(d => `${d.ecu} ${d.did} ${d.key} = ${CD.raw[d.key] ? CD.raw[d.key].map(x => x.toString(16).padStart(2, '0')).join(' ') : (CD.skip[d.key] ? 'no reply' : '-')} → ${S.data[d.key] ?? '-'}`).join('\n') +
    '\n\nDecoded: ' + JSON.stringify({ ...S.data, cells: undefined, vin: undefined }, null, 1) +
    '\n\nLog:\n' + logLines.slice(-60).join('\n');
}

/* ---------------- CAN sniffer (listen only) ---------------- */
const SN = { frames: new Map(), stop: null, sel: null, dirty: false };

function setSnStatus(txt) {
  $('snStatus').textContent = txt || (S.sniffing ? 'Listening' : 'Stopped');
  $('snStatus').className = 'pill ' + (S.sniffing ? 'regen' : '');
  $('btnSniff').textContent = S.sniffing ? 'Stop' : 'Start';
  $('btnSniff').className = 'btn small ' + (S.sniffing ? 'danger' : 'primary');
}

let demoSniff = null;
async function startSniff() {
  if (S.mode === 'demo') {   // simulated frames so the UI can be tried without the car
    const df = $('snFilter').value.trim().toUpperCase();
    S.sniffing = true; SN.frames.clear(); SN.sel = df || '11A'; setSnStatus('Demo');
    let n = 0;
    demoSniff = setInterval(() => {
      n++;
      const gear = S.data.gear === 'B' ? 0x5 : 0x4, eco = S.data.eco ? 0x10 : 0;
      if (!df || df === '11A') onSniffLine('11A' + [gear << 4, 0x40 | eco, 0, 0xAA, 0xC0, 0, n & 0xff, 0x3C].map(b => b.toString(16).padStart(2, '0')).join(''));
      if (!df || df === '1DB') onSniffLine('1DB' + [0x5a, (n * 7) & 0xff, 0x0c, 0xd4, 0, 0, 0x02, n & 3].map(b => b.toString(16).padStart(2, '0')).join(''));
    }, 100);
    return;
  }
  if (S.mode !== 'on') return log('Connect to the adapter first');
  const f = $('snFilter').value.trim().toUpperCase();
  if (f && !/^[0-9A-F]{3}$/.test(f)) return log('Filter must be a 3-digit hex CAN ID like 11A, or blank for all');
  S.sniffing = true; setSnStatus('Starting…');
  try {
    // Silent mode is the safety-critical bit: refuse to monitor without it.
    const csm = await S.elm.send('ATCSM1');
    log(`ATCSM1 → ${csm}`);
    if (!/OK/.test(csm)) throw new Error('This adapter can\'t do silent (listen-only) monitoring, so the sniffer stays off');
    for (const c of ['ATH1', f ? 'ATCRA' + f : 'ATCRA']) log(`${c} → ${await S.elm.send(c)}`);
    SN.frames.clear(); SN.sel = f || null;
    SN.stop = await S.elm.monitor('ATMA', onSniffLine);
    setSnStatus();
    log(`Sniffer listening${f ? ' to ' + f : ' to all IDs'}`);
  } catch (e) {
    log('Sniffer: ' + e.message);
    await stopSniff();
  }
}

async function stopSniff() {
  if (demoSniff) { clearInterval(demoSniff); demoSniff = null; S.sniffing = false; return setSnStatus(); }
  if (SN.stop) { await SN.stop(); SN.stop = null; }
  for (const c of ['ATH0', 'ATCRA7BB']) { try { await S.elm.send(c); } catch {} }
  S.ecu = null; S.fc = null;                              // force the next read to set its computer again
  S.ecu = null;
  S.sniffing = false; setSnStatus();
  log('Sniffer stopped, battery polling resumed');
}

function onSniffLine(line) {
  const l = line.replace(/\s+/g, '').toUpperCase();
  if (!/^[0-9A-F]{5,}$/.test(l)) { if (/BUFFER|STOPPED|ERROR/.test(l)) log('Sniffer: ' + l); return; }
  const id = l.slice(0, 3);
  const data = (l.slice(3).match(/../g) || []).map(h => parseInt(h, 16));
  const now = Date.now();
  let fr = SN.frames.get(id);
  if (!fr) { fr = { id, bytes: data, changed: data.map(() => 0), count: 0 }; SN.frames.set(id, fr); }
  data.forEach((b, i) => { if (fr.count && fr.bytes[i] !== b) fr.changed[i] = now; });
  fr.bytes = data; fr.count++;
  SN.dirty = true;
  if (DRIVE.decode && id === DRIVE.id) {
    try { Object.assign(S.data, DRIVE.decode(data)); render(); } catch {}
  }
}

function renderSniff() {
  if (!SN.dirty || S.view !== 'debug') return;
  SN.dirty = false;
  const now = Date.now();
  const rows = [...SN.frames.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 80);
  $('snTable').innerHTML = rows.map(fr => `
    <div class="sn-row ${fr.id === SN.sel ? 'sel' : ''}" data-id="${fr.id}">
      <b>${fr.id}</b>
      <span>${fr.bytes.map((b, i) => `<i class="${now - fr.changed[i] < 1500 ? 'chg' : ''}">${b.toString(16).padStart(2, '0').toUpperCase()}</i>`).join('')}</span>
      <em>${fr.count}</em>
    </div>`).join('') || '<div class="mini">No frames yet…</div>';
  const fr = SN.frames.get(SN.sel);
  $('snBits').innerHTML = fr ? `<div class="mini">Bits for ${fr.id} (bit 7 → 0)</div>` + fr.bytes.map((b, i) => `
    <div class="bit-row ${now - fr.changed[i] < 1500 ? 'chg' : ''}"><span>B${i}</span>${
      [...b.toString(2).padStart(8, '0')].map(x => `<i class="${x === '1' ? 'on' : ''}">${x}</i>`).join('')}</div>`).join('') : '';
}
setInterval(renderSniff, 200);

/* ---------------- wiring ---------------- */
document.querySelectorAll('.tabs button').forEach(btn => btn.addEventListener('click', () => {
  S.view = btn.dataset.view;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b === btn));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + S.view));
  render();
}));

$('btnConnect').addEventListener('click', () => connect());
$('status').addEventListener('click', () => {
  if (S.mode === 'on' && confirm('Disconnect from the adapter?')) disconnect();
  else if (S.mode === 'demo') { stopDemo(); setMode('off'); }
});
$('btnSniff').addEventListener('click', () => S.sniffing ? stopSniff() : startSniff());
$('snTable').addEventListener('click', e => {
  const row = e.target.closest('.sn-row'); if (!row) return;
  SN.sel = row.dataset.id; SN.dirty = true; renderSniff();
});
document.querySelectorAll('#range button').forEach(btn => btn.addEventListener('click', () => {
  chartMinutes = +btn.dataset.min;
  document.querySelectorAll('#range button').forEach(b => b.classList.toggle('active', b === btn));
  renderEnergy();
}));
$('btnReset').addEventListener('click', () => {
  if (!confirm('Reset trip energy and peaks?')) return;
  T = newTrip(); saveTrip(); hist.length = 0; lastSampleAt = 0;
  $('pkDrive').style.opacity = 0; $('pkRegen').style.opacity = 0;
  renderEnergy();
});
document.documentElement.style.setProperty('--zero', ZERO_PCT + '%');
$('scMin').textContent = KW_MIN; $('scMax').textContent = KW_MAX;
window.addEventListener('beforeunload', saveTrip);
$('btnDemo').addEventListener('click', () => { rcStopWatch(); S.mode === 'demo' ? (stopDemo(), setMode('off')) : startDemo(); });
$('btnCopy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(rawAsText()); log('Copied debug info to clipboard'); }
  catch { log('Clipboard not available'); }
});
$('btnSend').addEventListener('click', async () => {
  const c = $('cmdIn').value.trim().toUpperCase().replace(/\s+/g, '');
  if (!c) return;
  if (!isReadOnly(c) || /^ATMA$/.test(c)) return log(`${c}: blocked. Only read requests (21xx, 22xxxx) and adapter info commands are allowed.`);
  if (S.mode !== 'on') return log('Connect to the adapter first');
  if (S.sniffing) return log('Stop the sniffer first');
  try { log(`${c} → ${(await S.elm.send(c, 6000)).replace(/\s+/g, ' ')}`); }
  catch (e) { log(`${c} failed: ${e.message}`); }
});


if (!navigator.bluetooth) {
  $('noBt').classList.remove('hidden');
  $('btnConnect').disabled = true;
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
/* start-up happens in main.js once every module has loaded */
