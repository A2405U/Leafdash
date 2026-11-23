'use strict';
/* The "Before you drive" note and the lock while moving (5.2b). */
const { open, sleep } = require('./helpers.js');
module.exports = async ({ browser, base, assert, note }) => {
  const st = p => p.evaluate(() => ({ locked: SAFE.locked, pending: SAFE.pending, view: S.view, settingsOpen: !!document.querySelector('.modal-wrap [data-sec]'),
    warn: !!document.querySelector('.modal-wrap h3')?.textContent.includes('Before you drive'), alert: $('alertBar').classList.contains('hidden') ? '' : $('alertBar').textContent }));
  // parked: the note shows; moving: Settings closes, Debug goes back to Drive, taps are refused with a reason
  let { ctx, page, errors } = await open(browser, base, '', { mock: true, lat: 15, settings: { dev: true } });
  await page.click('#btnConnect'); await sleep(3500);
  assert.ok((await st(page)).warn, 'no "Before you drive" note when connecting while parked');
  await page.click('.modal-wrap [data-x]');
  await page.evaluate(() => showView('debug')); await page.click('#btnSettings'); await sleep(300);
  await page.evaluate(() => { window.__spd = 500; }); await sleep(4000);
  let s = await st(page);
  assert.ok(s.locked && !s.settingsOpen && s.view === 'drive', 'moving did not lock, close Settings and leave Debug');
  for (const sel of ['#btnSettings', '#btnDriveSettings', '.tabs button[data-view="debug"]']) { await page.click(sel, { force: true }); await sleep(300); }
  s = await st(page);
  assert.ok(!s.settingsOpen && s.view === 'drive' && /locked while the car is moving/.test(s.alert), 'a tap got through while moving');
  await page.evaluate(() => { window.__spd = 0; }); await sleep(5000);
  await page.click('#btnSettings'); await sleep(300);
  assert.ok((await st(page)).settingsOpen, 'Settings did not open again after stopping');
  assert.deepStrictEqual(errors, [], 'page errors');
  await ctx.close();
  // connecting while already moving: the note waits until the car stops
  ({ ctx, page } = await open(browser, base, '', { mock: true, lat: 15, spd: 500 }));
  await page.click('#btnConnect'); await sleep(4000);
  s = await st(page);
  assert.ok(s.pending && !s.warn, 'the note showed while moving');
  await page.evaluate(() => { window.__spd = 0; }); await sleep(5000);
  assert.ok((await st(page)).warn, 'the note did not show after stopping');
  await ctx.close();
  // Demo mode is never locked
  ({ ctx, page } = await open(browser, base, '?demo'));
  await sleep(6000);
  assert.ok(!(await st(page)).locked, 'Demo mode locked');
  await ctx.close();
  note('note when parked / waits when moving; lock, refusal and unlock; demo never locked');
};
