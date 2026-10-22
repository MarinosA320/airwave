#!/usr/bin/env node
/*
 * End-to-end check against a running server:
 *   node tools/test-client.js [ws://localhost:8080/ws]
 * Connects a controller and a test pilot, then checks traffic, instructions, readbacks and errors.
 */
'use strict';
const WebSocket = require('ws');
const url = process.argv[2] || 'ws://localhost:8080/ws';
const wait = ms => new Promise(r => setTimeout(r, ms));

function client(hello) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const c = { ws, msgs: [], send: m => ws.send(JSON.stringify(m)) };
    ws.on('message', d => c.msgs.push(JSON.parse(d)));
    ws.on('open', () => { c.send(hello); resolve(c); });
    ws.on('error', reject);
  });
}

(async () => {
  let failed = 0;
  const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failed++; };

  const atc = await client({ t: 'hello', role: 'atc', callsign: 'TEST_CTR', facility: 'LGGG_CTR' });
  const pilot = await client({ t: 'hello', role: 'pilot', callsign: 'TST123', aircraft: 'A320' });
  pilot.send({ t: 'fp', dep: 'EGLL', arr: 'LGAV', route: 'DCT', cruise: 36000 });
  pilot.send({ t: 'pos', lat: 38.3, lon: 23.6, alt: 12000, hdg: 250, gs: 300, vs: -1000, squawk: '4521' });
  await wait(2300);

  check(atc.msgs.some(m => m.t === 'welcome' && m.callsign === 'TEST_CTR'), 'controller receives welcome');
  const traffic = [...atc.msgs].reverse().find(m => m.t === 'traffic');
  check(traffic && traffic.traffic.length > 1, 'controller sees traffic (' + (traffic ? traffic.traffic.length : 0) + ' aircraft)');
  check(traffic && traffic.traffic.some(a => a.cs === 'TST123' && a.fp.arr === 'LGAV'), 'controller sees the test pilot with its flight plan');
  const pTraffic = [...pilot.msgs].reverse().find(m => m.t === 'traffic');
  check(pTraffic && pTraffic.atc.some(c => c.cs === 'TEST_CTR'), 'pilot sees the online controller');

  const bot = traffic.traffic.find(a => a.bot);
  atc.send({ t: 'assume', to: bot.cs });
  atc.send({ t: 'instr', to: bot.cs, kind: 'hdg', value: 90, dir: 'R' });
  atc.send({ t: 'instr', to: 'TST123', kind: 'alt', value: 8000 });
  await wait(5000);
  check(pilot.msgs.some(m => m.t === 'instr' && m.kind === 'alt' && m.value === 8000), 'pilot receives altitude instruction');
  check(atc.msgs.some(m => m.t === 'msg' && m.from === bot.cs && /heading 090/.test(m.text)), 'simulated pilot reads back the heading');
  const later = [...atc.msgs].reverse().find(m => m.t === 'traffic').traffic.find(a => a.cs === bot.cs);
  check(later && later.owner === 'TEST_CTR' && later.cleared.hdg === 90, 'ownership and cleared heading are tracked');

  atc.send({ t: 'instr', to: 'NOPE99', kind: 'hdg', value: 90 });
  pilot.send({ t: 'instr', to: bot.cs, kind: 'hdg', value: 90 });
  await wait(400);
  check(atc.msgs.some(m => m.t === 'error' && /not connected/.test(m.text)), 'unknown callsign is rejected');
  check(pilot.msgs.some(m => m.t === 'error' && /Only controllers/.test(m.text)), 'pilots cannot give instructions');

  const dup = await client({ t: 'hello', role: 'pilot', callsign: 'TST123' });
  await wait(300);
  check(dup.msgs.some(m => m.t === 'error' && /in use/.test(m.text)), 'duplicate callsign is rejected');

  [atc, pilot, dup].forEach(c => c.ws.close());
  console.log(failed ? failed + ' check(s) failed' : 'All checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('Could not run tests: ' + e.message); process.exit(1); });
