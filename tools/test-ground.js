#!/usr/bin/env node
// Simulated traffic on the ground: stands, pushback, taxi, take-off, landing roll-out, taxi-in, and the
// radio exchange with controllers (clearance, start-up, taxi, ready, landing, vacated) plus pilot requests.
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('../shared/airwave-core.js');

let failed = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failed++; };
const ROOT = path.join(__dirname, '..');
function greece() {
  const map = A.registerMap(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'greece.json'), 'utf8')));
  for (const ap of map.airports) {
    const f = path.join(ROOT, 'data', 'layouts', ap.icao + '.json');
    if (fs.existsSync(f)) { Object.defineProperty(ap, 'ground', { value: JSON.parse(fs.readFileSync(f, 'utf8')), enumerable: false, configurable: true, writable: true }); A.refineRunways(ap); }
  }
  return map;
}
if (!fs.existsSync(path.join(ROOT, 'data', 'layouts', 'LGAV.json'))) { console.log('SKIP no airport layouts in data/layouts (run the Airport layouts workflow)'); process.exit(0); }

// 1. No controllers: traffic lands, rolls out, taxis to stands; departures push back, taxi and take off.
{
  const events = [];
  const hub = new A.Hub({ sector: greece(), log: m => events.push(m) });
  const src = hub.addSource(new A.SimTrafficSource({ count: 30, seed: 7 }));
  let airborneVanish = 0, onRunwayOk = true;
  for (let t = 0; t < 5400; t++) {
    hub.tick(1);
    for (const p of src.pilots) if (p.done && p.phase === 'air' && p.arriving && A.geo.distNm(p, p.geo.thr) < 20) airborneVanish++;
  }
  const n = re => events.filter(e => re.test(e)).length;
  check(n(/ landed at /) >= 30, 'arrivals land (' + n(/ landed at /) + ' in 90 minutes)');
  check(n(/ parked at /) >= 20, 'arrivals taxi to a stand and park (' + n(/ parked at /) + ')');
  check(n(/ taking off /) >= 15, 'departures push back, taxi and take off (' + n(/ taking off /) + ')');
  check(airborneVanish === 0, 'no arrival disappears in the air near its airport');
  check(n(/ran out of runway/) === 0, 'nobody runs off the end of the runway');
  check(onRunwayOk, 'ok');
}

// 2. With Delivery, Ground and Tower at Athens answering every request.
{
  const events = [];
  const hub = new A.Hub({ sector: greece(), log: m => events.push(m) });
  const reqs = [];
  const atc = {};
  for (const id of ['LGAV_DEL', 'LGAV_GND', 'LGAV_TWR', 'LGAV_APP']) {
    const s = hub.connect(m => { if (m.t === 'req') reqs.push(Object.assign({ atc: id }, m)); });
    s.receive({ t: 'hello', role: 'atc', callsign: id, facility: id });
    atc[id] = s;
  }
  const src = hub.addSource(new A.SimTrafficSource({ count: 30, seed: 3 }));
  const answered = new Set(), sent = [];
  for (let t = 0; t < 4800; t++) {
    hub.tick(1);
    for (const r of reqs.splice(0)) {
      if (answered.has(r.from + r.id)) continue;
      answered.add(r.from + r.id);
      const c = atc[r.atc];
      const instr = { ifr: { kind: 'clearance', value: { type: 'IFR' } }, startup: { kind: 'pushback', value: '' }, taxi: { kind: 'taxi', value: { to: 'HP' } },
        ready: { kind: 'takeoff' }, established: { kind: 'land' }, vacated: { kind: 'taxi', value: { to: 'STAND' } }, higher: { kind: 'alt', value: 24000 } }[r.kind];
      if (instr) { c.receive(Object.assign({ t: 'instr', to: r.from }, instr)); sent.push(r.kind); }
    }
  }
  const kinds = new Set(sent);
  for (const k of ['ifr', 'startup', 'taxi', 'ready', 'established', 'vacated']) check(kinds.has(k), 'simulated pilots ask the controller: ' + k);
  const n = re => events.filter(e => re.test(e)).length;
  check(n(/ taking off from LGAV/) >= 2, 'LGAV departures wait for and use the take-off clearance (' + n(/ taking off from LGAV/) + ')');
  check(n(/ landed at LGAV/) >= 2, 'LGAV arrivals land with a landing clearance (' + n(/ landed at LGAV/) + ')');
  check(n(/going around at LGAV/) === 0, 'no go-arounds when every landing is cleared');
}

// 3. No landing clearance means a go-around.
{
  const events = [];
  const hub = new A.Hub({ sector: greece(), log: m => events.push(m) });
  const twr = hub.connect(() => {}); twr.receive({ t: 'hello', role: 'atc', callsign: 'LGAV_TWR', facility: 'LGAV_TWR' });
  const app = hub.connect(() => {}); app.receive({ t: 'hello', role: 'atc', callsign: 'LGAV_APP', facility: 'LGAV_APP' });
  hub.addSource(new A.SimTrafficSource({ count: 30, seed: 5 }));
  for (let t = 0; t < 3600; t++) hub.tick(1);
  check(events.some(e => /going around at LGAV/.test(e)), 'an arrival without landing clearance goes around');
  check(!events.some(e => / landed at LGAV/.test(e)), 'nobody lands at LGAV without a clearance');
}

// 4. Human pilot requests and controller instructions.
{
  const hub = new A.Hub({ sector: greece() });
  const atcMsgs = [], pilotMsgs = [];
  const c = hub.connect(m => atcMsgs.push(m)); c.receive({ t: 'hello', role: 'atc', callsign: 'LGAV_DEL', facility: 'LGAV_DEL' });
  const p = hub.connect(m => pilotMsgs.push(m)); p.receive({ t: 'hello', role: 'pilot', callsign: 'AEE602', aircraft: 'A20N' });
  p.receive({ t: 'fp', dep: 'LGAV', arr: 'LGTS', route: 'KEA', cruise: 24000 });
  p.receive({ t: 'pos', lat: 37.9364, lon: 23.9445, alt: 308, hdg: 30, gs: 0, onGround: true });
  p.receive({ t: 'tune', freq: c.freq });
  p.receive({ t: 'req', kind: 'ifr', value: 'LGTS', stand: 'B12' });
  const r = atcMsgs.find(m => m.t === 'req');
  check(r && r.kind === 'ifr' && /Athinai Delivery, AEE602, stand B12, information [A-Z][a-z]+, request IFR clearance to LGTS/.test(r.text), 'IFR clearance request reaches the controller: ' + (r && r.text));
  check(hub.snapshot().find(a => a.cs === 'AEE602').req.kind === 'ifr', 'pending request shows on the scope');
  const sid = A.proceduresFor(hub.airport('LGAV'), 'SID')[0].name;
  c.receive({ t: 'instr', to: 'AEE602', kind: 'clearance', value: { type: 'IFR', dest: 'LGTS', sid, alt: 'FL60' } });
  const i = pilotMsgs.filter(m => m.t === 'instr').pop();
  check(i && new RegExp('cleared to LGTS via ' + sid + ' departure.*climb initially (flight level 60|altitude 6000 feet), squawk [0-7]{4}').test(i.text), 'IFR clearance phrase: ' + (i && i.text));
  check(!hub.snapshot().find(a => a.cs === 'AEE602').req, 'the clearance answers the request');
  p.receive({ t: 'req', kind: 'unable', value: 'due to performance' });
  check(atcMsgs.filter(m => m.t === 'msg').pop().text === 'AEE602, unable due to performance', 'unable with a reason');
  p.receive({ t: 'req', kind: 'higher', value: 'FL240' });
  check(/request climb flight level 240/.test(atcMsgs.filter(m => m.t === 'msg').pop().text), 'climb request');
  p.receive({ t: 'req', kind: 'confirmspeed' });
  check(/confirm no speed restriction/.test(atcMsgs.filter(m => m.t === 'msg').pop().text), 'confirm no speed restriction');
  p.receive({ t: 'req', kind: 'mayday', value: 'engine fire' });
  check(hub.snapshot().find(a => a.cs === 'AEE602').emergency === 'MAYDAY', 'MAYDAY marks the aircraft as an emergency');
  for (const [kind, value, re] of [['takeoff', '03R', /wind .*knots, runway 03R, cleared for take-off/], ['lineup', '03L', /runway 03L, line up and wait/], ['land', '03R', /runway 03R, cleared to land/],
    ['goaround', null, /go around, I say again, go around, fly published missed approach/], ['holdshort', '03L', /hold short of runway 03L/], ['pushback', 'south', /push back and start up approved, facing SOUTH/],
    ['text', 'expect a short delay', /expect a short delay/], ['clearance', { type: 'VFR', dest: 'LGMG', alt: 3500 }, /cleared VFR to LGMG, not above altitude 3500 feet, squawk/]]) {
    c.receive({ t: 'instr', to: 'AEE602', kind, value });
    const last = pilotMsgs.filter(m => m.t === 'instr').pop();
    check(last && re.test(last.text), kind + ': ' + (last && last.text));
  }
  // ATIS
  const atis = hub.atisFor('LGAV');
  check(atis.freq === '136.125' && /^Athinai information [A-Z][a-z]+.*Expect .*runway 03R.*QNH \d{3,4}.*Advise on initial contact/.test(atis.text), 'LGAV ATIS: ' + atis.text);
  hub.updateAtis();
  const before = hub.atisFor('LGAV').letter;
  c.receive({ t: 'runways', icao: 'LGAV', arr: ['03L'], dep: ['03R'] });
  hub.updateAtis();
  check(hub.atisFor('LGAV').letter !== before, 'a runway change brings a new ATIS letter');
  pilotMsgs.length = 0;
  p.receive({ t: 'tune', freq: '136.125' });
  check(pilotMsgs.some(m => m.t === 'msg' && m.atis && /Landing runway 03L, departure runway 03R/.test(m.text)), 'tuning the ATIS frequency plays it');
  hub.setWeather('LGAV', { raw: 'LGAV 231250Z 34015G25KT 9999 FEW030 22/11 Q1012', wdir: 340, wspd: 15, wgst: 25, visib: 10, qnh: 1012, temp: 22, dewp: 11, clouds: [{ cover: 'FEW', base: 3000 }] });
  check(/Wind 340 degrees 15 knots gusting 25.*Few 3000 feet.*QNH 1012/.test(hub.atisFor('LGAV').text), 'ATIS uses the real METAR');
  // Voice goes to the same frequency only, not back to the speaker.
  const q = hub.connect(m => pilotMsgs.push(Object.assign({ to: 'Q' }, m))); q.receive({ t: 'hello', role: 'pilot', callsign: 'SEH100', aircraft: 'A20N' }); q.receive({ t: 'tune', freq: '136.125' });
  const heardBy = []; const z = hub.connect(m => { if (m.t === 'voice') heardBy.push('Z'); }); z.receive({ t: 'hello', role: 'pilot', callsign: 'ZZZ1', aircraft: 'A20N' }); z.receive({ t: 'tune', freq: '121.500' });
  pilotMsgs.length = 0;
  p.receive({ t: 'voice', seq: 1, data: 'AAAA' });
  check(pilotMsgs.some(m => m.to === 'Q' && m.t === 'voice' && m.from === 'AEE602') && !heardBy.length && !pilotMsgs.some(m => !m.to && m.t === 'voice'), 'voice reaches others on the frequency only');
}

console.log(failed ? failed + ' check(s) failed' : 'All checks passed');
process.exit(failed ? 1 : 0);
