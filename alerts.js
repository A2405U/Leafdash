'use strict';
/* =====================================================================
   Gentle alerts, spoken updates and night dimming
   ---------------------------------------------------------------------
   Alerts are a quiet one-line banner under the power strip, never a
   pop-up. Each one has to stay true for a while before it shows, and a
   dismissed alert stays away until the problem has cleared.

   Spoken updates use the phone's own voice (off by default).
   Night dimming darkens the whole screen while the headlights are on.

   Nothing here talks to the car: it only looks at values already read.
   ===================================================================== */

const PSI = 0.145038;
const TYRE_NAMES = ['Front left', 'Front right', 'Rear left', 'Rear right'];

/* Each rule returns the text to show, or null. `hold` = seconds it must stay true first. */
const ALERT_RULES = [
  { id: 'tyre', hold: 30, test(d) {
      const psi = (d.tyres || []).map(k => k > 60 ? k * PSI : null);          // sleeping sensors read 0
      const ok = psi.filter(x => x != null);
      if (ok.length < 3) return null;
      const lo = Math.min(...ok), i = psi.indexOf(lo), rest = ok.filter(x => x !== lo);
      const others = rest.length ? rest.reduce((a, b) => a + b, 0) / rest.length : lo;
      if (lo < 30) return `${TYRE_NAMES[i]} tyre is low: ${Math.round(lo)} psi`;
      if (others - lo >= 4) return `${TYRE_NAMES[i]} tyre is ${Math.round(others - lo)} psi below the others (${Math.round(lo)} psi)`;
      return null;
    } },
  { id: 'hot', hold: 30, test(d) {
      const t = (d.temps || []).filter(x => x != null);
      if (!t.length) return null;
      const hi = Math.max(...t);
      if (hi >= 50) return `Battery is very hot (${hi}°C): drive gently and avoid rapid charging`;
      if (hi >= 45) return `Battery is hot (${hi}°C): rapid charging will be slower`;
      return null;
    } },
  { id: 'cell', hold: 60, test(d) {
      const c = validCells(d);
      if (c.length < 90 || Math.abs(d.kw ?? 99) > 3 || d.soc == null || d.soc < 15 || d.soc > 95) return null;   // only judged at rest
      const lo = Math.min(...c), spread = Math.max(...c) - lo;
      if (spread < 50) return null;
      const sorted = [...c].sort((a, b) => a - b), mid = sorted[sorted.length >> 1];
      return mid - lo > spread / 2 ? `Cell ${d.cells.indexOf(lo) + 1} is ${mid - lo} mV below the rest. Worth keeping an eye on`
        : `Cells are ${spread} mV apart at rest, more than usual`;
    } },
  { id: 'aux', hold: 60, test(d) {
      const v = d.aux;
      if (v == null || v < 6) return null;
      if (d.ready === true && !isCharging(d) && v < 12.4) return `12 V battery isn't being topped up (${v.toFixed(1)} V with the car on)`;
      if (d.ready !== true && !isCharging(d) && v < 11.8) return `12 V battery is low: ${v.toFixed(1)} V`;
      return null;
    } },
];

const AL = { state: {}, shown: null, demoUntil: 0 };

function alertsTick() {
  const bar = $('alertBar');
  if (!bar) return;
  const now = Date.now(), live = (S.mode === 'on' || S.mode === 'demo') && now - S.lastUpdate < 8000;
  const active = [];
  if (live && SET.alerts !== false) {
    for (const r of ALERT_RULES) {
      const st = AL.state[r.id] ||= { since: 0, off: false, said: false };
      let text = null;
      try { text = r.test(S.data); } catch {}
      if (!text) { st.since = 0; st.off = false; st.said = false; continue; }     // cleared: a dismissal is forgotten
      if (!st.since) st.since = now;
      if (now - st.since < (S.mode === 'demo' ? 3 : r.hold) * 1000 || st.off) continue;   // quicker in Demo so it can be tried
      active.push({ id: r.id, text });
      if (!st.said) { st.said = true; say(text); }
    }
  }
  // with no alert showing, the same line can carry one quiet notice (for example "a report is ready")
  const top = active[0] || (AL.notice ? { id: 'notice', text: AL.notice.text } : null), was = AL.shown;
  AL.shown = top ? top.id : null;
  bar.classList.toggle('hidden', !top);
  bar.classList.toggle('notice', AL.shown === 'notice');
  if (top) {
    bar.querySelector('span').textContent = top.text;
    bar.querySelector('em').textContent = AL.shown === 'notice' ? 'View' : active.length > 1 ? `+${active.length - 1} more` : '';
  }
  if (was !== AL.shown && typeof fitScene === 'function') fitScene();
}
/** Show one quiet notice in the alert line: { text, action (tap to open), dismiss (✕) }. Pass null to clear it. */
function alertNotice(n) { AL.notice = n; alertsTick(); }
setInterval(alertsTick, 2000);

/* ---------------- spoken updates ---------------- */
function say(text, force = false) {
  if (!force && !SET.voice) return;
  const sy = window.speechSynthesis;
  if (!sy || typeof SpeechSynthesisUtterance === 'undefined') return;
  try {
    const u = new SpeechSynthesisUtterance(String(text).replace(/°C/g, ' degrees').replace(/\bmV\b/g, 'millivolts').replace(/\bpsi\b/g, 'P S I').replace(/(\d) V\b/g, '$1 volts'));
    u.lang = 'en-GB'; u.rate = 1; u.volume = 1;
    sy.speak(u);
  } catch {}
}

const VO = { soc: null, mode: 'off', chargeSoc: null };
const SOC_MARKS = [50, 30, 20, 15, 10, 5];
function voiceTick() {
  const d = S.data;
  if (S.mode !== 'on' && S.mode !== 'demo') { VO.soc = null; return; }
  if (d.soc == null) return;
  if (VO.soc != null && !isCharging(d)) {
    // battery milestones on the way down, with the range if there's a figure for it
    const hit = SOC_MARKS.find(m => VO.soc > m && d.soc <= m);
    if (hit) {
      const r = dist(rangeKm(d).km);
      say(`Battery ${hit} percent.` + (r != null ? ` About ${Math.round(r)} ${isMph() ? 'miles' : 'kilometres'} left.` : ''));
    }
  }
  if (isCharging(d) && VO.soc != null) {
    for (const m of [80, 100]) if (VO.soc < m && d.soc >= m) say(m === 100 ? 'Battery full.' : 'Battery at 80 percent.');
  }
  VO.soc = d.soc;
}
setInterval(voiceTick, 3000);
LeafDash.on('charge', e => say(e.on ? `Charging started${e.soc != null ? ` at ${Math.round(e.soc)} percent` : ''}.` : `Charging stopped${e.soc != null ? ` at ${Math.round(e.soc)} percent` : ''}.`));
LeafDash.on('mode', m => {
  if (VO.mode === 'on' && m === 'off') say('Adapter disconnected.');
  if (m === 'on' && VO.mode !== 'on') say('Connected to the car.');
  VO.mode = m;
});

/* ---------------- night dimming ---------------- */
const NIGHT = { on: false, since: 0, want: false };
function nightTick() {
  let want = false;
  if (SET.nightDim !== 'off') {
    if (S.mode === 'on') want = lightBit('low') === true || lightBit('high') === true;
    // in Demo the lights cycle by themselves, so only follow them when they're set by hand in the test panel
    else if (S.mode === 'demo' && typeof DP !== 'undefined' && DP.manual) want = DP.lights.low || DP.lights.high;
  }
  const now = Date.now();
  if (want !== NIGHT.want) { NIGHT.want = want; NIGHT.since = now; }
  // wait a few seconds so a flash of the headlights or a short tunnel doesn't flicker the screen
  if (NIGHT.on !== want && now - NIGHT.since > (want ? 3000 : 6000)) {
    NIGHT.on = want;
    document.body.classList.toggle('night', want);
  }
}
setInterval(nightTick, 1000);

/* ---------------- speed limit nudge (called by the road overlay) ---------------- */
const NUDGE = { over: false };
/** limit = { v, mph } from the map. Marks the sign when you're more than ~3 mph over (and clears below ~1 mph over). */
function limitNudge(limit) {
  const sign = $('roadSign'), spd = $('spd');
  let over = false;
  const sp = currentSpeed();
  if (SET.limitNudge !== false && limit && sp.mps != null) {
    const lim = limit.v * (limit.mph ? 0.44704 : 0.27778);
    over = sp.mps > lim + (NUDGE.over ? 0.45 : 1.34);
  }
  NUDGE.over = over;
  sign?.classList.toggle('over', over);
  spd?.classList.toggle('over', over);
}

$('alertBar')?.querySelector('button')?.addEventListener('click', e => {
  e.stopPropagation();
  if (AL.shown === 'notice') { const n = AL.notice; AL.notice = null; n?.dismiss?.(); }
  else if (AL.shown && AL.state[AL.shown]) AL.state[AL.shown].off = true;
  alertsTick();
});
$('alertBar')?.addEventListener('click', () => { if (AL.shown === 'notice') AL.notice?.action?.(); });
