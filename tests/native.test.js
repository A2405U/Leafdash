'use strict';
/* The Android app. Its WebView has no Web Bluetooth, so android/app/src/main/assets/leafnative.js builds one from
   the app's native bridge (NativeBridge.java). This runs the real shim on a stand-in bridge that behaves like the
   Java one (answers arrive later through window.__leafNativeCb, commands are held until the carriage return and
   checked with ReadOnlyGuard.java's own list), backed by the fake adapter. It checks:
     • the two read-only lists (app.js and ReadOnlyGuard.java) are the same
     • connecting, live values, a dropped link reconnecting, and connecting by itself when the app opens
     • a write command sent straight to the characteristic (past isReadOnly) is still stopped by the native guard
     • screen kept on, spoken updates and saving a backup file go to the phone
     • the fast Bluetooth link is asked for on connect, and again when the link slows down (issue #23) */
const fs = require('fs'), path = require('path');
const { MOCK } = require('./mock-adapter.js');
const { sleep, until } = require('./helpers.js');
const ROOT = path.resolve(__dirname, '..');

function javaGuard() {
  const src = fs.readFileSync(path.join(ROOT, 'android/app/src/main/java/com/a2405/leafdash/ReadOnlyGuard.java'), 'utf8');
  const at = [...src.slice(src.indexOf('AT_ALLOWED'), src.indexOf('};')).matchAll(/p\("([^"]+)"\)/g)].map(m => m[1]);
  const other = [...src.matchAll(/(?:GROUP_READ|DID_READ) = p\("([^"]+)"\)/g)].map(m => m[1]);
  return { at, other };
}
function jsGuard() {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const block = src.slice(src.indexOf('const AT_ALLOWED'), src.indexOf('];', src.indexOf('const AT_ALLOWED')));
  const at = [...block.matchAll(/\/\^([^/]+)\$\//g)].map(m => m[1]);
  const fn = src.slice(src.indexOf('function isReadOnly'), src.indexOf('\n}', src.indexOf('function isReadOnly')));
  const other = [...fn.split('\n').pop().matchAll(/\/\^([^/]+)\$\//g)].map(m => m[1]);
  return { at, other };
}

function FAKE_NATIVE(guard) {
  const mock = navigator.bluetooth;
  const SVC = '0000ffe0-0000-1000-8000-00805f9b34fb', CH = '0000ffe1-0000-1000-8000-00805f9b34fb';
  const allowed = raw => {
    const c = raw.toUpperCase().replace(/\s+/g, '');
    if (!c) return false;
    if (c.startsWith('AT')) return guard.at.some(p => new RegExp('^' + p + '$').test(c));
    return guard.other.some(p => new RegExp('^' + p + '$').test(c));
  };
  const N = window.__native = { awake: false, spoken: [], saved: [], blocked: [], connects: 0, fastAsked: 0 };
  const reply = (id, ok, data = '') => setTimeout(() => window.__leafNativeCb(id, ok, data), 5);
  const b64 = bytes => { let s = ''; for (const x of bytes) s += String.fromCharCode(x); return btoa(s); };
  let ch = null, held = '';
  window.LeafNative = {
    bleScan: id => reply(id, true, JSON.stringify({ id: 'AA:BB:CC:00:11:22', name: 'OBDBLE' })),
    bleRemembered: id => reply(id, true, JSON.stringify(localStorage.getItem('__nativeRemembers') ? [{ id: 'AA:BB:CC:00:11:22', name: 'OBDBLE' }] : [])),
    bleConnect: async (id) => {
      N.connects++;
      const svc = await (await (await mock.requestDevice()).gatt.connect()).getPrimaryService(SVC);
      ch = (await svc.getCharacteristics())[0];
      ch.addEventListener('characteristicvaluechanged', e => window.__leafNativeNotify(SVC, CH, b64(new Uint8Array(e.target.value.buffer))));
      localStorage.setItem('__nativeRemembers', '1');
      reply(id, true, JSON.stringify({ fastLink: true, services: [{ uuid: SVC, chars: [{ uuid: CH, props: { read: false, write: true, writeWithoutResponse: true, notify: true, indicate: false } }] }] }));
    },
    bleNotify: id => reply(id, true),
    bleWrite: (id, s, c, data) => {
      held += atob(data);
      let i;
      while ((i = held.indexOf('\r')) >= 0) {
        const cmd = held.slice(0, i); held = held.slice(i + 1);
        if (!allowed(cmd)) { held = ''; N.blocked.push(cmd.trim()); return reply(id, false, 'Blocked (not read-only): ' + cmd.trim()); }
        ch.writeValue(new TextEncoder().encode(cmd + '\r'));
      }
      reply(id, true);
    },
    bleDisconnect: () => setTimeout(() => window.__leafNativeDisconnected(), 5),
    bleFastLink: () => { N.fastAsked++; return true; },
    keepAwake: on => { N.awake = on; },
    gpsStart: () => { N.gps = true; },
    gpsStop: () => { N.gps = false; },
    speak: text => N.spoken.push(text),
    stopSpeaking: () => {},
    share: (id, name) => { N.saved.push({ name, how: 'share' }); reply(id, true); },
    save: (id, name, mime, data) => { N.saved.push({ name, mime, bytes: atob(data).length, how: 'save' }); reply(id, true); },
  };
}

module.exports = async ({ browser, base, assert, note }) => {
  // the two read-only lists must match
  const j = javaGuard(), w = jsGuard();
  assert.ok(j.at.length > 15 && w.at.length > 15, `read the lists: ${j.at.length} / ${w.at.length}`);
  assert.deepStrictEqual(j.at, w.at, 'AT commands allowed differ between app.js and ReadOnlyGuard.java');
  assert.deepStrictEqual(j.other, w.other, 'read services allowed differ between app.js and ReadOnlyGuard.java');

  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
  await ctx.addInitScript(MOCK);
  await ctx.addInitScript(FAKE_NATIVE, j);
  await ctx.addInitScript({ content: fs.readFileSync(path.join(ROOT, 'android/app/src/main/assets/leafnative.js'), 'utf8') });
  await ctx.addInitScript(() => { window.__lat = 30; });
  await ctx.route(/overpass|iternio|openstreetmap\.de/, r => r.abort());
  let page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  await sleep(600);

  const start = await page.evaluate(() => ({ noBt: !$('noBt').classList.contains('hidden'), disabled: $('btnConnect').disabled }));
  assert.ok(!start.noBt && !start.disabled, `the app thought there was no Bluetooth: ${JSON.stringify(start)}`);

  await page.click('#btnConnect');
  await page.waitForFunction(() => S.mode === 'on', null, { timeout: 15000 });
  await page.evaluate(() => document.querySelectorAll('.modal-wrap').forEach(x => x.remove()));
  const live = await until(page, () => S.data.soc != null && S.data.gear != null && window.__native.awake && { soc: S.data.soc, gear: S.data.gear });
  assert.ok(live, 'no live values (or screen not kept on) through the native bridge');

  // past the web app's own check, straight to the characteristic: the native guard must stop it
  const direct = await page.evaluate(async () => {
    const sentBefore = window.__sent.length;
    let err = '';
    try { await S.elm.tx.writeValue(new TextEncoder().encode('2E123400\r')); } catch (e) { err = e.message; }
    await new Promise(r => setTimeout(r, 300));
    return { err, reached: window.__sent.slice(sentBefore).includes('2E123400'), blocked: window.__native.blocked };
  });
  assert.ok(/Blocked/.test(direct.err) && !direct.reached && direct.blocked.includes('2E123400'), `native guard: ${JSON.stringify(direct)}`);

  // the fast link: asked for on connect (logged), and again once the link slows down
  assert.ok(await page.evaluate(() => logLines.some(l => /Asked the phone for a fast Bluetooth link/.test(l))), 'fast link not asked for on connect');
  await page.evaluate(() => { window.__lat = 250; });
  const again = await until(page, () => window.__native.fastAsked > 0 && logLines.some(l => /asking the phone for a fast link again/.test(l)), 20000);
  assert.ok(again, 'fast link not asked for again when the link slowed down');
  await page.evaluate(() => { window.__lat = 30; });

  // location from Android's GPS (keeps going in the background): the page's watch starts it, fixes reach the page
  const fix = await page.evaluate(async () => {
    const got = []; LeafDash.on('gps', g => got.push(g));
    const started = await new Promise(r => { const t0 = Date.now(); (function w() { if (window.__native.gps || Date.now() - t0 > 4000) r(window.__native.gps); else setTimeout(w, 100); })(); });
    window.__leafNativeFix(51.5001, -0.1201, 4, 20, 90, 12.5, Date.now());
    await new Promise(r => setTimeout(r, 100));
    return { started, got: got.filter(g => !g.fake).map(g => [g.lat, g.lon, g.spd]) };
  });
  assert.ok(fix.started && fix.got.some(g => g[0] === 51.5001 && g[2] === 12.5), `GPS through the app: ${JSON.stringify(fix)}`);

  // repeating jobs still run with the app in the background, from the app's nudge (timers are held back there)
  const jobs = await page.evaluate(() => {
    let n = 0; const id = setInterval(() => n++, 60000);
    window.__leafNativeTick(); const early = n;                          // not due yet
    const now = Date.now; Date.now = () => now() + 61000;
    window.__leafNativeTick(); window.__leafNativeTick(); const due = n;   // due: runs once, not twice
    Date.now = now; clearInterval(id);
    return { early, due };
  });
  assert.deepStrictEqual(jobs, { early: 0, due: 1 }, `background nudge ran the jobs wrongly: ${JSON.stringify(jobs)}`);

  // spoken update and a backup file
  await page.evaluate(() => { say('Battery at 50%', true); bkSave(false); });
  const files = await until(page, () => window.__native.saved.length && window.__native);
  assert.ok(files.spoken.some(t => /Battery at 50/.test(t)), 'speech did not reach the phone');
  assert.ok(files.saved.some(f => f.how === 'save' && /^leafdash-backup-.*\.json$/.test(f.name) && f.bytes > 100), `backup not saved: ${JSON.stringify(files.saved)}`);

  // the link drops: the app should reconnect by itself
  await page.evaluate(() => window.__leafNativeDisconnected());
  const back = await until(page, () => S.mode === 'on' && window.__native.connects >= 2, 20000);
  assert.ok(back, 'did not reconnect after the link dropped');

  // close and open the app: it should connect to the remembered adapter without a tap
  await page.close();
  page = await ctx.newPage();
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base);
  const auto = await until(page, () => S.mode === 'on' || S.mode === 'busy', 15000);
  assert.ok(auto, 'did not connect by itself when the app opened');

  assert.deepStrictEqual(errors, [], 'page errors');
  note(`read-only lists match (${j.at.length} AT + ${j.other.length}); connected, values live, write refused by the native guard; fast link asked for on connect and again when slow; GPS from the app; repeating jobs run from the app's nudge in the background; voice, backup file, reconnect and auto-connect work`);
  await ctx.close();
};
