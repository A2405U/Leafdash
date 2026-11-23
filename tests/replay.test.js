'use strict';
/* Drive replay (5.7b). Records 25 s of the Demo map route, then replays that recording: the road matches from the
   recorded map data with no map-server requests, 8× runs faster, Lose GPS drops the road, seeking and Next junction
   move through the drive, and ✕ returns the app to normal. */
const { open, sleep } = require('./helpers.js');
module.exports = async ({ browser, base, assert, note }) => {
  const { ctx, page, errors } = await open(browser, base, '', { settings: { dev: true } });
  let requests = 0; await ctx.route(/overpass/, r => { requests++; r.abort(); });
  // start recording first, then the demo, so the demo route's map data goes into the recording (as downloads do on a real drive)
  await page.evaluate(async () => { await recStart(); startDemo(); }); await sleep(25000); await page.evaluate(() => recStop()); await sleep(1500);
  await page.evaluate(() => { stopDemo(); setMode('off'); }); await sleep(500);
  await page.evaluate(async () => { const l = await recList(); await rpFromRecording(l[0].id); }); await sleep(3000);
  const st = () => page.evaluate(() => ({ on: RP.on, mode: S.mode, demoRoute: DRT.on, t: RP.t, matched: !!OSM.path, bar: !$('rpBar').classList.contains('hidden') }));
  let s = await st();
  assert.ok(s.on && s.mode === 'demo' && !s.demoRoute && s.bar && s.matched, `replay did not start properly: ${JSON.stringify(s)}`);
  await page.click('[data-rp=x8]'); const t0 = s.t; await sleep(1500);
  assert.ok((await st()).t - t0 > 8000, '8× is not faster');
  await page.evaluate(() => rpSeek(2000)); await page.click('[data-rp=x1]'); await page.click('[data-rp=lost]'); await sleep(10000);
  assert.ok(!(await st()).matched, 'losing GPS did not drop the road');
  await page.evaluate(() => rpSeek(8000)); await sleep(2500);
  await page.click('[data-rp=play]');                                   // pause, so any change in time is the jump
  const before = (await st()).t;
  await page.click('[data-rp=next]'); await sleep(800);
  const jumped = (await st()).t - before;
  const said = await page.evaluate(() => $('alertBar').classList.contains('hidden') ? '' : $('alertBar').textContent);
  assert.ok(jumped > 0 || /Nothing ahead|doesn't reach/.test(said), `Next junction did nothing (moved ${jumped} ms, said "${said}")`);
  await page.click('[data-rp=stop]'); await sleep(600);
  s = await page.evaluate(() => ({ mode: S.mode, fixture: OSM.fixture, on: RP.on }));
  assert.ok(s.mode === 'off' && !s.fixture && !s.on, 'stopping the replay did not return the app to normal');
  assert.strictEqual(requests, 0, 'the replay asked the map servers for data');
  assert.deepStrictEqual(errors, [], 'page errors');
  note(`road matched from the recording, 0 map requests; next junction moved ${Math.round(jumped / 1000)} s`);
  await ctx.close();
};
