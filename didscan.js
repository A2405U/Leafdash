'use strict';
/* =====================================================================
   Mode scanner (Developer mode, read-only)
   ---------------------------------------------------------------------
   Finds which of the car's values follow a control (a light, a pedal, a
   button). Every test is the same shape:

     starting point  →  turn ONE thing on  →  turn it back off

   The starting point is read twice, so values that change by themselves
   are known and ignored. Each "on" reading is compared with the starting
   point, and the "off" reading checks the value went back. A value that
   changed when the thing went on and returned when it went off is a
   likely match; those are listed first.

   Every request is service 0x22 "read data by identifier", which only
   reads. The identifiers your car answers are remembered, so after the
   first full search a reading takes seconds.
   ===================================================================== */

const DS_ECUS = {
  vcm:   { name: 'Main computer (VCM)', range: [0x1100, 0x13ff], on: true },
  meter: { name: 'Instrument cluster', range: [0x0e00, 0x0eff], on: true, note: 'headlights were found here' },
  bcm:   { name: 'Body computer (BCM)', range: [0x0e00, 0x0eff], on: false, note: 'answers nothing here (tried 14 Nov 2026)' },
};
if (!ECUS.bcm) ECUS.bcm = { tx: '745', rx: '765' };

/* Each group has a starting point the car must be in, and tests that each change ONE thing and put it back.
   hold  = you have to keep holding it (a pedal), so the app beeps when you can let go
   flash = it flashes, so it's read several times to be sure of catching it lit */
const T_ = (id, name, on, off, x = {}) => ({ id, name, on, off, ...x });
const DS_GROUPS = [
  { id: 'gears', name: 'Gears', start: 'Car in READY, in P, parking brake on. Keep your foot on the brake pedal for this whole group.', tests: [
    T_('r', 'Reverse', 'Shift to R. Stay stopped, foot on the brake.', 'Shift back to P.'),
    T_('n', 'Neutral', 'Shift to N.', 'Shift back to P.'),
    T_('d', 'Drive', 'Shift to D. Stay stopped, foot on the brake.', 'Shift back to P.'),
    T_('b', 'B mode', 'Shift to D, then pull the shifter again so the dash shows B. Stay stopped.', 'Shift back to P.'),
  ] },
  { id: 'modes', name: 'ECO and e-Pedal', start: 'Car in READY, in P. ECO off and e-Pedal off.', tests: [
    T_('eco', 'ECO', 'Press the ECO button so ECO shows on the dash.', 'Press ECO again so it goes out.'),
    T_('epedal', 'e-Pedal', 'Switch e-Pedal on.', 'Switch e-Pedal off.'),
  ] },
  { id: 'climate', name: 'Climate control', start: 'Car in READY, in P. Climate control fully off (press its OFF button). Rear window heater off.', tests: [
    T_('fan', 'Fan only', 'Turn the fan on, with the A/C light off.', 'Press OFF so the climate is fully off again.'),
    T_('heat', 'Heating', 'Turn the climate on and set the temperature as high as it goes.', 'Press OFF so the climate is fully off again.'),
    T_('ac', 'A/C', 'Turn the climate on, set the temperature as low as it goes, and press A/C so its light is on.', 'Press OFF so the climate is fully off again.'),
    T_('demist', 'Windscreen demist', 'Press the windscreen demist button.', 'Press it again, then OFF, so the climate is fully off.'),
    T_('rear', 'Rear window heater', 'Press the rear window heater button.', 'Press it again so it goes out.'),
    T_('seat', 'Heated seat', 'Turn the driver\'s heated seat on (skip this if not fitted).', 'Turn the heated seat off.'),
    T_('wheel', 'Heated steering wheel', 'Turn the heated steering wheel on (skip this if not fitted).', 'Turn the heated steering wheel off.'),
  ] },
  { id: 'lights', name: 'Lights', start: 'Car in READY, in P. Light switch at OFF (not AUTO). Indicators, hazards and fog lights off. Feet off the pedals.', tests: [
    T_('side', 'Side lights', 'Turn the light switch to side lights (the first position).', 'Turn the light switch back to OFF.'),
    T_('low', 'Dipped headlights', 'Turn the light switch to dipped headlights.', 'Turn the light switch back to OFF.'),
    T_('high', 'Main beam', 'Turn the dipped headlights on, then push the stalk for main beam (blue light on the dash).', 'Main beam off, then the light switch back to OFF.'),
    T_('indl', 'Left indicator', 'Put the left indicator on and leave it flashing.', 'Cancel the indicator.', { flash: true }),
    T_('indr', 'Right indicator', 'Put the right indicator on and leave it flashing.', 'Cancel the indicator.', { flash: true }),
    T_('hazard', 'Hazard lights', 'Press the hazard button and leave them flashing.', 'Press the hazard button again.', { flash: true }),
    T_('ffog', 'Front fog lights', 'Turn the dipped headlights on, then turn the fog switch to its first position, so only the front fog lights are on.', 'Fog lights off, then the light switch back to OFF.'),
    T_('fog', 'Rear fog light', 'Turn the dipped headlights on, then turn the fog switch on through the front fogs to the rear fog (amber light on the dash). The front fogs stay on too.', 'Fog lights off, then the light switch back to OFF.'),
    T_('brakel', 'Brake lights', 'Press the brake pedal and keep it pressed.', 'Take your foot off the brake.', { hold: true }),
    T_('rev', 'Reverse light', 'Foot on the brake, shift to R. Stay stopped.', 'Shift back to P.'),
  ] },
  { id: 'pedals', name: 'Brake and accelerator', start: 'Car in READY, in P, parking brake on. Both feet off the pedals. Nothing moves in P.', tests: [
    T_('brk1', 'Brake, light press', 'Rest your foot on the brake so it is only just pressed, and hold it there.', 'Take your foot off the brake.', { hold: true }),
    T_('brk2', 'Brake, firm press', 'Press the brake firmly and hold it.', 'Take your foot off the brake.', { hold: true }),
    T_('acc1', 'Accelerator, halfway', 'Press the accelerator about halfway and hold it.', 'Take your foot off the accelerator.', { hold: true }),
    T_('acc2', 'Accelerator, to the floor', 'Press the accelerator all the way down and hold it.', 'Take your foot off the accelerator.', { hold: true }),
  ] },
  { id: 'doors', name: 'Doors and boot', start: 'Car in READY, in P. Every door, the boot and the charge flap shut.', tests: [
    T_('drv', 'Driver\'s door', 'Open the driver\'s door.', 'Shut the driver\'s door.'),
    T_('pas', 'Passenger door', 'Open the front passenger door.', 'Shut the passenger door.'),
    T_('rearl', 'Rear door', 'Open a rear door.', 'Shut the rear door.'),
    T_('boot', 'Boot', 'Open the boot.', 'Shut the boot.'),
    T_('flap', 'Charge flap', 'Open the charge flap on the nose.', 'Shut the charge flap.'),
  ] },
  { id: 'other', name: 'Other controls', start: 'Car in READY, in P, parking brake on, seatbelt fastened, wipers off.', tests: [
    T_('pbrake', 'Parking brake', 'Foot on the brake pedal, then release the parking brake.', 'Put the parking brake back on.'),
    T_('belt', 'Seatbelt', 'Unfasten the driver\'s seatbelt.', 'Fasten the seatbelt again.'),
    T_('wiper', 'Wipers', 'Turn the front wipers on (slow).', 'Turn the wipers off.'),
  ] },
];
const DS_CUSTOM = { id: 'custom', name: 'Your own tests', start: 'Car in READY, in P, with everything as it normally is when parked.' };

const DS_KEY = 'leafdash.modescan.found', DS_PREF = 'leafdash.modescan.prefs';
const DS = { el: null, units: [], at: 0, phase: 'on', res: {}, found: {}, busy: false, cancel: false, exported: false, ecus: [], fresh: false, ac: null, demo: null };

const hex4 = n => n.toString(16).toUpperCase().padStart(4, '0');
const hexBytes = b => b.map(x => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const hb = v => v ? hexBytes(v) : '—';
const savedFound = () => { try { return JSON.parse(localStorage.getItem(DS_KEY)) || {}; } catch { return {}; } };
const dsPrefs = () => { try { return { ecus: null, custom: [], ...JSON.parse(localStorage.getItem(DS_PREF)) }; } catch { return { ecus: null, custom: [] }; } };
const dsSavePrefs = p => { try { localStorage.setItem(DS_PREF, JSON.stringify(p)); } catch {} };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** All groups, with any tests you've added yourself as a last group. */
function dsGroups() {
  const mine = dsPrefs().custom.map((name, i) => T_('c' + i, name, `Do this: ${name}.`, `Undo it: put ${name} back to how it was.`, { custom: true }));
  return mine.length ? [...DS_GROUPS, { ...DS_CUSTOM, tests: mine }] : DS_GROUPS;
}

/* ---------------- open / close ---------------- */
async function dsOpen() {
  if (S.mode !== 'on' && S.mode !== 'demo') return log('Connect to the adapter (or start Demo) first');
  if (S.sniffing) return log('Stop the sniffer first');
  S.sniffing = true;                                   // pause normal polling
  Object.assign(DS, { units: [], at: 0, phase: 'on', res: {}, found: {}, exported: false, cancel: false });
  DS.el = document.createElement('div');
  DS.el.className = 'modal-wrap';
  DS.el.innerHTML = '<div class="modal sheet"></div>';
  document.body.appendChild(DS.el);
  keepAwake();
  dsRender('setup');
}
function dsClose() {
  if (DS.busy) { DS.cancel = true; return; }
  if (dsDone().length && !DS.exported && !confirm('Close and discard these results?')) return;
  DS.el?.remove(); DS.el = null;
  S.sniffing = false; S.ecu = null; S.fc = null;
  log('Mode scanner closed, normal polling resumed');
}

/** Two short beeps and a buzz: the reading is finished, so a held pedal can be let go. */
function dsBeep() {
  try {
    const ac = DS.ac ||= new (window.AudioContext || window.webkitAudioContext)();
    ac.resume?.();
    [0, 0.2].forEach(t => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ac.destination);
      g.gain.setValueAtTime(0.0001, ac.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.25, ac.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + 0.14);
      o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.16);
    });
  } catch {}
  try { navigator.vibrate?.([120, 80, 120]); } catch {}
}

/* ---------------- reading ---------------- */
async function dsRead(ecu, id) {
  if (S.mode === 'demo') { if (!DS.searching) await sleep(25); return demoDid(ecu, id); }   // paced like the car, so flashing shows up
  return ecuRead(ecu, hex4(id), 1200, true);          // read-only (22 xx xx); long replies allowed
}

/** Read a list of [computer, identifier] once. Returns { 'vcm:1156': bytes } or null if cancelled. */
async function dsPass(jobs, label, note, done = 0, total = jobs.length) {
  const values = {}, t0 = Date.now();
  for (let i = 0; i < jobs.length && !DS.cancel; i++) {
    const [e, id] = jobs[i];
    const v = await dsRead(e, id);
    if (v) values[`${e}:${hex4(id)}`] = v;
    if (i % 5 === 0 || i === jobs.length - 1) {
      const per = (Date.now() - t0) / (i + 1);
      dsRender('scanning', { label, note, i: done + i + 1, n: total, hits: Object.keys(values).length, eta: per * (total - done - i - 1) / 1000 });
    }
  }
  return DS.cancel ? null : values;
}
const dsJobs = () => DS.ecus.flatMap(e => (DS.found[e] || []).map(id => [e, id]));
const dsKeyJob = k => { const [e, id] = k.split(':'); return [e, parseInt(id, 16)]; };

/** Run `fn` with polling paused, the short adapter timeout set, and Cancel working. */
async function dsBusy(fn) {
  DS.busy = true; DS.cancel = false;
  if (S.mode === 'on') { try { await S.elm.send('ATST19'); } catch {} }   // shorter wait for silent identifiers
  let out = null;
  try { out = await fn(); } catch (e) { log('Mode scanner: ' + e.message); }
  if (S.mode === 'on') { try { await S.elm.send('ATST32'); } catch {} }
  DS.busy = false;
  return out;
}

/** Starting point: read everything twice. Anything that differs between the two changes by itself. */
async function dsScanBase() {
  const u = DS.units[DS.at], jobs = dsJobs();
  DS.demo = { test: null, on: false };
  const r = await dsBusy(async () => {
    const a = await dsPass(jobs, 'Starting point', 'Leave the car exactly as it is.', 0, jobs.length * 2); if (!a) return null;
    const b = await dsPass(jobs, 'Starting point', 'Leave the car exactly as it is.', jobs.length, jobs.length * 2); if (!b) return null;
    const noise = Object.keys({ ...a, ...b }).filter(k => hb(a[k]) !== hb(b[k]));
    return { base: b, noise, at: new Date().toISOString() };
  });
  if (!r) return dsRender('unit');
  DS.res[DS.at] = r;
  dsBeep();
  dsGo(DS.at + 1);
}

/** What the car should read like before test i: the last "off" reading in this group, else the starting point. */
function dsBaseFor(i) {
  const g = DS.units[i].g.id;
  let noise = [];
  for (let j = i - 1; j >= 0 && DS.units[j].g.id === g; j--) if (DS.units[j].kind === 'base' && DS.res[j]) noise = DS.res[j].noise;
  for (let j = i - 1; j >= 0 && DS.units[j].g.id === g; j--) {
    const r = DS.res[j];
    if (r?.off) return { base: r.off, noise };
    if (r?.base) return { base: r.base, noise };
  }
  return null;
}

/** "On" reading: everything once (three times if it flashes), then the values that moved are read again
 *  a few times, to see whether they hold steady or flash. */
async function dsScanOn() {
  const u = DS.units[DS.at], jobs = dsJobs(), ref = dsBaseFor(DS.at);
  if (!ref) return dsRender('unit');
  const passes = u.t.flash ? 3 : 1, note = u.t.hold ? 'Keep holding until you hear the beeps.' : 'Leave it on until you hear the beeps.';
  DS.demo = { test: u.t.id, on: true };
  const r = await dsBusy(async () => {
    // something you hold: count down first, so it's already pressed when the reading starts
    if (u.t.hold) for (let n = 3; n > 0 && !DS.cancel; n--) { dsRender('countdown', { label: u.t.name, n }); await sleep(1000); }
    if (DS.cancel) return null;
    const seen = {}, noise = new Set(ref.noise);
    let first = null;
    const take = v => { for (const k in v) { const h = hb(v[k]); (seen[k] ||= []); if (!seen[k].includes(h)) seen[k].push(h); } };
    for (let p = 0; p < passes; p++) {
      const v = await dsPass(jobs, `${u.t.name}: on`, note, p * jobs.length, passes * jobs.length); if (!v) return null;
      first ||= v; take(v);
    }
    // only values that answered at the starting point too, so a dropped reply never looks like a change
    const moved = () => Object.keys(seen).filter(k => ref.base[k] && !noise.has(k) && seen[k].some(h => h !== hb(ref.base[k])));
    const again = moved().slice(0, 40).map(dsKeyJob);
    for (let p = 0; p < 4 && again.length; p++) {
      const v = await dsPass(again, `${u.t.name}: on`, note, p * again.length, 4 * again.length); if (!v) return null;
      take(v);
      if (!u.t.flash && p >= 1) break;
    }
    return { base: ref.base, noise: ref.noise, on: first, seen, cand: moved(), at: new Date().toISOString() };
  });
  if (!r) return dsRender('unit');
  DS.res[DS.at] = r; DS.phase = 'off';
  dsBeep();
  dsRender('unit');
}

/** "Off" reading: did each value that moved go back to where it started? */
async function dsScanOff() {
  const u = DS.units[DS.at], r = DS.res[DS.at], jobs = dsJobs();
  DS.demo = { test: u.t.id, on: false };
  const off = await dsBusy(() => dsPass(jobs, `${u.t.name}: off`, 'Leave it off until you hear the beeps.'));
  if (!off) return dsRender('unit');
  r.off = off; DS.phase = 'result';
  dsBeep();
  dsRender('unit');
}

/* ---------------- working out the results ---------------- */
/** Which bytes and bits differ between two readings, e.g. "byte 3: 00 → 01 (bit 01)". */
function dsBits(a, b) {
  if (!a || !b || a.length !== b.length) return { text: `${hb(a)} → ${hb(b)}`, n: 99 };
  const parts = []; let n = 0;
  a.forEach((x, i) => {
    if (x === b[i]) return;
    const d = x ^ b[i]; n += d.toString(2).split('1').length - 1;
    parts.push(`byte ${i}: ${x.toString(16).toUpperCase().padStart(2, '0')} → ${b[i].toString(16).toUpperCase().padStart(2, '0')} (bit${(d & (d - 1)) ? 's' : ''} ${d.toString(16).toUpperCase().padStart(2, '0')})`);
  });
  return { text: parts.join(', '), n };
}
const dsDone = () => DS.units.map((u, i) => ({ u, r: DS.res[i], i })).filter(x => x.u.kind === 'test' && x.r?.on);

/** For one finished test: values that followed it (changed on, back when off) and values that changed and stayed changed. */
function dsVerdict(i, drift = new Set()) {
  const u = DS.units[i], r = DS.res[i];
  const rows = (r.cand || []).filter(k => !drift.has(k)).map(k => {
    const from = r.base[k], vals = r.seen[k] || [], onHex = vals.find(h => h !== hb(from)) || hb(r.on[k]);
    const to = onHex.split(' ').map(x => parseInt(x, 16)), bits = dsBits(from, from && onHex !== '—' ? to : null);
    return { k, from: hb(from), to: onHex, bits, flashing: vals.length > 1, back: r.off?.[k] ? hb(r.off[k]) === hb(from) : null };
  });
  const byBits = (a, b) => a.bits.n - b.bits.n || a.k.localeCompare(b.k);
  return { u, likely: rows.filter(x => x.back === true).sort(byBits), stayed: rows.filter(x => x.back === false).sort(byBits), unchecked: rows.filter(x => x.back == null).sort(byBits) };
}
/** Values that changed and didn't go back in two or more tests are drifting by themselves (timers, temperatures). */
function dsDrift() {
  const n = {};
  for (const { i } of dsDone()) for (const x of dsVerdict(i).stayed) n[x.k] = (n[x.k] || 0) + 1;
  return new Set(Object.keys(n).filter(k => n[k] >= 2));
}

function dsText() {
  const drift = dsDrift(), done = dsDone();
  const L = ['# Leaf Dash mode scan v2 (read-only, service 0x22)',
    `# app ${LeafDash.version} · ${new Date().toISOString()} · ${S.mode === 'demo' ? 'DEMO DATA' : 'live'}`,
    `# computers: ${DS.ecus.map(e => `${e} (${DS.found[e]?.length || 0} values)`).join(', ')}`,
    '# method: starting point read twice; each test read on, then off; compared with the reading before it', ''];
  L.push('## Likely matches (changed when on, went back when off). Fewest changed bits first.');
  for (const { u, i } of done) {
    const v = dsVerdict(i, drift);
    L.push(`### ${u.g.name} → ${u.t.name}${u.t.flash ? ' (flashing: read 3 times)' : ''}${u.t.hold ? ' (held)' : ''}`);
    v.likely.forEach(x => L.push(`${x.k}  ${x.bits.text}${x.flashing ? '  [flashing]' : ''}   full: ${x.from} → ${x.to}`));
    v.unchecked.forEach(x => L.push(`${x.k}  ${x.bits.text}   full: ${x.from} → ${x.to}   [off not checked]`));
    if (!v.likely.length && !v.unchecked.length) L.push('(nothing followed this)');
  }
  L.push('', '## Changed but did not go back (probably not caused by the test)');
  for (const { u, i } of done) { const v = dsVerdict(i, drift); if (v.stayed.length) { L.push(`### ${u.g.name} → ${u.t.name}`); v.stayed.forEach(x => L.push(`${x.k}  ${x.from} → ${x.to}`)); } }
  L.push('', '## Ignored: change by themselves');
  const noise = new Set(Object.values(DS.res).flatMap(r => r.noise || []));
  L.push(`between the two starting readings: ${[...noise].sort().join(', ') || '(none)'}`);
  L.push(`drifted during two or more tests: ${[...drift].sort().join(', ') || '(none)'}`);
  L.push('', '## Skipped tests');
  L.push(DS.units.filter((u, i) => u.kind === 'test' && !DS.res[i]?.on).map(u => `${u.g.name} → ${u.t.name}`).join(', ') || '(none)');
  L.push('', '## Every reading');
  let g = null, cols = [];
  const flush = () => {
    if (!cols.length) return;
    L.push(`### ${g.name}: ${cols.map((c, n) => `${n + 1}=${c.label}`).join(', ')}`);
    const keys = [...new Set(cols.flatMap(c => Object.keys(c.v)))].sort();
    for (const k of keys) L.push(`${k}  ` + cols.map(c => hb(c.v[k])).join(' | '));
    cols = [];
  };
  DS.units.forEach((u, i) => {
    const r = DS.res[i]; if (!r) return;
    if (g !== u.g) { flush(); g = u.g; }
    if (u.kind === 'base') cols.push({ label: 'start', v: r.base });
    else { cols.push({ label: `${u.t.name} on`, v: r.on }); if (r.off) cols.push({ label: `${u.t.name} off`, v: r.off }); }
  });
  flush();
  return L.join('\n');
}

async function dsShare() {
  DS.exported = true;
  const d = new Date(), p = n => String(n).padStart(2, '0');
  const f = new File([dsText()], `leafdash-modescan-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.txt`, { type: 'text/plain' });
  if (navigator.canShare?.({ files: [f] })) {
    try { await navigator.share({ files: [f], title: 'Leaf Dash mode scan' }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
}

/* ---------------- moving through the plan ---------------- */
function dsStart(box) {
  DS.ecus = [...box.querySelectorAll('[data-ecu]:checked')].map(x => x.dataset.ecu);
  DS.fresh = box.querySelector('[data-fresh]')?.checked;
  DS.units = []; DS.res = {};
  for (const g of dsGroups()) {
    const tests = g.tests.filter(t => box.querySelector(`[data-test="${g.id}:${t.id}"]`)?.checked);
    if (!tests.length) continue;
    DS.units.push({ kind: 'base', g });
    tests.forEach(t => DS.units.push({ kind: 'test', g, t }));
  }
  if (!DS.ecus.length) return alert('Pick at least one computer to read.');
  if (!DS.units.length) return alert('Tick at least one test.');
  dsSavePrefs({ ...dsPrefs(), ecus: DS.ecus });
  // identifier list: reuse what was found before, or search the full range once
  const saved = savedFound();
  const need = DS.ecus.filter(e => DS.fresh || !saved[e]?.length);
  DS.ecus.forEach(e => { if (saved[e] && !need.includes(e)) DS.found[e] = saved[e]; });
  if (need.length) return dsRender('discover', { need });
  dsGo(0);
}

async function dsDiscover() {
  const need = DS.ecus.filter(e => DS.fresh || !DS.found[e]?.length);
  const jobs = need.flatMap(e => { const [a, b] = DS_ECUS[e].range; return Array.from({ length: b - a + 1 }, (_, i) => [e, a + i]); });
  DS.demo = { test: null, on: false };
  DS.searching = true;
  const values = await dsBusy(() => dsPass(jobs, 'Finding your car\'s values', 'Leave the car as it is (READY, in P).'));
  DS.searching = false;
  if (!values) return dsRender('setup');
  const saved = savedFound();
  for (const e of need) {
    DS.found[e] = Object.keys(values).filter(k => k.startsWith(e + ':')).map(k => parseInt(k.split(':')[1], 16)).sort((a, b) => a - b);
    saved[e] = DS.found[e];
  }
  try { localStorage.setItem(DS_KEY, JSON.stringify(saved)); } catch {}
  log(`Mode scanner: ${need.map(e => `${e} ${DS.found[e].length}`).join(', ')} identifiers answer`);
  dsGo(0);
}

function dsGo(i) {
  DS.at = i; DS.phase = 'on';
  if (i >= DS.units.length) return dsRender('results');
  // a test whose group has no starting point (it was skipped) can't be judged: skip the rest of that group
  if (DS.units[i].kind === 'test' && !dsBaseFor(i)) return dsGo(i + 1);
  dsRender('unit');
}
/** Back: from "turn it off" to "turn it on" again, otherwise to the step before. */
function dsBack() {
  if (DS.units[DS.at]?.kind === 'test' && DS.phase !== 'on') { delete DS.res[DS.at]; DS.phase = 'on'; return dsRender('unit'); }
  if (DS.at === 0) return dsRender('setup');
  DS.at--; delete DS.res[DS.at]; DS.phase = 'on';
  dsRender('unit');
}
function dsSkipGroup() {
  const g = DS.units[DS.at].g;
  let i = DS.at; while (i < DS.units.length && DS.units[i].g === g) i++;
  dsGo(i);
}

/** Add a test of your own (kept for next time), keeping whatever is already ticked. */
function dsAddOwn(box) {
  const name = box.querySelector('[data-own]').value.trim().slice(0, 40);
  if (!name) return;
  const ticked = [...box.querySelectorAll('[data-test]:checked')].map(c => c.dataset.test);
  const ecus = [...box.querySelectorAll('[data-ecu]')].map(c => [c.dataset.ecu, c.checked]);
  const p = dsPrefs(); if (!p.custom.includes(name)) p.custom.push(name); dsSavePrefs(p);
  dsRender('setup');
  const nb = DS.el.querySelector('.sheet');
  ticked.forEach(t => { const c = nb.querySelector(`[data-test="${t}"]`); if (c) { c.checked = true; c.onchange(); } });
  ecus.forEach(([e, on]) => { const c = nb.querySelector(`[data-ecu="${e}"]`); if (c) c.checked = on; });
  const mine = [...nb.querySelectorAll('[data-test^="custom:"]')].pop();
  if (mine) { mine.checked = true; mine.onchange(); mine.closest('details').open = true; mine.scrollIntoView({ block: 'center' }); }
}

/* ---------------- UI ---------------- */
function dsRender(state, x = {}) {
  if (!DS.el) return;
  const box = DS.el.querySelector('.sheet');
  const head = `<div class="row-between"><div class="label">Mode scanner · read-only</div><button class="btn ghost small" data-a="close">${DS.busy ? 'Cancel' : 'Close'}</button></div>`;
  const saved = savedFound(), prefs = dsPrefs();
  const prog = `<div class="cap-prog"><div style="width:${DS.units.length ? DS.at / DS.units.length * 100 : 0}%"></div></div>`;
  const early = dsDone().length ? '<button class="btn ghost small cap-early" data-a="finish">Stop here and show results</button>' : '';

  if (state === 'setup') {
    box.innerHTML = `${head}
      <h3>What do you want to find?</h3>
      <p class="hint">Each test turns one thing on and then back off, and the app looks for the values that follow it. Tick a group, or open it to pick single tests.</p>
      <div class="ds-groups">${dsGroups().map(g => `
        <details class="ds-group"><summary>
          <label data-nofold><input type="checkbox" data-group="${g.id}"> <b>${g.name}</b></label>
          <span class="mini">${g.tests.length} test${g.tests.length === 1 ? '' : 's'}</span></summary>
          <p class="hint">Starts from: ${g.start}</p>
          ${g.tests.map(t => `<label class="ds-step"><input type="checkbox" data-test="${g.id}:${t.id}"> ${esc(t.name)}${t.custom ? ` <button class="ds-rm" data-rm="${esc(t.name)}" aria-label="Remove">✕</button>` : ''}</label>`).join('')}
        </details>`).join('')}</div>
      <div class="cmd ds-add"><input data-own placeholder="Add your own test, e.g. Front fog lights" maxlength="40" autocomplete="off"><button class="btn ghost small" data-a="own">Add</button></div>
      <div class="set-group"><div class="label">Read from</div>
        ${Object.entries(DS_ECUS).map(([id, e]) => `<label class="ds-step"><input type="checkbox" data-ecu="${id}" ${(prefs.ecus ? prefs.ecus.includes(id) : e.on) ? 'checked' : ''}> ${e.name}
          <span class="mini">${saved[id]?.length ? `· ${saved[id].length} known values` : '· first use searches 1–3 min'}${e.note ? ` · ${e.note}` : ''}</span></label>`).join('')}
        <label class="ds-step"><input type="checkbox" data-fresh> Search for values again (slower)</label>
      </div>
      <div class="modal-actions"><button class="btn ghost" data-a="close">Cancel</button><button class="btn primary" data-a="start">Start</button></div>`;
    // ticking a group shouldn't fold or unfold it
    box.querySelectorAll('[data-nofold]').forEach(l => l.onclick = e => e.stopPropagation());
    // ticking a group ticks its tests; ticking a test keeps the group's box in step
    box.querySelectorAll('[data-group]').forEach(cb => cb.onchange = () => {
      box.querySelectorAll(`[data-test^="${cb.dataset.group}:"]`).forEach(s => { s.checked = cb.checked; });
    });
    box.querySelectorAll('[data-test]').forEach(cb => cb.onchange = () => {
      const g = cb.dataset.test.split(':')[0], all = [...box.querySelectorAll(`[data-test^="${g}:"]`)];
      const gb = box.querySelector(`[data-group="${g}"]`);
      gb.checked = all.every(c => c.checked); gb.indeterminate = !gb.checked && all.some(c => c.checked);
    });
    box.querySelectorAll('[data-rm]').forEach(b => b.onclick = e => {
      e.preventDefault();
      const p = dsPrefs(); p.custom = p.custom.filter(n => n !== b.dataset.rm); dsSavePrefs(p); dsRender('setup');
    });
  } else if (state === 'discover') {
    box.innerHTML = `${head}
      <h3>First, find your car's values</h3>
      <div class="modal-body"><p>This searches ${x.need.map(e => DS_ECUS[e].name).join(' and ')} once (about 1–3 minutes each) and remembers what answers, so later readings only take seconds.</p>
      <p class="hint">Leave the car as it is (READY, in P) until it finishes.</p></div>
      <div class="modal-actions"><button class="btn ghost" data-a="setup">Back</button><button class="btn primary" data-a="discover">Search now</button></div>`;
  } else if (state === 'scanning') {
    box.innerHTML = `${head}${prog}
      <h3 class="cap-title">${esc(x.label)}</h3>
      <div class="cap-rec"><i></i>Reading… ${Math.max(1, Math.ceil(x.eta))} s</div>
      <div class="cap-prog"><div style="width:${(x.i / x.n) * 100}%"></div></div>
      <p class="cap-do">${x.note}</p>`;
  } else if (state === 'countdown') {
    box.innerHTML = `${head}${prog}
      <h3 class="cap-title">${esc(x.label)}</h3>
      <div class="ds-count">${x.n}</div>
      <p class="cap-do">Press and hold it now. Keep holding until you hear two beeps.</p>`;
  } else if (state === 'unit') {
    const u = DS.units[DS.at], r = DS.res[DS.at];
    const where = `<div class="label">${u.g.name} · ${DS.at + 1} of ${DS.units.length}</div>`;
    if (u.kind === 'base') {
      box.innerHTML = `${head}${prog}${where}
        <h3 class="cap-title">Starting point</h3>
        <div class="modal-body"><p class="cap-do">${u.g.start}</p>
        <p class="hint">Every test in this group starts from here and comes back to here. It's read twice, so anything that changes by itself can be ignored.</p></div>
        <div class="modal-actions"><button class="btn ghost" data-a="back">Back</button><button class="btn primary" data-a="base">Read the starting point</button></div>
        <button class="btn ghost small cap-early" data-a="skipgroup">Skip ${u.g.name}</button>${early}`;
    } else if (DS.phase === 'on') {
      box.innerHTML = `${head}${prog}${where}
        <div class="ds-phase"><span class="on">1 · Turn it on</span><span>2 · Turn it off</span></div>
        <h3 class="cap-title">${esc(u.t.name)}</h3>
        <div class="modal-body"><p class="cap-do">${esc(u.t.on)}</p>
        <p class="ds-keep">Leave everything else exactly as it is.</p>
        <p class="hint">${u.t.hold ? 'Tap Read, then press and hold when the countdown starts. Two beeps mean you can let go.' : u.t.flash ? 'Do it, then tap Read. It flashes, so this one takes about three times as long.' : 'Do it, then tap Read.'}</p></div>
        <div class="modal-actions"><button class="btn ghost" data-a="back">Back</button><button class="btn ghost" data-a="skip">Skip</button><button class="btn primary" data-a="on">Read</button></div>${early}`;
    } else if (DS.phase === 'off') {
      box.innerHTML = `${head}${prog}${where}
        <div class="ds-phase"><span class="done">1 · Turn it on ✓</span><span class="on">2 · Turn it off</span></div>
        <h3 class="cap-title">${esc(u.t.name)}: now undo it</h3>
        <div class="modal-body"><p class="cap-do">${esc(u.t.off)}</p>
        <p class="ds-keep">The car should now be back at the starting point: ${u.g.start}</p>
        <p class="hint">${r.cand.length} value${r.cand.length === 1 ? '' : 's'} moved. This reading checks ${r.cand.length === 1 ? 'it goes' : 'they go'} back.</p></div>
        <div class="modal-actions"><button class="btn ghost" data-a="back">Redo</button><button class="btn primary" data-a="off">It's off: read</button></div>`;
    } else {
      const v = dsVerdict(DS.at, dsDrift());
      const row = c => `<div><code>${c.k}</code><span class="to">${c.bits.text}</span>${c.flashing ? '<em>flashing</em>' : ''}</div>`;
      box.innerHTML = `${head}${prog}${where}
        <h3 class="cap-title">${esc(u.t.name)}</h3>
        <div class="ds-verdict ${v.likely.length ? 'ok' : ''}">${v.likely.length
          ? `<b>${v.likely.length} value${v.likely.length === 1 ? '' : 's'} followed it</b><span class="mini">changed when on, went back when off</span>`
          : v.stayed.length ? `<b>Nothing went back</b><span class="mini">${v.stayed.length} value${v.stayed.length === 1 ? '' : 's'} changed but didn't return. Check it really is off, then tap Redo.</span>`
          : '<b>Nothing followed it</b><span class="mini">It may be in a computer that isn\'t ticked, or the car may not report it. If you weren\'t sure you did the step, tap Redo.</span>'}</div>
        ${v.likely.length ? `<div class="ds-diff">${v.likely.slice(0, 8).map(row).join('')}${v.likely.length > 8 ? `<span class="mini">+${v.likely.length - 8} more in the file</span>` : ''}</div>` : ''}
        ${v.stayed.length && v.likely.length ? `<p class="hint">${v.stayed.length} other value${v.stayed.length === 1 ? '' : 's'} changed and didn't go back. If the car really is back at the starting point, ${v.stayed.length === 1 ? 'it changes' : 'they change'} by ${v.stayed.length === 1 ? 'itself' : 'themselves'}.</p>` : ''}
        <div class="modal-actions"><button class="btn ghost" data-a="back">Redo</button><button class="btn primary" data-a="next">${DS.at + 1 < DS.units.length ? 'Next' : 'Show results'}</button></div>${DS.at + 1 < DS.units.length ? early : ''}`;
    }
  } else if (state === 'results') {
    const drift = dsDrift(), done = dsDone();
    const row = c => `<div><code>${c.k}</code><span class="to">${c.bits.text}</span>${c.flashing ? '<em>flashing</em>' : ''}</div>`;
    box.innerHTML = `${head}
      <h3>Results</h3>
      <p class="hint">Values that changed when the thing went on and went back when it went off, simplest first. The file has every reading.</p>
      <div class="ds-diff">${done.map(({ u, i }) => { const v = dsVerdict(i, drift); return `<div class="ds-res"><b>${u.g.name} → ${esc(u.t.name)}</b>${
        v.likely.length ? v.likely.slice(0, 6).map(row).join('') + (v.likely.length > 6 ? `<span class="mini">+${v.likely.length - 6} more in the file</span>` : '')
        : v.unchecked.length ? `<span class="mini">${v.unchecked.length} changed, off not checked</span>` : '<span class="mini">nothing followed it</span>'}</div>`; }).join('') || '<p class="hint">No tests were read.</p>'}</div>
      ${drift.size ? `<p class="hint">${drift.size} value${drift.size === 1 ? '' : 's'} drifted by ${drift.size === 1 ? 'itself' : 'themselves'} and ${drift.size === 1 ? 'was' : 'were'} left out.</p>` : ''}
      <div class="modal-actions"><button class="btn ghost" data-a="again">New scan</button><button class="btn primary" data-a="share">Share results</button></div>`;
  }

  box.querySelectorAll('[data-a]').forEach(b => b.onclick = () => {
    const a = b.dataset.a;
    if (a === 'close') return dsClose();
    if (a === 'start') return dsStart(box);
    if (a === 'own') return dsAddOwn(box);
    if (a === 'setup') return dsRender('setup');
    if (a === 'discover') return dsDiscover();
    if (a === 'base') return dsScanBase();
    if (a === 'on') return dsScanOn();
    if (a === 'off') return dsScanOff();
    if (a === 'back') return dsBack();
    if (a === 'skip' || a === 'next') return dsGo(DS.at + 1);
    if (a === 'skipgroup') return dsSkipGroup();
    if (a === 'finish') return dsRender('results');
    if (a === 'share') return dsShare();
    if (a === 'again') { DS.res = {}; DS.units = []; DS.at = 0; DS.exported = false; return dsRender('setup'); }
  });
}

/* demo: a few identifiers that follow the test being run, one that flashes, one that drifts and one that's noisy */
function demoDid(ecu, id) {
  const t = DS.demo?.on ? DS.demo.test : null, sec = Date.now() / 1000;
  const flash = (t === 'indl' || t === 'indr' || t === 'hazard') && Math.floor(sec * 2.6) % 2 === 0;
  const lights = (t === 'low' || t === 'high' || t === 'fog' || t === 'ffog') ? 1 : 0;
  const known = ecu === 'vcm' ? {
    0x1156: [t === 'r' || t === 'rev' ? 2 : t === 'n' ? 3 : t === 'd' ? 4 : t === 'b' ? 7 : 1],
    0x131a: [t === 'epedal' ? 4 : 0, 0x14],
    0x131b: [(t === 'eco' ? 0x10 : 0) | (t === 'ac' ? 0x01 : 0) | (t === 'rear' ? 0x20 : 0)],
    0x1323: [['fan', 'heat', 'ac', 'demist'].includes(t) ? 0x20 : 0],
    0x1262: [t === 'heat' ? 12 : 0],
    0x1240: [0, (t === 'brakel' || t === 'brk1' || t === 'brk2') ? 0x08 : 0, t === 'brk2' ? 0x90 : t === 'brk1' ? 0x20 : 0],
    0x115d: [0x62], 0x1203: [0x01, 0x1f], 0x1205: [0x02, 0xe1],
    0x1182: [0, Math.floor(sec * 3) & 0xff],                          // noisy: changes between any two readings
    0x1190: [Math.floor(sec / 25) & 0xff],                            // drifts: a slow timer
  } : ecu === 'meter' ? {
    0x0e0f: [0, 0, 0, lights, 0, 0, 0, 0, 0, 0],
    0x0e07: [t === 'high' ? 1 : 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    0x0e10: [(t === 'indl' || t === 'hazard') && flash ? 0x40 : 0, (t === 'indr' || t === 'hazard') && flash ? 0x40 : 0, t === 'fog' ? 0x06 : t === 'ffog' ? 0x04 : 0, t === 'side' || lights ? 0x01 : 0],
    0x0e2e: [0, t === 'acc1' ? 0x55 : t === 'acc2' ? 0xaa : 0],
    0x0e30: [(t === 'drv' ? 1 : 0) | (t === 'pas' ? 2 : 0) | (t === 'rearl' ? 4 : 0) | (t === 'boot' ? 8 : 0)],
  } : null;
  return known?.[id] || null;
}

document.getElementById('btnModeScan')?.addEventListener('click', dsOpen);
