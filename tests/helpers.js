'use strict';
const { MOCK } = require('./mock-adapter.js');
/** A fresh browser context (own storage), with page errors collected. opts: { mock, settings, lat, spd, viewport, geo } */
async function open(browser, base, url = '', opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport || { width: 412, height: 915 },
    ...(opts.geo ? { permissions: ['geolocation'], geolocation: opts.geo } : {}) });
  if (opts.mock) await ctx.addInitScript(MOCK);
  await ctx.addInitScript(([lat, spd]) => { if (lat != null) window.__lat = lat; if (spd != null) window.__spd = spd; }, [opts.lat ?? null, opts.spd ?? null]);
  if (opts.settings) await ctx.addInitScript(s => { localStorage.setItem('leafdash.settings', JSON.stringify(s)); }, opts.settings);
  await ctx.route(/overpass|iternio|openstreetmap\.de/, r => r.abort());      // never reach real services from a test
  const page = await ctx.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + url);
  await page.waitForTimeout(600);
  return { ctx, page, errors };
}
/** Connect to the fake adapter and close the "Before you drive" note. */
async function connect(page) {
  await page.click('#btnConnect');
  await page.waitForFunction(() => S.mode === 'on', null, { timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => document.querySelectorAll('.modal-wrap').forEach(w => w.remove()));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
module.exports = { open, connect, sleep };
