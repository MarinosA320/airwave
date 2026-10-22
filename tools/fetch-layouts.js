#!/usr/bin/env node
/*
 * Downloads airport ground layouts (taxiways, aprons, stands, gates, holding points, terminals)
 * from OpenStreetMap and saves them as data/layouts/<ICAO>.json for the Airwave scope.
 *
 *   node tools/fetch-layouts.js              all airports on the Greek map
 *   node tools/fetch-layouts.js LGAV LGTS    only these airports
 *   node tools/fetch-layouts.js --missing    only airports that have no layout yet (resumes an interrupted run)
 *
 * Needs Node 18 or newer and an internet connection. Uses the public Overpass API politely:
 * one request at a time with a pause between them. Layout data © OpenStreetMap contributors, ODbL.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'data', 'layouts');
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const PAUSE_MS = 3000;

const r6 = v => Math.round(v * 1e6) / 1e6;
const pt = g => [r6(g.lat), r6(g.lon)];

function centroid(geom) {
  const n = geom.length;
  return { lat: geom.reduce((s, g) => s + g.lat, 0) / n, lon: geom.reduce((s, g) => s + g.lon, 0) / n };
}

// Turns an Overpass "out geom" response into the Airwave layout format.
function convert(osm, icao) {
  const L = { icao, source: 'OpenStreetMap contributors (ODbL), https://www.openstreetmap.org/copyright', fetched: new Date().toISOString().slice(0, 10),
    runways: [], taxiways: [], aprons: [], terminals: [], stands: [], gates: [], holding: [] };
  for (const e of osm.elements || []) {
    const t = e.tags || {}, a = t.aeroway;
    if (!a) continue;
    const ref = t.ref || t.name || '';
    if (e.type === 'node') {
      const p = { ref, lat: r6(e.lat), lon: r6(e.lon) };
      if (a === 'parking_position') L.stands.push(p);
      else if (a === 'gate') L.gates.push(p);
      else if (a === 'holding_position') L.holding.push(p);
      continue;
    }
    if (e.type !== 'way' || !e.geometry || e.geometry.length < 2) continue;
    const line = e.geometry.map(pt);
    const closed = line.length > 3 && line[0][0] === line[line.length - 1][0] && line[0][1] === line[line.length - 1][1];
    if (a === 'taxiway' || a === 'taxilane') L.taxiways.push({ ref, kind: a, line });
    else if (a === 'runway' && !closed) L.runways.push({ ref, line });
    else if (a === 'apron' && closed) L.aprons.push({ ref, poly: line });
    else if ((a === 'terminal' || a === 'hangar') && closed) L.terminals.push({ ref, kind: a, poly: line });
    else if (a === 'parking_position') { const c = centroid(e.geometry); L.stands.push({ ref, lat: r6(c.lat), lon: r6(c.lon), line }); }
    else if (a === 'holding_position') { const c = centroid(e.geometry); L.holding.push({ ref, lat: r6(c.lat), lon: r6(c.lon) }); }
  }
  return L;
}

function query(ap) {
  const longest = Math.max(...ap.runways.map(r => r.len)) * 1852;
  const radius = Math.round(Math.max(2500, longest * 0.75 + 1200));
  return '[out:json][timeout:120];(' +
    `way["aeroway"~"^(taxiway|taxilane|apron|runway|terminal|hangar|parking_position|holding_position)$"](around:${radius},${ap.lat},${ap.lon});` +
    `node["aeroway"~"^(parking_position|gate|holding_position)$"](around:${radius},${ap.lat},${ap.lon});` +
    ');out geom tags;';
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Tries the preferred server first, then the others, with a pause between attempts (busy servers answer 429/502/504).
async function fetchOne(ap, preferred = 0) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = ENDPOINTS[(preferred + attempt) % ENDPOINTS.length];
    try {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 150000);
      const res = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Airwave-layout-fetcher/0.3' }, body: 'data=' + encodeURIComponent(query(ap)) });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) { lastErr = e; await sleep(5000 * (attempt + 1)); }
  }
  throw lastErr;
}

async function main() {
  const map = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'greece.json'), 'utf8'));
  const args = process.argv.slice(2);
  const missingOnly = args.includes('--missing');
  const want = args.filter(a => !a.startsWith('--')).map(s => s.toUpperCase());
  let list = want.length ? map.airports.filter(a => want.includes(a.icao)) : map.airports;
  const unknown = want.filter(w => !map.airports.some(a => a.icao === w));
  if (unknown.length) console.log('Not on the map, skipped: ' + unknown.join(', '));
  if (missingOnly) list = list.filter(a => !fs.existsSync(path.join(OUT_DIR, a.icao + '.json')));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let ok = 0, n = 0;
  // One worker per server, so two airports download at once.
  const queue = list.slice();
  const worker = async w => {
    while (queue.length) {
      const ap = queue.shift(); const i = ++n;
      try {
        const L = convert(await fetchOne(ap, w), ap.icao);
        fs.writeFileSync(path.join(OUT_DIR, ap.icao + '.json'), JSON.stringify(L));
        console.log(`[${i}/${list.length}] ${ap.icao} ${ap.name}: ${L.taxiways.length} taxiways, ${L.aprons.length} aprons, ${L.stands.length} stands, ${L.gates.length} gates, ${L.holding.length} holding points`);
        ok++;
      } catch (e) {
        console.log(`[${i}/${list.length}] ${ap.icao} ${ap.name}: failed (${e.message}). Run again with --missing to retry.`);
      }
      await sleep(PAUSE_MS);
    }
  };
  await Promise.all(ENDPOINTS.map((_, w) => worker(w)));
  console.log(`Done: ${ok} of ${list.length} airports saved in data/layouts. Restart the server to use them.`);
}

if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { convert, query };
