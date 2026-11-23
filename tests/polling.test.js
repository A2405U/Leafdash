'use strict';
/* On a realistic link (70 ms per reply) while moving, the slow values must all get their turn, as they didn't before
   5.4b: cells, temperatures, 12 V, dash range, tyres and odometer. Speed should still come about once a second. */
const { open, connect, sleep } = require('./helpers.js');
module.exports = async ({ browser, base, assert, note }) => {
  const { ctx, page, errors } = await open(browser, base, '', { mock: true, lat: 70, spd: 500 });
  await connect(page);
  await page.evaluate(() => { window.__sent.length = 0; window.__t0 = Date.now(); });
  await sleep(60000);
  const r = await page.evaluate(() => { const c = {}; __sent.forEach(x => c[x] = (c[x] || 0) + 1); return { c, s: (Date.now() - __t0) / 1000, cells: S.data.cells?.length, odo: S.data.odoKm, tyres: S.data.tyres }; });
  const every = k => r.c[k] ? r.s / r.c[k] : Infinity;
  const want = { '22121A': 1.6, '2102': 30, '2104': 20, 'ATRV': 30, '220E24': 30, '220E25': 60, '220E01': 61 };
  for (const [k, max] of Object.entries(want)) assert.ok(every(k) <= max, `${k} read every ${every(k).toFixed(1)} s (want ≤ ${max} s)`);
  assert.strictEqual(r.cells, 96, 'cells not decoded');
  assert.ok(r.odo > 0, `odometer not decoded (${r.odo})`);
  assert.ok(r.tyres?.every(x => x > 0), `tyres not decoded (${JSON.stringify(r.tyres)})`);
  assert.deepStrictEqual(errors, [], 'page errors');
  note(`speed every ${every('22121A').toFixed(1)} s, cells ${every('2102').toFixed(0)} s, temps ${every('2104').toFixed(0)} s, dash range ${every('220E24').toFixed(0)} s, tyres ${every('220E25').toFixed(0)} s, odometer ${every('220E01').toFixed(0)} s`);
  await ctx.close();
};
