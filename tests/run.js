'use strict';
/* Leaf Dash checks. Serves the app from this folder's parent, opens it in headless Chromium, and runs each test.
   Usage:  node tests/run.js            all tests
           node tests/run.js smoke      just one (or several names)
   Needs Playwright with Chromium (see tests/README.md). Exits with 1 if anything failed. */
const http = require('http'), fs = require('fs'), path = require('path'), assert = require('assert');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.md': 'text/plain' };
const ALL = ['smoke', 'readonly', 'polling', 'resync', 'safety', 'recorder', 'mapcache', 'replay', 'cameras'];

function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { rsp.writeHead(404); return rsp.end(); }
      rsp.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(f).pipe(rsp);
    }).listen(0, '127.0.0.1', () => res(srv));
  });
}

(async () => {
  const want = process.argv.slice(2), names = want.length ? want : ALL;
  const srv = await serve(), base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  let failed = 0;
  for (const name of names) {
    const t0 = Date.now(), notes = [];
    try {
      await require(`./${name}.test.js`)({ browser, base, assert, note: s => notes.push(s) });
      console.log(`✔ ${name} (${((Date.now() - t0) / 1000).toFixed(0)} s)${notes.length ? '\n    ' + notes.join('\n    ') : ''}`);
    } catch (e) {
      failed++;
      console.log(`✘ ${name}: ${e.message}${notes.length ? '\n    ' + notes.join('\n    ') : ''}`);
    }
  }
  await browser.close(); srv.close();
  console.log(failed ? `\n${failed} of ${names.length} failed` : `\nall ${names.length} passed`);
  process.exit(failed ? 1 : 0);
})();
