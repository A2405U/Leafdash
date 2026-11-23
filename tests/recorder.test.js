'use strict';
/* Drive recorder (5.0b): records every kind of line from a live connection, never the VIN, keeps a recording when
   the app closes, and records in Demo with the map route. */
const zlib = require('zlib');
const { open, connect, sleep } = require('./helpers.js');
const fileOf = async page => page.evaluate(async () => { const l = await recList(); const f = await recFile(l[0].id); return { meta: l[0], name: f.name, b64: btoa(String.fromCharCode(...new Uint8Array(await f.arrayBuffer()))) }; });
const linesOf = f => { const buf = Buffer.from(f.b64, 'base64'); return (f.name.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString(); };
module.exports = async ({ browser, base, assert, note }) => {
  const { ctx, page, errors } = await open(browser, base, '?view=debug', { mock: true, lat: 15, settings: { dev: true }, geo: { latitude: 51.5, longitude: -0.12, accuracy: 8 } });
  await connect(page);
  await page.evaluate(() => showView('debug'));
  await page.click('#recBtn');
  for (let i = 0; i < 14; i++) { await ctx.setGeolocation({ latitude: 51.5 + i * 0.0002, longitude: -0.12, accuracy: 8 }); await sleep(1000); }
  await page.click('#recBtn'); await sleep(1500);
  const f = await fileOf(page), text = linesOf(f), lines = text.trim().split('\n').map(JSON.parse);
  const kinds = new Set(lines.map(l => l.k));
  for (const k of ['head', 'd', 'elm', 'gps', 'cells', 'app', 'end']) assert.ok(kinds.has(k), `no "${k}" lines in the recording`);
  assert.ok(!/TESTVIN|2181/.test(text), 'the VIN (or its request) is in the recording');
  assert.ok(/\.jsonl(\.gz)?$/.test(f.name) && f.meta.done && f.meta.reason === 'stopped', 'recording not finished properly');
  // closing the app mid-recording keeps it, marked "app closed"
  await page.click('#recBtn'); await sleep(7000);
  await page.goto(base + '?view=debug'); await sleep(1500);
  const after = await page.evaluate(async () => (await recList()).map(m => ({ reason: m.reason, done: m.done, lines: m.lines })));
  assert.ok(after[0].reason === 'app closed' && after[0].done && after[0].lines > 2, 'a recording cut off by closing the app was lost');
  assert.deepStrictEqual(errors, [], 'page errors');
  note(`live: ${lines.length} lines (${[...kinds].join(', ')}), no VIN; app-closed recording kept`);
  await ctx.close();
};
