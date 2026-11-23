'use strict';
/* Hard rule 1: nothing may change the car. Connected to the fake adapter, every command the app sends must be an
   adapter set-up/info AT command, a 21xx group read or a 22xxxx identifier read; and write/control services must
   be refused before they reach the adapter, from code and from the Debug command box. */
const { open, connect, sleep } = require('./helpers.js');
module.exports = async ({ browser, base, assert, note }) => {
  const { ctx, page, errors } = await open(browser, base, '?view=debug', { mock: true, settings: { dev: true } });
  await connect(page);
  await sleep(20000);
  const r = await page.evaluate(async () => {
    const writes = ['2E123400', '2F123403', '3101FF00', '2701', '1003', '1101', '14FFFFFF', '280000', '8502', '3E00', 'ATMA2', 'ATPP0CSV00'];
    const refused = [];
    for (const c of writes) { try { await S.elm.send(c, 500); } catch (e) { if (/Blocked/.test(e.message)) refused.push(c); } }
    $('cmdIn').value = '2E123400'; $('btnSend').click();
    await new Promise(r => setTimeout(r, 300));
    return { sent: [...new Set(window.__sent)], writes, refused, box: logLines.slice(-3).join(' | ') };
  });
  // the sniffer on an adapter that can't listen silently (like the LELink²): it must refuse, and never start monitoring
  await page.click('#btnSniff'); await sleep(1500);
  const sn = await page.evaluate(() => ({ status: $('snStatus').textContent, monitored: window.__sent.includes('ATMA'), sniffing: S.sniffing }));
  assert.ok(!sn.monitored && !sn.sniffing && /Not supported/.test(sn.status), `sniffer without silent mode: ${JSON.stringify(sn)}`);
  const bad = r.sent.filter(c => !(/^AT/.test(c) || /^21[0-9A-F]{2}$/.test(c) || /^22[0-9A-F]{4}$/.test(c)));
  assert.deepStrictEqual(bad, [], 'commands outside AT / 21xx / 22xxxx reached the adapter');
  assert.deepStrictEqual(r.refused, r.writes, 'a write/control command was not refused');
  assert.ok(!r.sent.some(c => r.writes.includes(c)), 'a refused command still reached the adapter');
  assert.ok(/blocked/i.test(r.box), 'the command box did not say the write was blocked');
  assert.deepStrictEqual(errors, [], 'page errors');
  note(`${r.sent.length} different commands sent, all read-only; ${r.writes.length} write/control commands refused; sniffer refuses without silent mode`);
  await ctx.close();
};
