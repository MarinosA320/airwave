#!/usr/bin/env node
/*
 * End-to-end test of Airwave Pilot with its demo simulator:
 *   server running on :8080, then  node tools/test-pilot.js
 * Starts the pilot client on a spare port, connects it, and checks the full loop with a test controller.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { TrafficManager } = require('../pilot-client/lib/traffic');
const { ModelMatcher } = require('../pilot-client/lib/matcher');
const { rrefPacket, parseRref } = require('../pilot-client/lib/xplane');

const wait = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failed++; };

function unitTests() {
  // Smoothing: a new report 0.3 NM away is blended in, not jumped to.
  let t = 0;
  const tm = new TrafficManager({ now: () => t });
  const r = { cs: 'AEE1', type: 'A20N', lat: 38, lon: 24, alt: 10000, hdg: 90, gs: 300, vs: 0 };
  tm.update([r]);
  const a = tm.list()[0];
  t = 1; const before = tm.stateAt(a);
  tm.update([Object.assign({}, r, { lon: 24.03, alt: 10200 })]);
  const after = tm.stateAt(a);
  check(Math.abs(after.lon - before.lon) < 1e-9 && Math.abs(after.alt - before.alt) < 1e-6, 'new reports blend in without a jump');
  t = 2.5; const later = tm.stateAt(a);
  check(later.lon > 24.03 && Math.abs(later.alt - 10200) < 1, 'blend finishes and the aircraft keeps moving');
  check(tm.stateAt(a).gearDown === false, 'gear up in cruise');

  const m = new ModelMatcher();
  m.setModels([
    { title: 'Airbus A320neo Asobo', livery: 'Aegean Airlines' }, { title: 'Airbus A320neo Asobo', livery: 'Asobo House' },
    { title: 'Boeing 737-800', livery: 'Ryanair' }, { title: 'ATR 72-600', livery: 'Olympic' }, { title: 'Boeing 787-9', livery: 'Generic' }
  ]);
  const q = (t2, al) => m.match(t2, al, 'X');
  check(q('A20N', 'AEE').livery === 'Aegean Airlines' && q('A20N', 'AEE').quality === 'exact', 'exact type and airline match');
  check(q('B738', 'RYR').quality === 'exact', 'Ryanair 737-800 found from its livery name');
  check(q('A20N', 'WZZ').title.includes('A320neo') && q('A20N', 'WZZ').quality === 'type', 'same type with another livery');
  check(q('A21N', 'AEE').livery === 'Aegean Airlines', 'similar aircraft keeps the airline livery');
  check(q('DH8D', 'OAL').title.includes('ATR'), 'Dash 8 falls back to the ATR');
  check(q('B77W', 'UAE').title.includes('787'), 'widebody falls back to a widebody');

  const pkt = rrefPacket(5, 3, 'sim/flightmodel/position/true_psi');
  check(pkt.length === 413 && pkt.toString('ascii', 0, 4) === 'RREF' && pkt.readInt32LE(9) === 3, 'X-Plane subscription packet layout');
  const resp = Buffer.alloc(5 + 16); resp.write('RREF,', 0, 'ascii'); resp.writeInt32LE(0, 5); resp.writeFloatLE(37.9, 9); resp.writeInt32LE(3, 13); resp.writeFloatLE(36.5, 17);
  const v = parseRref(resp);
  check(Math.abs(v[0] - 37.9) < 1e-4 && Math.abs(v[3] - 36.5) < 1e-4, 'X-Plane data packet parsing');
}

// A pretend X-Plane (answers RREF subscriptions) and a pretend Airwave plugin (receives traffic, replies with status).
async function xplaneLoop() {
  const dgram = require('dgram');
  const { XPlaneAdapter } = require('../pilot-client/lib/xplane');
  const fakeXp = dgram.createSocket('udp4'), fakePlugin = dgram.createSocket('udp4');
  const subs = new Set(); let lines = [];
  fakeXp.on('message', (m, r) => {
    if (m.toString('ascii', 0, 4) !== 'RREF') return;
    subs.add(m.readInt32LE(9));
    const out = Buffer.alloc(5 + 8 * 3); out.write('RREF,', 0, 'ascii');
    [[0, 37.9364], [1, 23.9445], [3, 36.5]].forEach(([i, v], k) => { out.writeInt32LE(i, 5 + k * 8); out.writeFloatLE(v, 9 + k * 8); });
    fakeXp.send(out, r.port, r.address);
  });
  fakePlugin.on('message', (m, r) => {
    const text = m.toString('utf8');
    if (!text.startsWith('AWTR')) return;
    lines = text.split('\n').slice(1).filter(Boolean);
    fakePlugin.send(Buffer.from('AWXP ' + JSON.stringify({ models: 123, aircraft: lines.length, matches: [] })), r.port, r.address);
  });
  await new Promise(r => fakeXp.bind(0, '127.0.0.1', r));
  await new Promise(r => fakePlugin.bind(0, '127.0.0.1', r));
  const xp = new XPlaneAdapter({ port: fakeXp.address().port, pluginPort: fakePlugin.address().port });
  let pos = null, plugin = null;
  xp.on('position', p => { pos = p; }); xp.on('plugin', p => { plugin = p; });
  xp.start();
  const tm = new TrafficManager();
  tm.on('add', a => xp.add(a));
  tm.update([{ cs: 'AEE602', type: 'A20N', lat: 38, lon: 24, alt: 9000, hdg: 200, gs: 260, vs: -800 }]);
  await new Promise(r => setTimeout(r, 400));
  xp.render(a => tm.stateAt(a));
  await new Promise(r => setTimeout(r, 400));
  check(subs.size === 11, 'X-Plane adapter subscribes to all 11 datarefs');
  check(pos && Math.abs(pos.lat - 37.9364) < 1e-4 && Math.round(pos.hdg) === 37, 'X-Plane adapter reads position and heading');
  check(lines.length === 1 && lines[0].split('|').length === 13 && lines[0].startsWith('AEE602|A20N|AEE|'), 'traffic line sent to the plugin in the agreed format');
  check(plugin && plugin.models === 123, 'plugin status (CSL model count) comes back to Airwave Pilot');
  xp.stop(); fakeXp.close(); fakePlugin.close();
}

async function e2e() {
  const cfg = path.join(os.tmpdir(), 'airwave-pilot-test.json');
  fs.writeFileSync(cfg, JSON.stringify({ server: 'ws://localhost:8080/ws', callsign: 'TST777', type: 'A20N', sim: 'demo', autoTune: true, fp: { dep: 'LGAV', arr: 'LGTS', route: 'DCT', cruise: 30000 } }));
  const pilot = spawn(process.execPath, [path.join(__dirname, '..', 'pilot-client', 'pilot.js')], { env: Object.assign({}, process.env, { AIRWAVE_PILOT_CONFIG: cfg, AIRWAVE_PILOT_PORT: '18090' }) });
  let out = ''; pilot.stdout.on('data', d => { out += d; });
  try {
    await wait(1200);
    const ui = new WebSocket('ws://127.0.0.1:18090/ui');
    let last = null; ui.on('message', d => { const m = JSON.parse(d); if (m.t === 'state') last = m; });
    await new Promise(r => ui.on('open', r));
    ui.send(JSON.stringify({ t: 'connect' }));
    const atc = new WebSocket('ws://localhost:8080/ws'); const heard = [];
    atc.on('message', d => heard.push(JSON.parse(d)));
    await new Promise(r => atc.on('open', r));
    atc.send(JSON.stringify({ t: 'hello', role: 'atc', callsign: 'TEST_APP', facility: 'LGAV_APP' }));
    await wait(3500);
    check(last && last.net === 'online', 'pilot client connects to the server (' + (last && last.netText) + ')');
    const tr = [...heard].reverse().find(m => m.t === 'traffic');
    const me = tr && tr.traffic.find(a => a.cs === 'TST777');
    check(!!me && me.fp.arr === 'LGTS' && me.type === 'A20N', 'controller sees the pilot with type and flight plan');
    check(last && last.traffic > 0 && last.stats.shown > 0, 'pilot client receives and draws traffic (' + (last && last.traffic) + ' aircraft)');
    ui.send(JSON.stringify({ t: 'tune', freq: '126.575' }));
    atc.send(JSON.stringify({ t: 'instr', to: 'TST777', kind: 'hdg', value: 180, dir: 'R' }));
    await wait(1500);
    check(last && last.lastInstr && /heading 180/.test(last.lastInstr.text), 'pilot client shows the ATC instruction');
    ui.send(JSON.stringify({ t: 'readback' }));
    await wait(16000);
    check(heard.some(m => m.t === 'msg' && m.from === 'TST777' && /Turn right heading 180, TST777/.test(m.text)), 'read back reaches the controller');
    const tr2 = [...heard].reverse().find(m => m.t === 'traffic');
    const me2 = tr2 && tr2.traffic.find(a => a.cs === 'TST777');
    check(me2 && me2.hdg > 70 && me2.hdg <= 180, 'demo aircraft is turning right toward heading 180 (now ' + (me2 && me2.hdg) + ', started at 040)');
    ui.send(JSON.stringify({ t: 'disconnect' })); atc.close(); ui.close();
  } finally {
    pilot.kill(); fs.unlinkSync(cfg);
  }
}

unitTests();
xplaneLoop().then(e2e).then(() => { console.log(failed ? failed + ' check(s) failed' : 'All checks passed'); process.exit(failed ? 1 : 0); })
  .catch(e => { console.error('Test could not run: ' + e.message); process.exit(1); });
