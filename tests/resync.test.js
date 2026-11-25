'use strict';
/* Getting back in step after a timeout (seen on a real drive, 24 Nov 2026): the battery-health request timed out,
   its reply arrived late, and every reply after it was taken as the answer to the next request for 40 s, until the
   app gave up on speed, gear and power. Here one 2161 reply arrives 6 s late (its timeout is 5 s): the app must be
   back in step within a few seconds, keep reading the fast values, and never skip them. Also checks a cycle needs
   only about one computer switch. */
const { open, connect, sleep } = require('./helpers.js');
module.exports = async ({ browser, base, assert, note }) => {
  const { ctx, page, errors } = await open(browser, base, '', { mock: true, lat: 70, spd: 500 });
  await connect(page);
  await sleep(30000);                                                   // past start-up, when everything is read for the first time
  // computer switches per cycle (ATSH = one switch)
  const sw = await page.evaluate(async () => { __sent.length = 0; await new Promise(r => setTimeout(r, 15000)); const c = x => __sent.filter(y => y.startsWith(x)).length; return { sh: c('ATSH'), g1: c('2101') }; });
  const perCycle = sw.sh / sw.g1;
  assert.ok(perCycle < 1.8, `${perCycle.toFixed(2)} computer switches per cycle (want about 1)`);
  // one late reply
  await page.evaluate(() => { window.__late = { cmd: '2161', ms: 6000 }; POLL.last.g61 = 0; logLines.length = 0; window.__errs = []; LeafDash.on('elm', e => { if (e.err) __errs.push(e.err); }); });
  await sleep(20000);
  const r = await page.evaluate(() => {
    const before = window.__sent.length;
    return new Promise(res => setTimeout(() => res({
      logs: logLines.join('\n') + '\n' + __errs.join('\n'), skipped: CAR_DIDS.filter(d => d.fast && CD.skip[d.key]).map(d => d.key),
      fastReads: window.__sent.slice(before).filter(c => c === '22121A').length, cycle: POLL.cycleMs }), 5000));
  });
  assert.ok(/Timeout: 2161/.test(r.logs), 'the late reply did not cause a timeout (test set-up)');
  assert.ok(/back in step/.test(r.logs), 'no resync after the timeout');
  const wrong = (r.logs.match(/unexpected reply/g) || []).length;
  assert.ok(wrong <= 1, `${wrong} "unexpected reply" errors after the timeout: still out of step`);
  assert.deepStrictEqual(r.skipped, [], 'fast values were given up on');
  assert.ok(r.fastReads >= 3, `speed read only ${r.fastReads} times in 5 s after the hiccup`);
  assert.deepStrictEqual(errors, [], 'page errors');
  note(`${perCycle.toFixed(2)} switches per cycle; back in step after a late reply, ${wrong} wrong replies, speed read ${r.fastReads}× in the next 5 s`);
  await ctx.close();
};
