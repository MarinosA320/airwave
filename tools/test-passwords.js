#!/usr/bin/env node
// Checks network and ATC passwords, and that simulated traffic still runs when they are set.
'use strict';
const A = require('../shared/airwave-core.js');
let failed = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failed++; };
const hub = new A.Hub({ password: 'net-pw', atcPassword: 'atc-pw' });
hub.addSource(new A.SimTrafficSource({ count: 5, seed: 3 }));
hub.tick(1);
check(hub.pilots().length === 5, 'simulated pilots run with passwords set (' + hub.pilots().length + ')');
const hello = h => { const out = []; const s = hub.connect(m => out.push(m)); s.receive(h); return out[0]; };
check(hello({ t: 'hello', role: 'pilot', callsign: 'P1' }).t === 'error', 'pilot without password is refused');
check(hello({ t: 'hello', role: 'pilot', callsign: 'P2', password: 'net-pw' }).t === 'welcome', 'pilot with the network password joins');
check(hello({ t: 'hello', role: 'atc', callsign: 'C1', facility: 'LON_CTR', password: 'net-pw' }).t === 'error', 'controller with only the network password is refused');
check(hello({ t: 'hello', role: 'atc', callsign: 'C2', facility: 'LON_CTR', password: 'atc-pw' }).t === 'welcome', 'controller with the ATC password joins');
console.log(failed ? failed + ' check(s) failed' : 'All checks passed');
process.exit(failed ? 1 : 0);
