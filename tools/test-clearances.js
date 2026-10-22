#!/usr/bin/env node
// Squawk, SID, chosen approach and taxi clearances, plus magnetic bearings.
// Uses MADE-UP procedures at LGAV (names start with TEST); they are not real.
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('../shared/airwave-core.js');
let failed = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failed++; };

const greece = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'greece.json'), 'utf8'));
const lgav = JSON.parse(JSON.stringify(greece.airports.find(a => a.icao === 'LGAV')));
const rwy = A.activeRunway(lgav), g = A.runwayGeometry(rwy);
lgav.waypoints = [
  Object.assign({ id: 'TSTD1' }, A.geo.move(g.end, rwy.hdg, 8)), { id: 'TSTD2', lat: 38.6, lon: 24.7 },
  Object.assign({ id: 'TSTR1' }, A.geo.move(g.thr, g.recip, 14)), Object.assign({ id: 'TSTR2' }, A.geo.move(g.thr, g.recip, 7))
];
lgav.procedures = [
  { type: 'SID', name: 'TEST2D', runway: rwy.id, legs: [{ fix: 'TSTD1', alt: 5000, altType: 'above' }, { fix: 'TSTD2', alt: 11000 }] },
  { type: 'APP', name: 'ILS Z RWY ' + rwy.id, approach: 'ILS', runway: rwy.id, legs: [{ fix: 'TSTR1', alt: 4000 }, { fix: 'TSTR2', alt: 3000, faf: true }] },
  { type: 'APP', name: 'RNP Y RWY ' + rwy.id, approach: 'RNAV', runway: rwy.id, legs: [{ fix: 'TSTR1', alt: 4000 }, { fix: 'TSTR2', alt: 3000, faf: true }] }
];
const map = A.registerMap(Object.assign({}, greece, { id: 'TEST-CLR', airports: [lgav] }));

// Magnetic bearings: true 090 with ~5 E variation is ~085 magnetic
const mb = A.magBearing(map, { lat: 37.9, lon: 23.9 }, { lat: 37.9, lon: 24.6 });
check(mb > 83.5 && mb < 86.5, 'magnetic bearing applies the ~5°E variation (' + mb.toFixed(1) + '°)');

const hub = new A.Hub({ sector: map });
const src = hub.addSource(new A.SimTrafficSource({ count: 6, seed: 9 }));
const heard = [];
const atc = hub.connect(m => { if (m.t === 'msg' || m.t === 'error') heard.push(m); });
atc.receive({ t: 'hello', role: 'atc', callsign: 'LGAV_APP', facility: 'LGAV_APP' });
const said = re => heard.some(m => re.test(m.text));

// Squawks: automatic codes are unique and valid
const all = src.pilots.map(p => p.cs);
all.forEach(cs => atc.receive({ t: 'instr', to: cs, kind: 'squawk', value: 'AUTO' }));
for (let i = 0; i < 6; i++) hub.tick(1);
const codes = hub.snapshot().map(a => a.cleared.sq);
check(codes.every(c => /^[0-7]{4}$/.test(c)) && new Set(codes).size === codes.length, 'automatic squawks are valid and unique (' + codes.join(' ') + ')');
check(hub.snapshot().every(a => a.sq === a.cleared.sq), 'simulated pilots set the squawk they were given');

// SID for a departure
const dep = src.pilots.find(p => !p.arriving);
atc.receive({ t: 'instr', to: dep.cs, kind: 'sid', value: 'TEST2D' });
for (let i = 0; i < 4; i++) hub.tick(1);
check(said(new RegExp(dep.cs + ', cleared TEST2D departure')), 'SID clearance is phrased correctly');
check(dep.route.some(w => w.id === 'TSTD1') && dep.initialClimb === 11000, 'departure follows the SID and its top altitude');

// A chosen approach, not the default
const arr = src.pilots.find(p => p.arriving);
atc.receive({ t: 'instr', to: arr.cs, kind: 'ils', value: 'RNP Y RWY ' + rwy.id });
for (let i = 0; i < 4; i++) hub.tick(1);
check(said(new RegExp('cleared RNP approach runway ' + rwy.id)), 'chosen RNP approach is cleared by name');
check(hub.snapshot().find(a => a.cs === arr.cs).cleared.app === 'RNP Y RWY ' + rwy.id, 'chosen approach is recorded for the strip');

// Taxi
atc.receive({ t: 'instr', to: dep.cs, kind: 'taxi', value: { to: 'STAND 204', via: ['B', 'A2'] } });
atc.receive({ t: 'instr', to: dep.cs, kind: 'taxi', value: { to: 'HP 03R', via: ['A$'] } });
for (let i = 0; i < 4; i++) hub.tick(1);
check(said(/taxi to stand 204 via B, A2/), 'taxi clearance to a stand');
check(heard.some(m => m.t === 'error' && /Taxiway names/.test(m.text)), 'bad taxiway names are refused');

console.log(failed ? failed + ' check(s) failed' : 'All checks passed');
process.exit(failed ? 1 : 0);
