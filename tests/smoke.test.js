'use strict';
/* Every view and mode at phone, sideways-phone and tablet sizes: no page errors, no "undefined"/"NaN" on screen,
   no sideways scrolling. Also: an older phone's database (version 1) upgrades and keeps its health trip logs. */
const { open, sleep } = require('./helpers.js');
module.exports = async ({ browser, base, assert, note }) => {
  const sizes = { phone: { width: 412, height: 915 }, sideways: { width: 915, height: 412 }, tablet: { width: 1024, height: 768 } };
  const urls = ['?demo', '?demo&view=dash', '?demo&view=energy', '?demo&view=cells', '?demo&view=debug', '?charging', '?healthdemo', '?roadtest'];
  for (const [size, viewport] of Object.entries(sizes)) {
    const { ctx, page, errors } = await open(browser, base, '', { viewport, settings: { dev: true } });
    for (const u of urls) {
      await page.goto(base + u); await sleep(1500);
      const r = await page.evaluate(() => ({ bad: (document.body.innerText.match(/\b(undefined|NaN)\b/g) || []).length, wide: document.documentElement.scrollWidth > innerWidth + 1 }));
      assert.strictEqual(r.bad, 0, `"undefined" or "NaN" on screen: ${size} ${u}`);
      assert.ok(!r.wide, `sideways scrolling: ${size} ${u}`);
    }
    assert.deepStrictEqual(errors, [], `page errors at ${size}`);
    await ctx.close();
  }
  // database upgrade from version 1 (before the drive recorder) keeps old health trip logs
  const { ctx, page } = await open(browser, base, 'manifest.webmanifest');
  await page.evaluate(() => new Promise(r => { const q = indexedDB.open('leafdash', 1); q.onupgradeneeded = () => q.result.createObjectStore('healthraw'); q.onsuccess = () => { const tx = q.result.transaction('healthraw', 'readwrite'); tx.objectStore('healthraw').put('old log', '123'); tx.oncomplete = () => { q.result.close(); r(); }; }; }));
  await page.goto(base); await sleep(1200);
  const up = await page.evaluate(async () => ({ old: await htRawGet('123'), stores: [...(await htDb()).objectStoreNames].sort() }));
  assert.strictEqual(up.old, 'old log', 'old health trip log lost in the upgrade');
  assert.deepStrictEqual(up.stores, ['driverec', 'healthraw', 'osmcache'], 'database stores after the upgrade');
  note(`${urls.length} pages × ${Object.keys(sizes).length} sizes, database upgrade`);
  await ctx.close();
};
