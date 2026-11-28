'use strict';
/* =====================================================================
   Car data beyond the battery (LeafSpy-level), all READ-ONLY.
   ---------------------------------------------------------------------
   Every request here is service 0x22 "read data by identifier". It can't
   change anything in the car. Identifiers and scaling come from the open-
   source Home Assistant Leaf integration (py-nissan-leaf-obd-ble) and
   community docs. Ones marked verify:true still need checking against
   LeafSpy / the dash on your car.

   tier = poll every N ticks (a tick is roughly one second).
   ===================================================================== */

const s16 = (v, i) => { const x = (v[i] << 8) | v[i + 1]; return x & 0x8000 ? x - 0x10000 : x; };
const u16 = (v, i) => (v[i] << 8) | v[i + 1];

const CAR_DIDS = [
  // VCM (0x797 → 0x79A)
  { key: 'gearRaw',    ecu: 'vcm', did: '1156', tier: 1, fast: true,  len: 1, dec: v => v[0] },
  { key: 'speed',      ecu: 'vcm', did: '121A', tier: 1, fast: true,  len: 2, dec: v => s16(v, 0) / 10, unit: 'km/h' },
  { key: 'motorKw',    ecu: 'vcm', did: '1146', tier: 1, fast: true,  len: 2, dec: v => s16(v, 0) * 40 / 1000, unit: 'kW' },
  { key: 'brakeRaw',   ecu: 'vcm', did: '1305', tier: 1, fast: true,  len: 1, dec: v => v[0] },             // 0x04 = brake pedal pressed (mode scan, 14 Nov 2026)
  { key: 'accelRaw',   ecu: 'vcm', did: '1132', tier: 2, drive: 3,  len: 2, dec: v => u16(v, 0) },      // accelerator: 0 released, 314 about halfway, 682 on the floor
  { key: 'brakeRawPos', ecu: 'vcm', did: '1119', tier: 3, drive: 4, len: 2, dec: v => u16(v, 0) },      // brake pedal: 0 released, 31 light, 1022 firm
  { key: 'rpm',        ecu: 'vcm', did: '1255', tier: 2, drive: 6,  len: 2, dec: v => s16(v, 0), unit: 'rpm', verify: true },
  { key: 'ePedalRaw',  ecu: 'vcm', did: '131A', tier: 1, drive: 3,  len: 1, dec: v => v[0] },        // as often as ECO (131B): both are switches you press
  { key: 'auxKw',      ecu: 'vcm', did: '1152', tier: 5, drive: 15,  len: 1, dec: v => v[0] * 100 / 1000, unit: 'kW' },
  // climate (confirmed on a 2021 ZE1 with a step-by-step mode scan)
  { key: 'climRaw',    ecu: 'vcm', did: '1323', tier: 3, drive: 10,  len: 1, dec: v => v[0] },            // 0x20 = climate running
  { key: 'hvacRaw',    ecu: 'vcm', did: '131B', tier: 1, drive: 3,  len: 1, dec: v => v[0] },            // 0x01 = A/C, 0x10 = ECO, 0x20 = rear demister
  { key: 'acCompRpm',  ecu: 'vcm', did: '1178', tier: 5, drive: 30,  len: 2, dec: v => u16(v, 0), unit: 'rpm' },
  { key: 'acCoilTemp', ecu: 'vcm', did: '1263', tier: 5, drive: 30,  len: 1, dec: v => v[0] / 2 - 40, unit: '°C' },
  { key: 'heaterKw',   ecu: 'vcm', did: '1262', tier: 5, drive: 10,  len: 1, dec: v => v[0] * 250 / 1000, unit: 'kW' },
  { key: 'aux12A',     ecu: 'vcm', did: '1183', tier: 5, drive: 15,  len: 2, dec: v => s16(v, 0) / 256, unit: 'A' },
  { key: 'aux12V',     ecu: 'vcm', did: '1103', tier: 10, len: 1, dec: v => v[0] * 0.08, unit: 'V' },
  { key: 'ready',      ecu: 'vcm', did: '1304', tier: 5, drive: 30,  len: 1, dec: v => (v[0] & 0x80) === 0x80 },
  { key: 'ambient',    ecu: 'vcm', did: '115D', tier: 10, len: 1, dec: v => v[0] / 2 - 40, unit: '°C' },
  { key: 'chargeMode', ecu: 'vcm', did: '114E', tier: 5, drive: 60,  len: 1, dec: v => v[0] },
  { key: 'plug',       ecu: 'vcm', did: '1234', tier: 10, drive: 60, len: 1, dec: v => v[0] },     // 0 unplugged, 1 partly plugged, 2 plugged in
  { key: 'obcKw',      ecu: 'vcm', did: '1236', tier: 5, drive: 60,  len: 2, dec: v => s16(v, 0) * 100 / 1000, unit: 'kW' },
  { key: 'qc',         ecu: 'vcm', did: '1203', tier: 60, len: 2, dec: v => u16(v, 0) },
  { key: 'l1l2',       ecu: 'vcm', did: '1205', tier: 60, len: 2, dec: v => u16(v, 0) },
  // Meter / cluster (0x743 → 0x763)
  // odometer: the UK car reports it in miles (a real drive: +20 while GPS measured 32.0 km, 19 Nov 2026); stored in km
  { key: 'odoKm',      ecu: 'meter', did: '0E01', tier: 60, len: 3, dec: v => ((v[0] << 16) | (v[1] << 8) | v[2]) * (ODO_MILES ? 1.609344 : 1), unit: 'km' },
  // dash range: a 13-byte reply in two pieces, so it needs flow control (fc). Raw 168 at 74% charge: km, not tenths
  { key: 'gomKm',      ecu: 'meter', did: '0E24', tier: 10, fc: true, len: 2, dec: v => s16(v, 0), unit: 'km', verify: true },
  { key: 'tyreFR',     ecu: 'meter', did: '0E25', tier: 30, len: 1, dec: v => v[0] ? v[0] * 1.7236894 : null, unit: 'kPa' },   // 0 = sensor not awake yet
  { key: 'tyreFL',     ecu: 'meter', did: '0E26', tier: 30, len: 1, dec: v => v[0] ? v[0] * 1.7236894 : null, unit: 'kPa' },   // 0 = sensor not awake yet
  { key: 'tyreRR',     ecu: 'meter', did: '0E27', tier: 30, len: 1, dec: v => v[0] ? v[0] * 1.7236894 : null, unit: 'kPa' },   // 0 = sensor not awake yet
  { key: 'tyreRL',     ecu: 'meter', did: '0E28', tier: 30, len: 1, dec: v => v[0] ? v[0] * 1.7236894 : null, unit: 'kPa' },   // 0 = sensor not awake yet
];

const ODO_MILES = true;      // the reference (UK) car's cluster counts miles; a km car would set this false
const ACCEL_FLOOR = 682;      // accelerator reading with the pedal on the floor (mode scan, 14 Nov 2026)
const CHARGE_MODES = { 0: 'Not charging', 1: 'Charging (3-pin / L1)', 2: 'Charging (wallbox / L2)', 3: 'Rapid charging' };

/* per-identifier status: last raw reply, misses (unsupported ones get skipped) */
const CD = { raw: {}, miss: {}, skip: {}, vin: null };

/** Read one identifier from any ECU. Returns data bytes or null. */
async function ecuRead(ecu, did, timeout = 1500, fc = false) {
  await useEcu(ecu, fc);
  let text;
  try { text = await S.elm.send('22' + did, timeout); } catch { return null; }
  let b;
  try { b = parseReply(text); } catch { return null; }
  if (b[0] === 0x7F) return null;                                                   // 7F 22 xx = not supported
  if (b[0] !== 0x62 || ((b[1] << 8) | b[2]) !== parseInt(did, 16)) { S.elm?.markLost?.(); return null; }   // a reply to something else
  return b.slice(3);
}

/* "drive" (where given) is how often, in seconds, to read a value while the car is moving. On a real
   Bluetooth link each request takes 70–100 ms, so there's only time for a couple of extra reads per cycle:
   things that matter little on the move (the A/C compressor, the charger, the plug) wait longer, which
   leaves room for cells, temperatures, the odometer, dash range and tyres. */
const carMoving = () => (S.data.speed ?? 0) > 5;

/** Read one identifier and store its decoded value. */
async function readCarDid(d) {
  const v = await ecuRead(d.ecu, d.did, 1500, !!d.fc);
  if (!v || v.length < d.len) {
    CD.miss[d.key] = (CD.miss[d.key] || 0) + 1;
    if (CD.miss[d.key] === 3 && !d.fast) { CD.skip[d.key] = true; log(`${d.key} (${d.ecu} 22 ${d.did}): no reply, skipping`); }   // speed, gear, power and brake are never given up on
    return;
  }
  CD.miss[d.key] = 0; CD.skip[d.key] = false;
  CD.raw[d.key] = v;
  try { S.data[d.key] = d.dec(v); } catch {}
}

/** Turn raw states into the values the UI uses. */
function deriveCarData() {
  const d = S.data;
  if (d.gearRaw != null) {
    d.gear = d.gearRaw === 0 ? null : GEARS[d.gearRaw] || `?${d.gearRaw}`;   // 0: seen as the car switches off
    if (d.gearRaw !== 0 && !GEARS[d.gearRaw] && !S.gearWarned?.[d.gearRaw]) { (S.gearWarned ||= {})[d.gearRaw] = 1; log(`Unknown gear value ${d.gearRaw}: tell Claude which gear this was`); }
  }
  if (d.ePedalRaw != null) d.ePedal = d.ePedalRaw === 0x04;
  if (d.brakeRaw != null) d.brakeOn = (d.brakeRaw & 0x04) !== 0;
  if (d.accelRaw != null) d.accel = Math.min(100, d.accelRaw / ACCEL_FLOOR * 100);
  if (d.brakeRawPos != null) d.brakePedal = Math.min(100, d.brakeRawPos / 1023 * 100);
  if (d.climRaw != null) d.climateOn = (d.climRaw & 0x20) !== 0;
  if (d.hvacRaw != null) { d.acOn = (d.hvacRaw & 0x01) !== 0; d.rearDemist = (d.hvacRaw & 0x20) !== 0; d.eco = (d.hvacRaw & 0x10) !== 0; }
  d.tyres = ['tyreFL', 'tyreFR', 'tyreRL', 'tyreRR'].map(k => d[k] ?? null);
}

/* ---------------- exterior lights (for the Drive screen car) ----------------
   Each light is a bit in a read-only identifier, found with the mode scanner.
   From the Lights scans on a 2021 ZE1 (11 and 14 Nov 2026):
     cluster 0E07 byte 0: 01 = main beam
     cluster 0E07 byte 1: 10 = side / tail lights, 20 + 40 = fog lights, 80 = an indicator is lit
     cluster 0E0F byte 3: 01 = dipped beam
     main computer 1305 byte 0: 04 = brake pedal pressed (read in the fast lane as brakeRaw)
   The cluster shows the same bit for the left indicator, the right indicator and the hazards,
   so which side is flashing isn't known. Indicators are therefore hidden (see SHOW_INDICATORS). Reverse comes from the gear. */
const LIGHT_BITS = {
  low:  { ecu: 'meter', did: '0E0F', byte: 3, mask: 0x01 },             // dipped beam (also on with auto lights at night)
  high: { ecu: 'meter', did: '0E07', byte: 0, mask: 0x01 },             // main beam
  tail: { ecu: 'meter', did: '0E07', byte: 1, mask: 0x10 },             // side / tail lights (on with dipped and main too)
  fog:  { ecu: 'meter', did: '0E07', byte: 1, mask: 0x60, all: true },  // both fog bits came on together; which is front and which is rear isn't known yet
  ind:  { ecu: 'meter', did: '0E07', byte: 1, mask: 0x80 },             // any indicator or the hazards; the bit flashes with the lamp
  indL: null, indR: null, hazard: null,                                 // not found: would need the body computer
};
const LIGHT_RAW = {}, IND = { at: 0 };
// Indicators are hidden on the car picture for now: the car doesn't say which side is flashing, and showing
// both sides for a left or right turn looked wrong. Set this to true to show both sides flashing again.
const SHOW_INDICATORS = false;
/** How often to read the lights (seconds). The gap varies a little, so the readings can't fall into
 *  step with a flashing indicator and keep landing on its dark half. */
const lightsEvery = () => !SHOW_INDICATORS ? (carMoving() ? 3 : 1.5) : Date.now() - IND.at < 8000 ? 0.9 : 1.4 + Math.random() * 0.4;

async function pollLights() {
  // not flashing yet: start at a slightly random moment, so readings don't keep step with the poll cycle
  if (SHOW_INDICATORS && LIGHT_BITS.ind && Date.now() - IND.at >= 8000) await sleep(Math.random() * 350);
  const t0 = Date.now(), indKey = LIGHT_BITS.ind ? `${LIGHT_BITS.ind.ecu}:${LIGHT_BITS.ind.did}` : null;
  const want = new Map();
  for (const b of Object.values(LIGHT_BITS)) if (b) want.set(`${b.ecu}:${b.did}`, b);
  const read = async key => { const b = want.get(key), v = await ecuRead(b.ecu, b.did, 1500, true); if (v) LIGHT_RAW[key] = v; if (key === indKey) IND.readAt = Date.now(); };   // replies are multi-frame
  // the identifier with the indicator bit is read every time; the rest only every 3 s
  const slow = t0 - (IND.restAt || 0) > 3000;
  for (const key of want.keys()) if (key === indKey || slow) await read(key);
  if (slow) IND.restAt = t0;
  // While an indicator is flashing, a reading that finds it dark is repeated a third of a second later,
  // which lands on the lit half of the flash.
  if (SHOW_INDICATORS && indKey && !lightBit('ind') && t0 - IND.at < 8000) { await sleep(Math.max(0, 330 - (Date.now() - IND.readAt))); await read(indKey); }
  if (lightBit('ind') || lightBit('indL') || lightBit('indR') || lightBit('hazard')) IND.at = Date.now();
}
function lightBit(k) {
  const b = LIGHT_BITS[k]; if (!b) return null;
  const v = LIGHT_RAW[`${b.ecu}:${b.did}`]; if (!v || v.length <= b.byte) return null;
  return b.all ? (v[b.byte] & b.mask) === b.mask : (v[b.byte] & b.mask) !== 0;
}
function carLights(d) {
  if (d.demoLights) return d.demoLights;
  const L = {};
  for (const k of ['low', 'high', 'tail', 'fog']) L[k] = lightBit(k);
  // The indicator bit flashes with the lamp, so a reading can land on the dark half. Keep showing it for 2.4 s
  // after it was last seen lit; the car picture does its own flashing. Side unknown, so both sides flash.
  const flashing = SHOW_INDICATORS && Date.now() - IND.at < 2400;
  L.indL = flashing; L.indR = flashing;
  L.reverse = d.gear === 'R';
  if (L.tail == null) L.tail = (L.low == null && L.high == null) ? true : !!(L.low || L.high);
  // brake lamps: the pedal, or strong regen (the car lights them when e-Pedal or B mode slows it firmly)
  L.brake = d.brakeOn === true || (d.kw ?? 0) < -8;
  return L;
}

/** VIN once per connection (VCM 21 81, read-only, multi-frame). */
async function readVin() {
  if (CD.vin) return;
  try {
    await useEcu('vcm');
    await useEcu('vcm', true);                           // VIN is a long (multi-frame) reply
    const b = parseReply(await S.elm.send('2181', 4000));
    if (b[0] === 0x61 && b[1] === 0x81) {
      const vin = String.fromCharCode(...b.slice(2).filter(x => x >= 0x30 && x <= 0x5a)).slice(0, 17);
      if (vin.length === 17) { CD.vin = vin; S.data.vin = vin; }
    }
  } catch {}
}

/* ---------------- demo values ---------------- */
function demoCarData(t, kw, spd) {
  return {
    speed: spd, motorKw: Math.max(0, kw - 1.3), rpm: Math.round(spd * 82),
    auxKw: 0.4, heaterKw: t % 40 < 25 ? 1.25 : 0, climateOn: true, acOn: t % 40 >= 25, rearDemist: false, eco: t % 52 < 13, acCompRpm: t % 40 >= 25 ? 6500 : 0, acCoilTemp: t % 40 >= 25 ? 6 : 24, aux12A: -0.54, aux12V: 13.0,
    ready: true, ambient: 11, chargeMode: 0, plug: 0, obcKw: 0,
    qc: 287, l1l2: 737, odoKm: 27188, gomKm: 196.0,
    tyreFL: 248, tyreFR: 250, tyreRL: 241, tyreRR: 243,
    ePedal: t % 60 > 40, vin: null,
    accel: Math.max(0, Math.min(100, kw * 1.1)), brakePedal: kw < -6 ? Math.min(100, -kw * 2) : 0, brakeOn: kw < -6,
  };
}
