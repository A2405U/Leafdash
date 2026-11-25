'use strict';
/* Remembered map areas and retry (5.6b), with fake map servers: busy → retry after 10 s then 20 s; servers back → the
   road loads and is remembered; reopened with the servers busy → the road loads from the phone with no request. */
const { MOCK } = require('./mock-adapter.js');
const { sleep } = require('./helpers.js');
const way = { type: 'way', id: 1, nodes: Array.from({ length: 11 }, (_, i) => 100 + i), tags: { highway: 'residential', name: 'Test Road', maxspeed: '30 mph' },
  geometry: Array.from({ length: 11 }, (_, i) => ({ lat: 51.4955 + i * 0.001, lon: -0.12 })) };
module.exports = async ({ browser, base, assert, note }) => {
  const ctx = await browser.newContext({ permissions: ['geolocation'], geolocation: { latitude: 51.5, longitude: -0.12, accuracy: 5 } });
  await ctx.addInitScript(MOCK);
  await ctx.addInitScript(() => { window.__lat = 15; localStorage.setItem('leafdash.settings', JSON.stringify({ realRoad: true })); });
  let mode = 'busy', hits = 0;
  await ctx.route(/overpass/, r => { hits++; return mode === 'busy' ? r.fulfill({ status: 502, body: 'busy' }) : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ elements: [way] }) }); });
  const page = await ctx.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  let n = 0; const tick = setInterval(() => ctx.setGeolocation({ latitude: 51.5 + (n++ % 2) * 0.00001, longitude: -0.12, accuracy: 5 }).catch(() => {}), 1000);
  const st = () => page.evaluate(async () => ({ fails: OSM.fails || 0, matched: !!OSM.path, saved: await osmcCount() }));
  const go = async () => { await page.goto(base); await page.evaluate(() => { window.__osmc = []; LeafDash.on('osmc', e => __osmc.push(e)); }); await sleep(500); await page.click('#btnConnect'); await sleep(4000); await page.evaluate(() => document.querySelectorAll('.modal-wrap').forEach(w => w.remove())); };
  try {
    await go();
    assert.strictEqual((await st()).fails, 1, 'first failure not counted');
    await sleep(11000);
    assert.strictEqual((await st()).fails, 2, 'no retry after about 10 s');
    mode = 'ok'; await sleep(22000);
    let s = await st();
    assert.ok(s.matched && s.saved === 1 && s.fails === 0, 'road not loaded or not remembered when the servers came back');
    assert.ok(await page.evaluate(() => __osmc.some(e => e.op === 'saved')), 'no "saved" event for the drive recorder');
    mode = 'busy'; const before = hits;
    await go(); await sleep(1000);
    s = await st();
    assert.ok(s.matched && hits === before, `reopening did not load the road from the phone (requests: ${hits - before})`);
    assert.ok(await page.evaluate(() => __osmc.some(e => e.op === 'lookup' && e.hit && e.loaded > 0)), 'no "lookup" event showing the area loaded from the phone');
    await page.click('#btnSettings'); await page.evaluate(() => { document.querySelector('[data-sec="drive"]').open = true; }); await sleep(400);
    await page.click('[data-osmc-clear]'); await sleep(300);
    assert.strictEqual(await page.evaluate(() => osmcCount()), 0, '"Forget saved map areas" did not clear them');
    assert.deepStrictEqual(errors, [], 'page errors');
    note('retry 10 s → 20 s; remembered; reloaded from the phone with 0 requests; forget clears');
  } finally { clearInterval(tick); await ctx.close(); }
};
