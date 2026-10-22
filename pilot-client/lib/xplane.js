'use strict';
/*
 * X-Plane 12 adapter.
 *  - reads your aircraft over X-Plane's built-in UDP interface (RREF dataref subscriptions, port 49000)
 *  - sends network traffic to the Airwave X-Plane plugin (UDP port 49010, one text line per aircraft), which draws it with XPMP2
 *    and matches CSL models by aircraft type and airline
 */
const dgram = require('dgram');
const { EventEmitter } = require('events');

const DATAREFS = [
  'sim/flightmodel/position/latitude', 'sim/flightmodel/position/longitude', 'sim/flightmodel/position/elevation',
  'sim/flightmodel/position/true_psi', 'sim/flightmodel/position/groundspeed', 'sim/flightmodel/position/vh_ind_fpm',
  'sim/flightmodel/failures/onground_any', 'sim/flightmodel/position/theta', 'sim/flightmodel/position/phi',
  'sim/cockpit/radios/transponder_code', 'sim/cockpit2/radios/actuators/com1_frequency_hz_833'
];
const RATE_HZ = 5;
const M_TO_FT = 3.28084, MS_TO_KT = 1.943844;

function rrefPacket(freq, index, dataref) {
  const b = Buffer.alloc(413);
  b.write('RREF\0', 0, 'ascii');
  b.writeInt32LE(freq, 5);
  b.writeInt32LE(index, 9);
  b.write(dataref, 13, 'ascii');
  return b;
}
function parseRref(msg) {
  if (msg.length < 5 || msg.toString('ascii', 0, 4) !== 'RREF') return null;
  const out = {};
  for (let o = 5; o + 8 <= msg.length; o += 8) out[msg.readInt32LE(o)] = msg.readFloatLE(o + 4);
  return out;
}

class XPlaneAdapter extends EventEmitter {
  constructor({ host = '127.0.0.1', port = 49000, pluginPort = 49010, log = () => {} } = {}) {
    super();
    Object.assign(this, { host, port, pluginPort, log });
    this.values = {}; this.lastData = 0; this.connected = false; this.plugin = null;
    this.list = new Map();
  }
  start() {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('message', (msg, rinfo) => this.onMessage(msg, rinfo));
    this.sock.on('error', e => this.log('X-Plane UDP error: ' + e.message));
    this.sock.bind(0, () => {
      this.subscribe(RATE_HZ);
      this.timer = setInterval(() => this.watchdog(), 2000);
    });
    this.emit('status', { sim: 'xplane', connected: false, text: 'Waiting for X-Plane…' });
  }
  stop() {
    clearInterval(this.timer);
    try { this.subscribe(0); } catch (e) { /* socket closing */ }
    setTimeout(() => { try { this.sock.close(); } catch (e) { /* closed */ } }, 100);
  }
  subscribe(freq) { DATAREFS.forEach((d, i) => this.sock.send(rrefPacket(freq, i, d), this.port, this.host)); }

  watchdog() {
    const silent = Date.now() - this.lastData > 4000;
    if (silent) {
      if (this.connected) { this.connected = false; this.emit('status', { sim: 'xplane', connected: false, text: 'Waiting for X-Plane…' }); }
      this.subscribe(RATE_HZ); // X-Plane forgets subscriptions when it restarts
    }
    if (this.plugin && Date.now() - this.plugin.seen > 6000) { this.plugin = null; this.emit('plugin', null); }
  }

  onMessage(msg, rinfo) {
    const head = msg.toString('ascii', 0, 4);
    if (head === 'RREF') {
      Object.assign(this.values, parseRref(msg));
      this.lastData = Date.now();
      if (!this.connected) { this.connected = true; this.log('Receiving data from X-Plane'); this.emit('status', { sim: 'xplane', connected: true, text: 'X-Plane connected' }); }
      const v = this.values;
      if (v[0] == null || v[1] == null) return;
      this.emit('position', {
        lat: v[0], lon: v[1], alt: (v[2] || 0) * M_TO_FT, hdg: ((v[3] || 0) + 360) % 360, gs: (v[4] || 0) * MS_TO_KT, vs: v[5] || 0,
        onGround: (v[6] || 0) > 0.5, pitch: v[7] || 0, bank: v[8] || 0, squawk: String(Math.round(v[9] || 2000)).padStart(4, '0')
      });
      if (v[10] > 100000) this.emit('com1', (v[10] / 1000).toFixed(3));
      return;
    }
    if (head === 'AWXP') { // status from the Airwave plugin: AWXP {json}
      try {
        const st = JSON.parse(msg.toString('utf8', 5));
        const first = !this.plugin;
        this.plugin = Object.assign(st, { seen: Date.now() });
        if (first) { this.log(`Airwave X-Plane plugin connected (${st.models || 0} CSL models)`); this.emit('plugin', st); }
      } catch (e) { /* ignore */ }
    }
  }

  add(a) { this.list.set(a.cs, a); }
  remove(a) { this.list.delete(a.cs); }
  removeAll() { this.list.clear(); }

  // Sends every aircraft's smoothed state to the plugin, ~20 times a second.
  render(stateOf) {
    if (!this.sock) return;
    // One line per aircraft: cs|type|airline|lat|lon|alt_ft|hdg|pitch|roll|gs|gear|gnd|lights
    const lines = [];
    for (const a of this.list.values()) {
      const s = stateOf(a);
      const lt = (s.lights.nav ? 1 : 0) | (s.lights.beacon ? 2 : 0) | (s.lights.strobe ? 4 : 0) | (s.lights.landing ? 8 : 0) | (s.lights.taxi ? 16 : 0);
      lines.push([a.cs, a.type || 'A320', a.airline || '', s.lat.toFixed(7), s.lon.toFixed(7), s.alt.toFixed(1), s.hdg.toFixed(1),
        s.pitch.toFixed(1), s.bank.toFixed(1), Math.round(s.gs), s.gearDown ? 1 : 0, s.onGround ? 1 : 0, lt].join('|'));
    }
    const buf = Buffer.from('AWTR\n' + lines.join('\n'), 'utf8');
    if (buf.length < 60000) this.sock.send(buf, this.pluginPort, '127.0.0.1');
  }
  stats() {
    return { shown: this.plugin ? this.list.size : 0, total: this.list.size, models: this.plugin ? this.plugin.models || 0 : 0, plugin: !!this.plugin,
      matches: this.plugin && this.plugin.matches ? this.plugin.matches : [] };
  }
}

module.exports = { XPlaneAdapter, rrefPacket, parseRref, DATAREFS };
