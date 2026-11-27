/* Leaf Dash Android app: gives the web app the browser features it expects, using the phone's own.
 *
 * Android's WebView has no Web Bluetooth, screen wake lock, working speech or file sharing. This runs before
 * the page's scripts and builds those from window.LeafNative (NativeBridge.java), so the web code runs unchanged:
 *   navigator.bluetooth  requestDevice / getDevices, device.gatt, services, characteristics, notifications
 *   navigator.wakeLock   keeps the screen on
 *   speechSynthesis      spoken updates through Android's text-to-speech
 *   navigator.share      the Android share sheet
 *   <a download>.click() saves the file to Downloads
 * Every command still goes through the web app's isReadOnly() and, in the app, ReadOnlyGuard.java as well.
 */
(function () {
  'use strict';
  const N = window.LeafNative;
  if (!N || window.__leafNativeReady) return;
  window.__leafNativeReady = true;

  /* ---------- calls and answers ---------- */
  let seq = 0;
  const waiting = new Map();
  function call(fn, ...args) {
    return new Promise((resolve, reject) => {
      const id = 'c' + (++seq);
      waiting.set(id, { resolve, reject });
      try { N[fn](id, ...args); } catch (e) { waiting.delete(id); reject(e); }
    });
  }
  window.__leafNativeCb = (id, ok, data) => {
    const w = waiting.get(id); if (!w) return;
    waiting.delete(id);
    if (ok) w.resolve(data);
    else {
      const e = new Error(data || 'Failed');
      if (/cancelled/i.test(data)) e.name = 'NotFoundError';   // what Chrome gives when the picker is closed
      w.reject(e);
    }
  };

  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    const s = atob(b64), out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  const asBytes = v => v instanceof Uint8Array ? v : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v);
  const uuid = u => typeof u === 'number' ? '0000' + u.toString(16).padStart(4, '0') + '-0000-1000-8000-00805f9b34fb' : String(u).toLowerCase();

  /* ---------- Bluetooth ---------- */
  class Emitter {
    constructor() { this._l = {}; }
    addEventListener(t, f) { (this._l[t] = this._l[t] || new Set()).add(f); }
    removeEventListener(t, f) { this._l[t]?.delete(f); }
    _fire(t, ev) { ev.target = ev.currentTarget = this; for (const f of [...(this._l[t] || [])]) { try { f.call(this, ev); } catch (e) { console.error(e); } } }
  }

  const chars = new Map();     // "service|characteristic" → characteristic, for notifications
  let current = null;          // the device that's connected

  class Characteristic extends Emitter {
    constructor(service, info) {
      super();
      this.service = service; this.uuid = info.uuid; this.properties = info.props; this.value = null;
      chars.set(service.uuid + '|' + this.uuid, this);
    }
    async startNotifications() { await call('bleNotify', this.service.uuid, this.uuid); return this; }
    async stopNotifications() { return this; }
    writeValue(v) { return call('bleWrite', this.service.uuid, this.uuid, toB64(asBytes(v)), false).then(() => undefined); }
    writeValueWithResponse(v) { return this.writeValue(v); }
    writeValueWithoutResponse(v) { return call('bleWrite', this.service.uuid, this.uuid, toB64(asBytes(v)), true).then(() => undefined); }
    readValue() { return Promise.reject(new Error('Reading is not used by Leaf Dash')); }
  }
  class Service {
    constructor(device, info) { this.device = device; this.uuid = info.uuid; this.isPrimary = true; this._chars = info.chars; }
    async getCharacteristics(u) {
      const list = this._chars.filter(c => u == null || c.uuid === uuid(u)).map(c => new Characteristic(this, c));
      if (!list.length) throw new Error('No characteristics found');
      return list;
    }
    async getCharacteristic(u) { return (await this.getCharacteristics(u))[0]; }
  }
  class Server {
    constructor(device) { this.device = device; this.connected = false; this._services = []; }
    async connect() {
      const got = JSON.parse(await call('bleConnect', this.device.id) || '{}');
      this._services = Array.isArray(got) ? got : got.services || [];
      this.fastLink = !!got.fastLink;                         // the phone was asked for its fastest Bluetooth link
      this.connected = true; current = this.device; chars.clear();
      return this;
    }
    disconnect() { if (this.connected) N.bleDisconnect(); }
    async getPrimaryService(u) {
      const s = this._services.find(x => x.uuid === uuid(u));
      if (!s) { const e = new Error('No such service'); e.name = 'NotFoundError'; throw e; }
      return new Service(this.device, s);
    }
    async getPrimaryServices() { return this._services.map(s => new Service(this.device, s)); }
  }
  const devices = new Map();
  class Device extends Emitter {
    constructor(id, name) { super(); this.id = id; this.name = name; this.gatt = new Server(this); }
    static of(info) {
      let d = devices.get(info.id);
      if (!d) { d = new Device(info.id, info.name); devices.set(info.id, d); }
      return d;
    }
  }

  window.__leafNativeNotify = (svc, ch, b64) => {
    const c = chars.get(svc + '|' + ch); if (!c) return;
    const bytes = fromB64(b64);
    c.value = new DataView(bytes.buffer);
    c._fire('characteristicvaluechanged', {});
  };
  window.__leafNativeDisconnected = () => {
    const d = current; current = null; chars.clear();
    if (!d) return;
    d.gatt.connected = false;
    d._fire('gattserverdisconnected', {});
  };

  const bluetooth = {
    native: true,
    fastLink: () => { try { return !!N.bleFastLink(); } catch { return false; } },   // ask again (app.js, when the link slows)
    async getAvailability() { return true; },
    async requestDevice() { return Device.of(JSON.parse(await call('bleScan'))); },
    async getDevices() { return JSON.parse(await call('bleRemembered')).map(Device.of); },
  };
  Object.defineProperty(navigator, 'bluetooth', { value: bluetooth, configurable: true });

  /* ---------- keeping the screen on ---------- */
  let locks = 0;
  class Lock extends Emitter {
    constructor() { super(); this.type = 'screen'; this.released = false; }
    async release() { if (this.released) return; this.released = true; if (--locks <= 0) { locks = 0; N.keepAwake(false); } this._fire('release', {}); }
  }
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { async request() { locks++; N.keepAwake(true); return new Lock(); } } });

  /* ---------- speech ---------- */
  class Utterance extends Emitter {
    constructor(text) { super(); this.text = text || ''; this.lang = 'en-GB'; this.rate = 1; this.pitch = 1; this.volume = 1; }
  }
  const speech = {
    speaking: false, pending: false, paused: false,
    speak(u) { N.speak(String(u.text), u.lang || 'en-GB', +u.rate || 1); },
    cancel() { N.stopSpeaking(); },
    pause() {}, resume() {},
    getVoices() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: speech, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true, writable: true });

  /* ---------- files: share sheet and Downloads ---------- */
  async function b64Of(blob) { return toB64(new Uint8Array(await blob.arrayBuffer())); }
  navigator.canShare = data => !!(data && data.files && data.files.length === 1);
  navigator.share = async data => {
    const f = data && data.files && data.files[0];
    if (!f) throw new TypeError('Nothing to share');
    await call('share', f.name || 'leafdash', f.type || 'application/octet-stream', await b64Of(f));
  };

  // The page's CSP doesn't allow fetching blob: addresses, so remember which file each one stands for.
  const blobs = new Map();
  const make = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = o => { const u = make(o); if (o instanceof Blob) blobs.set(u, o); return u; };
  URL.revokeObjectURL = u => { blobs.delete(u); revoke(u); };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const blob = this.download && blobs.get(this.href);
    if (!blob) return click.call(this);
    const name = this.download, type = blob.type || 'application/octet-stream';
    b64Of(blob).then(b => call('save', name, type, b)).catch(e => console.error('save failed', e));
  };
})();
