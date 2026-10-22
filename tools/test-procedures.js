#!/usr/bin/env node
/*
 * Checks that simulated pilots fly STARs, approaches and SIDs, and that controllers can clear them.
 * Uses MADE-UP test procedures at LGAV (names start with TEST). They are not real procedures.
 *   node tools/test-procedures.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('../shared/airwave-core.js');

const greece = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'greece.json'), 'utf8'));
const lgav = JSON.parse(JSON.stringify(greece.airports.find(a => a.icao === 'LGAV')));
const rwy = A.activeRunway(lgav);
const g = A.runwayGeometry(rwy);
const P = (id, p) => Object.assign({ id }, p);
lgav.waypoints = [
  P('TSTNO', { lat: 38.95, lon: 23.70 }), P('TSTEA', { lat: 37.95, lon: 24.35 }),
  P('TSTIF', A.geo.move(g.thr, g.recip, 12)), P('TSTFF', A.geo.move(g.thr, g.recip, 7)),
  P('TSTD1', A.geo.move(g.end, rwy.hdg, 8)), P('TSTD2', { lat: 38.60, lon: 24.70 })
];
lgav.procedures = [
  { type: 'STAR', name: 'TEST1A', runway: rwy.id, legs: [{ fix: 'TSTNO', alt: 13000, altType: 'above' }, { fix: 'TSTEA', alt: 7000, altType: 'at', spd: 220 }, { fix: 'TSTIF' }] },
  { type: 'APP', name: 'ILS ' + rwy.id + ' TEST', approach: 'ILS', runway: rwy.id, legs: [{ fix: 'TSTIF', alt: 4000 }, { fix: 'TSTFF', alt: 3000, faf: true }] },
  { type: 'SID', name: 'TEST1D', runway: rwy.id, legs: [{ fix: 'TSTD1', alt: 4000, altType: 'above' }, { fix: 'TSTD2', alt: 9000 }] }
];
const map = A.registerMap(Object.assign({}, greece, { id: 'TEST-LGAV', airports: [lgav] }));

let failed = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failed++; };

const events = [];
const hub = new A.Hub({ sector: map, log: m => events.push(m) });
const src = hub.addSource(new A.SimTrafficSource({ count: 6, seed: 5 }));
const heard = [];
const atc = hub.connect(m => { if (m.t === 'msg' || m.t === 'error') heard.push(m); });
atc.receive({ t: 'hello', role: 'atc', callsign: 'LGAV_APP', facility: 'LGAV_APP' });

const arrivals = src.pilots.filter(p => p.arriving);
const deps = src.pilots.filter(p => !p.arriving);
check(arrivals.length > 0 && arrivals.every(p => p.procName === 'TEST1A'), 'arrivals are given the STAR (' + arrivals.length + ')');
check(deps.length > 0 && deps.every(p => p.procName === 'TEST1D' && p.initialClimb === 9000), 'departures are given the SID with its top altitude (' + deps.length + ')');

const visited = new Map();
for (let i = 0; i < 4000; i++) {
  hub.tick(1);
  for (const p of src.pilots) {
    const w = p.route[p.wp - 1];
    if (w) { const s = visited.get(p.cs) || new Set(); s.add(w.id); visited.set(p.cs, s); }
  }
}
const firstArr = arrivals[0].cs, firstDep = deps[0].cs;
check(['TSTNO', 'TSTEA', 'TSTIF'].every(id => (visited.get(firstArr) || new Set()).has(id)) || ['TSTEA', 'TSTIF'].every(id => (visited.get(firstArr) || new Set()).has(id)), firstArr + ' flew the STAR waypoints');
check(events.some(e => e.startsWith(firstArr + ' landed')), firstArr + ' landed after the approach');
check((visited.get(firstDep) || new Set()).has('TSTD1'), firstDep + ' flew the SID');

// Controller clears a STAR and an approach.
const arr = src.pilots.find(p => p.arriving && p.mode !== 'final');
if (arr) {
  atc.receive({ t: 'instr', to: arr.cs, kind: 'star', value: 'TEST1A' });
  atc.receive({ t: 'instr', to: arr.cs, kind: 'ils' });
  atc.receive({ t: 'instr', to: arr.cs, kind: 'star', value: 'NOPE1A' });
  for (let i = 0; i < 6; i++) hub.tick(1);
  check(heard.some(m => m.from === 'LGAV_APP' && /cleared TEST1A arrival/.test(m.text)), 'controller can clear a STAR');
  check(heard.some(m => m.from === 'LGAV_APP' && /cleared ILS approach runway/.test(m.text)), 'approach clearance names the ILS');
  check(heard.some(m => m.from === arr.cs && /Cleared ILS approach/.test(m.text)), 'pilot reads back the approach clearance');
  check(heard.some(m => m.t === 'error' && /no STAR called NOPE1A/.test(m.text)), 'unknown STAR is rejected');
} else check(false, 'found an arrival to clear');

console.log(failed ? failed + ' check(s) failed' : 'All checks passed');
process.exit(failed ? 1 : 0);
