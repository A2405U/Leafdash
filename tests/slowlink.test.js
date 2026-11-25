'use strict';
/* The small amber "Slow link" badge: shows when the adapter answers slowly (250 ms here), explains itself in the
   alert line when tapped, and goes away when the link speeds up again (60 ms). Also: on a narrow phone the header
   still fits with the badge and the drive recorder's REC showing. */
const { open, connect, sleep } = require('./helpers.js');
module.exports = async ({ browser, base, assert, note }) => {
  const { ctx, page, errors } = await open(browser, base, '', { mock: true, lat: 250, viewport: { width: 360, height: 780 }, settings: { dev: true } });
  await connect(page);
  await sleep(12000);
  const shown = await page.evaluate(() => ({ on: !$('slowLink').classList.contains('hidden'), ms: LINK.ms }));
  assert.ok(shown.on, `no badge with the adapter answering in 250 ms (measured ${shown.ms} ms)`);
  await page.evaluate(() => recStart()); await sleep(500);
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1 && document.querySelector('.top-right').getBoundingClientRect().right <= innerWidth);
  assert.ok(fits, 'the header overflows a 360 px phone with the badge and REC showing');
  await page.click('#slowLink'); await sleep(300);
  const said = await page.evaluate(() => $('alertBar').textContent);
  assert.ok(/answering slowly \(about \d+ ms a request/.test(said), `tapping the badge didn't explain: "${said}"`);
  await page.evaluate(() => { window.__lat = 60; recStop(); }); await sleep(14000);
  assert.ok(await page.evaluate(() => $('slowLink').classList.contains('hidden')), 'the badge stayed after the link sped up');
  assert.deepStrictEqual(errors, [], 'page errors');
  note(`shown at about ${shown.ms} ms, explains on tap, fits a 360 px header, gone at 60 ms`);
  await ctx.close();
};
