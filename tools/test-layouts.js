#!/usr/bin/env node
// Checks the OpenStreetMap layout converter against a small made-up Overpass response.
'use strict';
const { convert, query } = require('./fetch-layouts.js');

const sample = { elements: [
  { type: 'way', tags: { aeroway: 'taxiway', ref: 'A' }, geometry: [{ lat: 37.93, lon: 23.94 }, { lat: 37.94, lon: 23.95 }] },
  { type: 'way', tags: { aeroway: 'apron' }, geometry: [{ lat: 37.93, lon: 23.94 }, { lat: 37.931, lon: 23.94 }, { lat: 37.931, lon: 23.941 }, { lat: 37.93, lon: 23.94 }] },
  { type: 'way', tags: { aeroway: 'terminal', name: 'Main' }, geometry: [{ lat: 37.935, lon: 23.945 }, { lat: 37.936, lon: 23.945 }, { lat: 37.936, lon: 23.946 }, { lat: 37.935, lon: 23.945 }] },
  { type: 'node', tags: { aeroway: 'parking_position', ref: 'B12' }, lat: 37.9301234567, lon: 23.94 },
  { type: 'node', tags: { aeroway: 'gate', ref: 'A5' }, lat: 37.931, lon: 23.941 },
  { type: 'node', tags: { aeroway: 'holding_position', ref: 'A1' }, lat: 37.932, lon: 23.942 },
  { type: 'way', tags: { aeroway: 'parking_position', ref: '204' }, geometry: [{ lat: 37.93, lon: 23.95 }, { lat: 37.9302, lon: 23.9502 }] },
  { type: 'way', tags: { building: 'yes' }, geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] }
] };
const L = convert(sample, 'LGAV');
let failed = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failed++; };
check(L.taxiways.length === 1 && L.taxiways[0].ref === 'A', 'taxiway with its letter');
check(L.aprons.length === 1, 'apron polygon');
check(L.terminals.length === 1 && L.terminals[0].ref === 'Main', 'terminal with its name');
check(L.stands.length === 2 && L.stands.some(s => s.ref === 'B12' && s.lat === 37.930123), 'stands from points and lines, rounded');
check(L.gates.length === 1 && L.holding.length === 1, 'gates and holding points');
check(/around:\d+,37\.9/.test(query({ lat: 37.93, lon: 23.94, runways: [{ len: 2.1 }] })), 'query searches around the airport');
console.log(failed ? failed + ' check(s) failed' : 'All checks passed');
process.exit(failed ? 1 : 0);
