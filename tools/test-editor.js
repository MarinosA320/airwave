#!/usr/bin/env node
// Starts a server on the Greek map, saves a map edit through /editor/save, and checks the map, runway setup and live hub pick it up.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');
const A = require('../shared/airwave-core.js');

let failed = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failed++; };
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = 'http://127.0.0.1:' + PORT;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airwave-ov-'));
const OV = path.relative(path.join(__dirname, '..'), path.join(tmp, 'overlay.json'));

// Core: overlay merge and runway config without a server
{
  const base = A.registerMap(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'greece.json'), 'utf8')));
  const m = A.applyOverlay(base, { rev: 3, fixes: { upsert: [{ id: 'TESTX', kind: 'wpt', lat: 38, lon: 24 }], remove: ['KEA'] }, airports: { LGAV: { runwayConfig: { arr: ['03L', '03R'], dep: ['03R'] } } } });
  A.registerMap(m);
  check(m.fixIndex.get('TESTX') && !m.fixes.some(f => f.id === 'KEA'), 'overlay adds and removes waypoints');
  check(base.fixes.some(f => f.id === 'KEA'), 'overlay leaves the base map untouched');
  const ap = m.airports.find(a => a.icao === 'LGAV');
  check(A.runwaysInUse(ap, 'arr').map(r => r.id).join() === '03L,03R', 'default runway config from the overlay');
  check(A.runwayEnd(ap, '21L') && Math.abs(A.runwayEnd(ap, '21L').hdg - A.runwayEnd(ap, '03R').hdg) > 170, 'reciprocal runway end');
}

const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
  env: Object.assign({}, process.env, { PORT: String(PORT), AIRWAVE_MAP: 'greece', AIRWAVE_BOTS: '4', AIRWAVE_ATC_PASSWORD: 'atc', AIRWAVE_EDITOR_PASSWORD: 'edit', AIRWAVE_OVERLAY: OV, GITHUB_TOKEN: '', GITHUB_REPO: '', RENDER_GIT_REPO_SLUG: '' }),
  stdio: ['ignore', 'pipe', 'pipe']
});
let out = ''; srv.stdout.on('data', d => { out += d; }); srv.stderr.on('data', d => { out += d; });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const post = (body) => fetch(BASE + '/editor/save', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

(async () => {
  for (let i = 0; i < 50 && !/listening|Sector editor/i.test(out); i++) await sleep(100);
  const page = await fetch(BASE + '/editor').then(r => r.text());
  check(page.includes('AIRWAVE_EDITOR') && page.includes('Sector editor'), 'editor page is served');
  const map0 = await fetch(BASE + '/map.json').then(r => r.json());

  // a controller connects to see live updates
  const msgs = [];
  const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
  ws.on('message', d => msgs.push(JSON.parse(d)));
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'hello', role: 'atc', callsign: 'LGAV_APP', facility: 'LGAV_APP', password: 'atc' }));
  await sleep(400);
  const welcome = msgs.find(m => m.t === 'welcome');
  check(welcome && welcome.runways, 'welcome includes runway setup');

  const sectors = map0.sectors.slice(); sectors[0] = Object.assign({}, sectors[0], { name: 'Edited sector' });
  const overlay = {
    sectors, fixes: { upsert: [{ id: 'EDITX', kind: 'wpt', lat: 37.5, lon: 23.5 }], remove: [] },
    airports: { LGAV: { runwayConfig: { arr: ['03L'], dep: ['03R'] }, layout: { taxiways: [{ ref: 'Z', kind: 'taxiway', line: [[37.93, 23.94], [37.94, 23.95]] }], aprons: [], stands: [{ ref: '999', lat: 37.935, lon: 23.945 }], gates: [], holding: [], terminals: [], runways: [] } } }
  };
  check((await post({ password: 'wrong', by: 'test', baseRev: 0, overlay })).status === 403, 'wrong editor password is refused');
  check((await post({ password: 'edit', by: 'test', baseRev: 0, overlay: { sectors: [{ id: 'X', polygon: [[1, 1]] }] } })).status === 400, 'bad sector is refused');
  const r1 = await post({ password: 'edit', by: 'test', baseRev: 0, overlay });
  check(r1.status === 200 && r1.body.rev === 1, 'save accepted as revision 1');
  check((await post({ password: 'edit', by: 'test', baseRev: 0, overlay })).status === 409, 'stale save is refused');
  const map1 = await fetch(BASE + '/map.json').then(r => r.json());
  check(map1.sectors[0].name === 'Edited sector' && map1.fixes.some(f => f.id === 'EDITX'), 'map.json shows the edit');
  const lay = await fetch(BASE + '/layouts/LGAV.json').then(r => r.json());
  check(lay.stands && lay.stands[0].ref === '999', 'edited ground layout is served');
  const st = await fetch(BASE + '/status').then(r => r.json());
  check(st.mapRev === 1, 'status reports map revision');
  await sleep(300);
  check(msgs.some(m => m.t === 'map' && m.rev === 1), 'controllers are told the map changed');
  check(fs.existsSync(path.join(tmp, 'overlay.json')), 'edit written to disk');

  // controller changes runways live
  ws.send(JSON.stringify({ t: 'runways', icao: 'LGAV', arr: ['03R', '03L'], dep: ['03L'] }));
  await sleep(400);
  const rw = msgs.filter(m => m.t === 'runways').pop();
  check(rw && rw.cfg && rw.cfg.LGAV && rw.cfg.LGAV.dep.join() === '03L', 'controller can change runways in use');
  ws.close(); srv.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? failed + ' check(s) failed' : 'All checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); console.error(out); srv.kill(); process.exit(1); });
