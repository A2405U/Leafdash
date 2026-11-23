'use strict';
/* Speed and red-light cameras from OpenStreetMap: every common way of tagging them is recognised, an enforcement
   relation's "device" becomes a camera, and on the demo route each camera shows in the "next" pill (taking priority
   over the lights it sits at) and is drawn at the kerb. The Cameras switch hides them. */
const { open, sleep } = require('./helpers.js');
module.exports = async ({ browser, base, assert, note }) => {
  const { ctx, page, errors } = await open(browser, base, '?demo');
  await sleep(1500);
  const kinds = await page.evaluate(() => [
    { highway: 'speed_camera' }, { highway: 'speed_camera', speed_camera: 'traffic_signals' }, { highway: 'red_light_camera' },
    { man_made: 'surveillance', surveillance: 'red_light' }, { highway: 'speed_camera', note: 'Red light camera' },
    { man_made: 'surveillance', surveillance: 'public' }, { highway: 'traffic_signals' },
    { highway: 'traffic_signals', enforcement: 'red_light_camera' }, { highway: 'traffic_signals', enforcement: 'traffic_signals' },
  ].map(featKind));
  assert.deepStrictEqual(kinds, ['speedcam', 'redcam', 'redcam', 'redcam', 'redcam', null, 'lights', 'redcam', 'redcam'], 'camera tags not recognised');
  // lights tagged with a camera keep their lights too
  const both = await page.evaluate(() => { osmLoad({ elements: [{ type: 'node', id: 4242, lat: 51.509, lon: -0.121, tags: { highway: 'traffic_signals', enforcement: 'red_light_camera' } }] }); return [OSM.feats.get(4242)?.kind, OSM.feats.get('l4242')?.kind]; });
  assert.deepStrictEqual(both, ['redcam', 'lights'], 'lights with a camera tag should give both a camera and lights');
  const rel = await page.evaluate(() => { osmLoad({ elements: [{ type: 'relation', id: 77, tags: { type: 'enforcement', enforcement: 'traffic_signals' },
    members: [{ type: 'node', ref: 5, role: 'device', lat: 51.51, lon: -0.12 }, { type: 'node', ref: 6, role: 'from', lat: 51.5101, lon: -0.12 }] }] }); return OSM.feats.get('r77:5')?.kind; });
  assert.strictEqual(rel, 'redcam', 'enforcement relation device not loaded as a camera');
  // drive the demo route to just before each camera and look at the pill
  const pill = async kind => page.evaluate(async k => {
    const R = DRT.route, cam = R.feats.find(f => f.kind === k).p;
    let best = null; for (let d = 0; d < R.len; d += 2) { const q = R.posAt(d); const dd = Math.hypot(q.x - cam.x, q.y - cam.y); if (!best || dd < best.dd) best = { dd, d }; }
    DRT.s = Math.max(0, best.d - 150); DRT.stopsDone = new Set(R.stops); DRT.waitUntil = 0;
    await new Promise(r => setTimeout(r, 4000));
    return $('roadNext').classList.contains('hidden') ? '' : $('roadNext').textContent;
  }, kind);
  const sp = await pill('speedcam'), rd = await pill('redcam');
  assert.ok(/^Speed camera · \d+ yd$/.test(sp), `speed camera not shown ahead: "${sp}"`);
  assert.ok(/^Red-light camera · \d+ yd$/.test(rd), `red-light camera not shown ahead of its lights: "${rd}"`);
  await page.evaluate(() => { SET.cameras = false; }); await sleep(1200);
  const off = await page.evaluate(() => $('roadNext').textContent);
  assert.ok(!/camera/.test(off), 'cameras still shown with the switch off');
  assert.deepStrictEqual(errors, [], 'page errors');
  note(`tags recognised; "${sp}", "${rd}"; switch hides them`);
  await ctx.close();
};
