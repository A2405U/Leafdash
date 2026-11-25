'use strict';
/* Demo mode's test panel: Route (speed, jump to each feature, lose GPS), Simulate (slow link, adapter drop-out,
   alerts, driving lock, "Before you drive"), and the old Car tab still there. */
const { open, sleep, until } = require('./helpers.js');
module.exports = async ({ browser, base, assert, note }) => {
  const { page, ctx, errors } = await open(browser, base, '?demo', { settings: { dev: true } });
  await sleep(1500);
  await page.click('#demoFab'); await sleep(300);
  const pills = () => page.evaluate(() => [...$('roadNext').querySelectorAll('.rn-row')].map(r => r.textContent).join(' | '));
  // Route: jump to features
  const seen = {};
  for (const [k, want] of [['redcam', /Red-light camera \+ lights/], ['speedcam', /Speed camera/], ['zebra', /Zebra/], ['rbt', /Roundabout/], ['mini', /Mini roundabout/]]) {
    await page.click(`[data-jump=${k}]`);
    await until(page, re => new RegExp(re).test([...$('roadNext').querySelectorAll('.rn-row')].map(r => r.textContent).join(' | ')), 8000, want.source);
    seen[k] = await pills();
    assert.ok(want.test(seen[k]), `jump to ${k}: pill shows "${seen[k]}"`);
  }
  await page.click('[data-jump=dual]');
  assert.ok(await until(page, () => /A40/.test($('roadName').textContent)), 'jump to the dual carriageway did not get there');
  // demo speed 4×, measured on the open dual carriageway (1× for 2 s, then 4× for 2 s)
  await sleep(2000);
  const a0 = await page.evaluate(() => DRT.s); await sleep(2000); const a1 = await page.evaluate(() => DRT.s);
  await page.click('[data-rate="4"]'); const b0 = await page.evaluate(() => DRT.s); await sleep(2000); const b1 = await page.evaluate(() => DRT.s);
  await page.click('[data-rate="1"]');
  assert.ok((b1 - b0) > 3 * (a1 - a0), `4× wasn't about four times faster (${(b1 - b0).toFixed(0)} m vs ${(a1 - a0).toFixed(0)} m in 2 s)`);
  // lose GPS
  await page.click('[data-a=lose]');
  assert.ok(await until(page, () => !OSM.path, 13000), 'losing GPS did not drop the road');
  // Simulate tab
  await page.click('[data-tab=sim]'); await sleep(200);
  await page.click('[data-t=slow]');
  assert.ok(await until(page, () => !$('slowLink').classList.contains('hidden')), 'Slow link badge not shown');
  await page.click('[data-t=aux]');
  assert.ok(await until(page, () => /12 V battery/.test($('alertBar').textContent), 10000), '12 V alert not shown');
  await page.click('[data-a=drop]'); await sleep(1000);
  const during = await page.evaluate(() => ({ st: $('status').textContent.trim(), at: S.lastUpdate }));
  await sleep(3000); const still = await page.evaluate(() => S.lastUpdate);
  assert.ok(/Reconnecting/.test(during.st) && still === during.at, 'drop-out did not stop the data or show Reconnecting');
  await sleep(5500);
  assert.ok(/Demo/.test(await page.evaluate(() => $('status').textContent)), 'did not come back after the drop-out');
  await page.click('[data-tab=route]'); await page.click('[data-jump=dual]'); await page.click('[data-tab=sim]');
  await page.click('[data-t=lock]');
  assert.ok(await until(page, () => SAFE.locked, 10000), 'Driving lock not tried in Demo while moving');
  await page.click('#btnSettings', { force: true }); await sleep(300);
  assert.ok(!(await page.evaluate(() => !!document.querySelector('.modal-wrap [data-sec]'))), 'Settings opened while the demo lock was on');
  await page.click('[data-t=lock]'); await sleep(4000);
  await page.click('[data-a=warn]'); await sleep(300);
  assert.ok(await page.evaluate(() => /Before you drive/.test(document.querySelector('.modal-wrap h3')?.textContent || '')), '"Before you drive" did not show');
  await page.evaluate(() => document.querySelectorAll('.modal-wrap').forEach(w => w.remove()));
  // Car tab is still there
  await page.click('[data-tab=car]'); await sleep(200);
  assert.ok(await page.evaluate(() => !!document.querySelector('[data-a=manual]') && !!document.querySelector('[data-r=speed]')), 'Car tab missing its controls');
  // charging screen: each charger type draws its own cable (3-pin, wallbox, rapid) without errors
  for (const n of [1, 2, 3]) { await page.evaluate(n => { DP.manual = true; DP.charging = true; S.demoCharging = true; DP.chargeType = n; showView('drive'); }, n); await sleep(1500); }
  assert.ok(await page.evaluate(() => CH.active), 'the charging screen did not show');
  // custom charging power: a rapid charger at 18 kW
  await page.evaluate(() => { DP.open = true; DP.tab = 'car'; dpRender(); });
  await page.click('[data-a=ckw]'); await page.evaluate(() => { const r = document.querySelector('[data-ckw]'); r.value = 18; r.dispatchEvent(new Event('input')); });
  const ck = await until(page, () => Math.abs(chargeKw(S.data) - 18) < 0.5 && chargeKw(S.data));
  assert.ok(ck, `custom charging power not applied (${await page.evaluate(() => chargeKw(S.data))} kW)`);
  assert.ok(await page.evaluate(() => S.data.chargeMode === 3), 'custom power changed the charger type');
  await page.evaluate(() => { DP.charging = false; S.demoCharging = false; DP.manual = false; });
  // leaving demo clears the simulations
  await page.evaluate(() => { stopDemo(); setMode('off'); }); await sleep(3500);
  assert.ok(await page.evaluate(() => $('slowLink').classList.contains('hidden') && !DP.sim.slow && !SAFE.locked), 'simulations stayed on after leaving Demo');
  assert.deepStrictEqual(errors, [], 'page errors');
  note(`jumps: ${Object.values(seen).join(' / ')}; 4×, GPS loss, slow link, 12 V, drop-out, lock, note, car tab`);
  await ctx.close();
};
