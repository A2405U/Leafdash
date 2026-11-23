'use strict';
/* A fake LELink² (ELM327 over Bluetooth LE) for the tests. It is injected into the page before Leaf Dash loads,
   answers the same read requests the car does with realistic replies (multi-part where the car's are), and records
   every command it was sent in window.__sent, so the tests can check the read-only rule.
   Knobs, set from a test with page.evaluate or addInitScript:
     window.__lat  delay per reply in ms (default 70, like a real adapter; 15 hides slow-link problems)
     window.__spd  the speed the car reports, in tenths of km/h (default 0) */
function MOCK() {
  const enc = new TextEncoder(), dec = new TextDecoder();
  window.__sent = [];
  let listener = null, t = 0;
  const hex = a => a.map(x => x.toString(16).padStart(2, '0').toUpperCase()).join('');
  const multi = bytes => {                                   // CAF on, headers off: "035", "0:…", "1:…"
    const out = [bytes.length.toString(16).toUpperCase().padStart(3, '0'), '0:' + hex(bytes.slice(0, 6))];
    for (let i = 6, n = 1; i < bytes.length; i += 7, n++) out.push((n % 16).toString(16).toUpperCase() + ':' + hex(bytes.slice(i, i + 7).concat(Array(7).fill(0)).slice(0, 7)));
    return out.join('\r');
  };
  const answer = c => {
    c = c.trim().toUpperCase();
    window.__sent.push(c);
    if (c.startsWith('AT')) return c === 'ATZ' || c === 'ATI' ? 'ELM327 v1.5' : c === 'ATRV' ? '12.6V' : c === 'ATCSM1' ? '?' : 'OK';
    if (c === '2181') return multi([0x61, 0x81, ...enc.encode('TESTVIN0000000001'), 0, 0]);   // the VIN: must never be recorded
    if (c === '2101') {
      t++;
      const b = Array(53).fill(0); b[0] = 0x61; b[1] = 1;
      const cur = (-20 - (t % 7)) * 1024; [b[2], b[3], b[4], b[5]] = [(cur >>> 24) & 255, (cur >>> 16) & 255, (cur >>> 8) & 255, cur & 255];
      b[20] = 0x8C; b[21] = 0xA0;                                                                // 360.0 V
      const soc = 650000 - t * 10; [b[33], b[34], b[35]] = [(soc >> 16) & 255, (soc >> 8) & 255, soc & 255];
      const ah = 1058900; [b[37], b[38], b[39]] = [(ah >> 16) & 255, (ah >> 8) & 255, ah & 255];
      return multi(b);
    }
    if (c === '2102') { const b = [0x61, 0x02]; for (let i = 0; i < 96; i++) { const mv = 3950 + (i % 7); b.push(mv >> 8, mv & 255); } return multi(b.concat([0, 0, 0, 0])); }
    if (c === '2104') return multi([0x61, 0x04, 0x02, 0x10, 14, 0x02, 0x10, 15, 0xff, 0xff, 0, 0x02, 0x10, 14, 0, 0]);
    if (c.startsWith('21')) return 'NO DATA';
    if (c === '221156') return '62115604';                                                       // gear D
    if (c === '22121A') return '62121A' + (window.__spd || 0).toString(16).padStart(4, '0').toUpperCase();
    if (/^220E2[5-8]$/.test(c)) return '62' + c.slice(2) + '82';                                   // tyres about 225 kPa
    if (c === '220E01') return '620E01006AFD';                                                    // odometer (3 bytes)
    if (c.startsWith('22')) return '62' + c.slice(2) + '0010';
    return '?';
  };
  const ch = {
    properties: { notify: true, write: true },
    addEventListener: (ev, fn) => { listener = fn; },
    startNotifications: async () => {},
    writeValue: async v => {
      const c = dec.decode(v).replace('\r', '');
      setTimeout(() => listener?.({ target: { value: new DataView(enc.encode(answer(c) + '\r\r>').buffer) } }), window.__lat ?? 70);
    },
  };
  ch.writeValueWithoutResponse = ch.writeValue;
  const svc = { uuid: '0000ffe0-0000-1000-8000-00805f9b34fb', getCharacteristics: async () => [ch] };
  const dev = { name: 'OBDBLE', id: 'test', addEventListener() {}, removeEventListener() {}, gatt: { connect: async () => ({ getPrimaryService: async () => svc }), disconnect() {} } };
  Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => dev, getDevices: async () => [] } });
}
module.exports = { MOCK };
