'use strict';
/* The Android Auto car screen (index.html?car) and its link to the phone (carscreen.js).
   Car page: "Open Leaf Dash on your phone" until the phone speaks; its own Demo when the phone is in Demo; the
   phone's live values when it's connected; the ☰ menu without Debug; Android Auto's insets; never saves anything;
   back to the message when the phone goes quiet.
   Phone page: with a car screen showing, sends the car's values (cells included, for the Cells tab), its mode and
   a heartbeat. */
const { MOCK } = require('./mock-adapter.js');
const { sleep, until } = require('./helpers.js');

module.exports = async ({ browser, base, assert, note }) => {
  /* ---- the car page ---- */
  const ctx = await browser.newContext({ viewport: { width: 800, height: 480 } });
  await ctx.addInitScript(() => localStorage.setItem('leafdash.settings', JSON.stringify({ units: 'mph', voice: true, dev: true })));
  await ctx.route(/overpass/, r => r.abort());
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '?car');
  await sleep(600);
  const start = await page.evaluate(() => {
    __leafCarArea(0, 0, 0, 66);
    return { car: document.body.classList.contains('car-screen'), msg: $('carMsg').textContent, header: getComputedStyle(document.querySelector('.top')).display, mode: S.mode };
  });
  assert.ok(start.car && /Open Leaf Dash on your phone/.test(start.msg) && start.header === 'none' && start.mode === 'off', `car page at start: ${JSON.stringify(start)}`);

  // phone in Demo → the car screen runs its own Demo
  await page.evaluate(() => { window.__hb = 'demo'; window.__hbt = setInterval(() => __leafFromPhone(JSON.stringify({ k: 'hb', mode: __hb })), 500); });
  const demo = await until(page, () => S.mode === 'demo' && $('carMsg').classList.contains('hidden') && !S.mirror && S.data.speed != null && true, 6000);
  assert.ok(demo, 'the car screen did not run Demo when the phone was in Demo');

  // phone live → the car screen shows the phone's values, labelled as the car's
  await page.evaluate(() => { __hb = 'on'; __leafFromPhone(JSON.stringify({ k: 'd', mode: 'on', d: { speed: 48.3, gear: 'D', kw: 21.5, soc: 64.2 } })); });
  const live = await until(page, () => S.mirror && S.mode === 'demo' && $('spd').textContent === '30' && { spd: $('spd').textContent, src: $('spdSrc').textContent, kw: $('kw').textContent, drt: typeof DRT !== 'undefined' && DRT.on }, 4000);
  assert.ok(live && !/demo/.test(live.src) && /^2[12]$/.test(live.kw) && !live.drt, `live on the car screen: ${JSON.stringify(live) || await page.evaluate(() => $('spd').textContent)}`);
  await sleep(1200);                                           // the car's own demo generator must not overwrite it
  assert.strictEqual(await page.evaluate(() => $('spd').textContent), '30', 'the phone\'s speed was overwritten');

  // ☰: the tabs, without Debug; Android Auto's bottom bar kept clear
  await page.click('#carMenuBtn');
  const menu = await page.evaluate(() => ({ open: document.body.classList.contains('car-menu'), tabs: [...document.querySelectorAll('.tabs button')].filter(b => getComputedStyle(b).display !== 'none').map(b => b.textContent),
    sceneBottom: $('drive').getBoundingClientRect().bottom }));
  assert.ok(menu.open && menu.tabs.join() === 'Drive,Dash,Energy,Cells', `menu: ${JSON.stringify(menu)}`);
  assert.ok(menu.sceneBottom <= 480 - 66 + 1, `the drive scene runs under Android Auto's bar (bottom ${menu.sceneBottom})`);
  await page.click('.tabs button[data-view="dash"]');
  assert.ok(await page.evaluate(() => S.view === 'dash' && !document.body.classList.contains('car-menu')), 'a tab in the menu did not switch the view and close the menu');
  // ▲ ▼ page through a tab taller than the screen (Android Auto passes taps, not swipes)
  const pg = await until(page, () => !document.querySelector('.car-pager').classList.contains('hidden') && document.querySelector('.car-pager [data-p="-1"]').disabled && true, 3000);
  assert.ok(pg, 'no page buttons on the Dash tab');
  await page.click('.car-pager [data-p="1"]');
  assert.ok(await until(page, () => scrollY > 100, 3000), 'the ▼ button did not scroll down');
  await page.evaluate(() => showView('drive'));
  assert.ok(await until(page, () => document.querySelector('.car-pager').classList.contains('hidden'), 2000), 'page buttons showing on the Drive tab');

  // nothing saved, no voice of its own
  const kept = await page.evaluate(() => { try { saveSettings(); } catch {} return { voice: JSON.parse(localStorage.getItem('leafdash.settings')).voice, restoring: window.LD_RESTORING }; });
  assert.ok(kept.voice === true && kept.restoring === true, `the car page changed saved settings: ${JSON.stringify(kept)}`);

  // the phone goes quiet → back to the message
  await page.evaluate(() => clearInterval(__hbt));
  const quiet = await until(page, () => !$('carMsg').classList.contains('hidden') && /Open Leaf Dash/.test($('carMsg').textContent) && S.mode === 'off', 8000);
  assert.ok(quiet, 'no message after the phone went quiet');
  await ctx.close();

  /* ---- the phone page sending ---- */
  const pctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
  await pctx.addInitScript(MOCK);
  await pctx.addInitScript(() => { window.__lat = 15; window.__sentCar = []; window.LeafNative = { carOn: () => true, toCar: s => window.__sentCar.push(JSON.parse(s)) }; });
  const ph = await pctx.newPage();
  ph.on('pageerror', e => errors.push('phone: ' + e.message));
  await ph.goto(base);
  await sleep(500);
  await ph.click('#btnConnect');
  await ph.waitForFunction(() => S.mode === 'on', null, { timeout: 15000 });
  const sent = await until(ph, () => __sentCar.some(m => m.k === 'd' && m.d.soc != null) && __sentCar.some(m => m.k === 'hb') && __sentCar, 8000);
  assert.ok(sent, 'the phone sent nothing to the car screen');
  const kinds = [...new Set(sent.map(m => m.k))].sort();
  assert.ok(kinds.includes('mode') && kinds.includes('d') && kinds.includes('hb'), `kinds sent: ${kinds}`);
  const cellsSent = await until(ph, () => __sentCar.some(m => m.k === 'd' && Array.isArray(m.d.cells) && m.d.cells.length === 96), 15000);
  assert.ok(cellsSent, 'the cells were not sent to the car screen (its Cells tab needs them)');
  assert.ok(sent.filter(m => m.k === 'd').every(m => m.mode === 'on'), 'data messages without the live mode');
  await pctx.close();

  assert.deepStrictEqual(errors, [], 'page errors');
  note(`car page: message → own Demo → phone's live values (30 mph, no demo label) → message again; menu without Debug; ▲ ▼ page buttons; clear of AA's bar; saves nothing. ▲ ▼ page the Dash tab. Phone sends ${sent.length} messages (${kinds}) and the cells`);
};
