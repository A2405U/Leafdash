'use strict';
/* Offline maps (1.1): a county pack is chosen in Settings, downloaded (a stand-in for the Android app's
   MapDownloads), unpacked into the phone's database, and then the road loads from it with no request to the map
   servers. Outside the pack the servers are used, unless "Only use offline maps" is on. Remove deletes it. */
const zlib = require('zlib');
const { MOCK } = require('./mock-adapter.js');
const { sleep, until } = require('./helpers.js');

// A pack in the same format as maptools/build_pack.py makes (tiles of 0.02° × 0.032°).
function makePack() {
  const tile = (lat, lon) => `${Math.floor(lat / 0.02)},${Math.floor(lon / 0.032)}`;
  const g = [], ids = [];
  for (let i = 0; i < 11; i++) { g.push(+(51.4955 + i * 0.001).toFixed(6), -0.12); ids.push(100 + i); }
  const way = { w: 1, n: ids, g, t: { highway: 'residential', name: 'Offline Road', maxspeed: '20 mph' } };
  const lights = { p: 103, a: 51.4985, o: -0.12, t: { highway: 'traffic_signals' } };
  const cam = { r: 9, t: { type: 'enforcement', enforcement: 'maxspeed' }, m: [[302, 'device', 51.502, -0.1201]] };
  const tiles = {};
  for (const k of ['2574,-5', '2574,-4', '2575,-5', '2575,-4']) tiles[k] = new Set();   // entirely inside the county
  for (let i = 0; i < g.length; i += 2) (tiles[tile(g[i], g[i + 1])] ||= new Set()).add(way);
  (tiles[tile(lights.a, lights.o)] ||= new Set()).add(lights);
  (tiles[tile(51.502, -0.1201)] ||= new Set()).add(cam);
  const head = { format: 'leafdash map pack v1', region: 'test-county', name: 'Test County', built: '2026-11-23', source: 'Map data © OpenStreetMap contributors, ODbL', tile: [0.02, 0.032], tiles: Object.keys(tiles).length, ways: 1, nodes: 1, relations: 1 };
  const lines = [JSON.stringify(head), ...Object.entries(tiles).map(([k, s]) => JSON.stringify({ k, f: 1, e: [...s] }))];
  return zlib.gzipSync(lines.join('\n') + '\n');
}

function FAKE_MAPS(size) {
  window.__maps = { deleted: [], downloads: 0 };
  const cb = (id, ok, data) => setTimeout(() => window.__leafMapCb(id, ok, data), 20);
  window.LeafNative = {
    mapIndex: id => cb(id, true, JSON.stringify({ format: 'leafdash map index v1', packs: [
      { id: 'test-county', name: 'Test County', bytes: size, built: '2026-11-30', tiles: 2, ways: 1 },
      { id: 'other-county', name: 'Other County', bytes: 4e6, built: '2026-11-30', tiles: 9, ways: 9 }] })),
    mapDownload: (id, name) => { window.__maps.downloads++; setTimeout(() => window.__leafMapProgress(name, size / 2, size), 5); cb(id, true, `/maps/${name}.ldmap`); },
    mapDelete: name => window.__maps.deleted.push(name),
  };
}

module.exports = async ({ browser, base, assert, note }) => {
  const pack = makePack();
  const ctx = await browser.newContext({ permissions: ['geolocation'], geolocation: { latitude: 51.5003, longitude: -0.1201, accuracy: 5 } });
  await ctx.addInitScript(MOCK);
  await ctx.addInitScript(FAKE_MAPS, pack.length);
  await ctx.addInitScript(() => { window.__lat = 15; localStorage.setItem('leafdash.settings', JSON.stringify({ realRoad: true, dev: true })); });
  let hits = 0;
  await ctx.route(/overpass/, r => { hits++; return r.fulfill({ status: 502, body: 'busy' }); });
  await ctx.route(/\/maps\/test-county\.ldmap$/, r => r.fulfill({ status: 200, contentType: 'application/octet-stream', body: pack }));
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let n = 0; const tick = setInterval(() => ctx.setGeolocation({ latitude: 51.5003 + (n++ % 2) * 0.00001, longitude: -0.1201, accuracy: 5 }).catch(() => {}), 1000);
  try {
    await page.goto(base);
    await page.evaluate(() => { window.__osmc = []; LeafDash.on('osmc', e => __osmc.push(e)); });

    // Settings → Drive screen → Offline maps → Choose counties… → Download
    await page.click('#btnSettings');
    await page.evaluate(() => { document.querySelector('[data-sec="drive"]').open = true; });
    await sleep(300);
    assert.ok(await page.$('[data-off-open]'), 'no "Choose counties…" button in the app');
    await page.click('[data-off-open]');
    await page.waitForSelector('[data-id="test-county"] [data-act="get"]');
    const listed = await page.evaluate(() => [...document.querySelectorAll('[data-off-list] [data-id]')].map(r => r.dataset.id));
    assert.deepStrictEqual(listed.sort(), ['other-county', 'test-county'], `county list: ${listed}`);
    await page.click('[data-id="test-county"] [data-act="get"]');
    const installed = await until(page, async () => (await offmapRegions()).length === 1 && document.querySelector('[data-id="test-county"] [data-act="rm"]') && true, 8000);
    assert.ok(installed, 'the county was not installed');
    const st = await page.evaluate(async () => ({ shown: document.querySelector('[data-id="test-county"] [data-st]').textContent, deleted: __maps.deleted, meta: (await offmapRegions())[0] }));
    assert.ok(/On this phone · map of 2026-11-23 · newer one available/.test(st.shown), `row after install: "${st.shown}"`);
    assert.deepStrictEqual(st.deleted, ['test-county'], 'the downloaded file was not deleted after unpacking');
    assert.ok(st.meta.tiles >= 2 && st.meta.name === 'Test County', `stored: ${JSON.stringify(st.meta)}`);
    await page.evaluate(() => document.querySelectorAll('.modal-wrap').forEach(w => w.remove()));

    // drive inside the county: the road comes from the phone, the map servers are never asked
    await page.click('#btnConnect');
    await page.waitForFunction(() => S.mode === 'on', null, { timeout: 15000 });
    await page.evaluate(() => document.querySelectorAll('.modal-wrap').forEach(w => w.remove()));
    const road = await until(page, () => OSM.path && OSM.ways.size && { names: [...OSM.ways.values()].map(w => w.tags.name), feats: [...OSM.feats.values()].map(f => f.kind).sort() }, 10000);
    assert.ok(road, 'no road matched from the offline map');
    assert.deepStrictEqual(road.names, ['Offline Road'], `roads loaded: ${road.names}`);
    assert.ok(road.feats.includes('lights') && road.feats.includes('speedcam'), `lights and camera not loaded: ${road.feats}`);
    assert.strictEqual(hits, 0, `the map servers were asked ${hits} times inside the downloaded county`);
    assert.ok(await page.evaluate(() => __osmc.some(e => e.op === 'offline' && e.covered && e.elements > 0)), 'no "offline" event for the drive recorder');

    // outside the county: the servers are used as before; with "Only use offline maps" they never are
    const out = await page.evaluate(async () => {
      OSM.busy = false; OSM.nextTry = 0; OSM.fetchAt = null;
      await osmFetch(51.62, -0.30);
      const asked = OSM.status;
      SET.offlineOnly = true; OSM.fetchAt = null; OSM.nextTry = 0;
      await osmFetch(51.64, -0.35);
      const only = OSM.status; SET.offlineOnly = false;
      return { asked, only };
    });
    assert.ok(hits > 0, 'outside the county the map servers were not asked');
    const before = hits;
    assert.strictEqual(out.only, 'outside offline maps', `offline-only status: ${out.only}`);
    await sleep(500);
    assert.strictEqual(hits, before, 'with "Only use offline maps" on, the map servers were still asked');

    // remove
    await page.evaluate(() => offmapRemove('test-county'));
    const left = await page.evaluate(async () => ({ regions: (await offmapRegions()).length, tiles: (await offReq((await offStore()).getAllKeys())).length }));
    assert.deepStrictEqual(left, { regions: 0, tiles: 0 }, `after Remove: ${JSON.stringify(left)}`);
    assert.deepStrictEqual(errors, [], 'page errors');
    note(`county chosen, downloaded, unpacked (${st.meta.tiles} tiles); road, lights and camera loaded with 0 map-server requests; servers used outside it, never with "only offline"; removed cleanly`);
  } finally { clearInterval(tick); await ctx.close(); }
};
