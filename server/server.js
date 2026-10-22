#!/usr/bin/env node
/*
 * Airwave server.
 *   node server/server.js [--port 8080] [--bots 24] [--map greece|london]
 *
 * Settings can also come from environment variables, which is how hosted servers (Render etc.) set them:
 *   PORT, AIRWAVE_MAP, AIRWAVE_BOTS, AIRWAVE_PASSWORD (everyone), AIRWAVE_ATC_PASSWORD (controllers), AIRWAVE_MAX_CLIENTS
 * Serves the ATC scope at http://localhost:<port>/ and the network at ws://localhost:<port>/ws
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Airwave = require('../shared/airwave-core.js');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def; };
const PORT = Number(process.env.PORT || opt('port', 8080));
const MAP_NAME = String(opt('map', process.env.AIRWAVE_MAP || 'greece')).toLowerCase();
const MAX_CLIENTS = Number(process.env.AIRWAVE_MAX_CLIENTS || 300);
const PASSWORD = process.env.AIRWAVE_PASSWORD || '';
const ATC_PASSWORD = process.env.AIRWAVE_ATC_PASSWORD || '';
const TICK_MS = 1000;
const MAX_MSG_BYTES = 4096;
const MAX_MSGS_PER_SEC = 40;

const ROOT = path.join(__dirname, '..');
const LAYOUT_DIR = path.join(ROOT, 'data', 'layouts');
const log = m => console.log(new Date().toISOString().slice(11, 19), m);

function loadMap(name) {
  if (name === 'london') return Airwave.DEMO_SECTOR;
  const file = path.join(ROOT, 'data', name + '.json');
  if (!fs.existsSync(file)) { console.error('Map not found: ' + file); process.exit(1); }
  return Airwave.registerMap(JSON.parse(fs.readFileSync(file, 'utf8')));
}
const map = loadMap(MAP_NAME);
const mapJson = JSON.stringify(map, (k, v) => (k === 'fixIndex' ? undefined : v));
const BOTS = Number(opt('bots', process.env.AIRWAVE_BOTS != null && process.env.AIRWAVE_BOTS !== '' ? process.env.AIRWAVE_BOTS : -1));

const hub = new Airwave.Hub({ sector: map, log, password: PASSWORD, atcPassword: ATC_PASSWORD });
if (BOTS !== 0) hub.addSource(new Airwave.SimTrafficSource(BOTS > 0 ? { count: BOTS } : {}));

// The scope page is written as a fragment so the same file can be published as a standalone demo.
function scopePage() {
  const body = fs.readFileSync(path.join(ROOT, 'atc-client', 'scope.html'), 'utf8');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    // Tells the scope it was opened from an Airwave server, so it connects back to this same address.
    '<script>window.AIRWAVE_SERVED = ' + JSON.stringify({ needsPassword: !!PASSWORD, needsAtcPassword: !!ATC_PASSWORD }) + ';</script></head><body>' +
    body + '</body></html>';
}
function layoutList() {
  try { return fs.readdirSync(LAYOUT_DIR).filter(f => /^[A-Z0-9]{4}\.json$/.test(f)).map(f => f.slice(0, 4)); } catch { return []; }
}

// Map, layouts and status may be read by a scope hosted elsewhere (e.g. GitHub Pages), so allow any origin.
const CORS = { 'access-control-allow-origin': '*' };
const json = (res, body, code = 200) => { res.writeHead(code, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS)); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (p === '/' || p === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(scopePage());
  }
  if (p === '/shared/airwave-core.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    return fs.createReadStream(path.join(ROOT, 'shared', 'airwave-core.js')).pipe(res);
  }
  if (p === '/map.json') return json(res, mapJson);
  if (p === '/layouts/') return json(res, layoutList());
  const lm = p.match(/^\/layouts\/([A-Z0-9]{4})\.json$/);
  if (lm) {
    const file = path.join(LAYOUT_DIR, lm[1] + '.json');
    if (!fs.existsSync(file)) return json(res, { error: 'No layout for ' + lm[1] }, 404);
    res.writeHead(200, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS));
    return fs.createReadStream(file).pipe(res);
  }
  if (p === '/healthz') return json(res, { ok: true });
  if (p === '/status') {
    return json(res, {
      version: Airwave.VERSION, map: map.id,
      pilots: hub.pilots().map(s => s.callsign),
      controllers: hub.controllers().map(c => ({ callsign: c.callsign, freq: c.freq })),
      layouts: layoutList()
    });
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG_BYTES });
wss.on('connection', ws => {
  if (wss.clients.size > MAX_CLIENTS) { ws.close(1013, 'Server full'); return; }
  const session = hub.connect(m => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); });
  let windowStart = Date.now(), count = 0;
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', data => {
    ws.alive = true;
    const now = Date.now();
    if (now - windowStart > 1000) { windowStart = now; count = 0; }
    if (++count > MAX_MSGS_PER_SEC) return session.error('Too many messages. Slow down.');
    let m; try { m = JSON.parse(data); } catch { return session.error('Messages must be JSON.'); }
    session.receive(m);
  });
  ws.on('close', () => session.close());
  ws.on('error', () => session.close());
});
// Hosting proxies drop quiet connections, and dead clients should be cleaned up: ping every 25 s.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    try { ws.ping(); } catch (e) { /* closing */ }
  }
}, 25000);

setInterval(() => hub.tick(TICK_MS / 1000), TICK_MS);

server.listen(PORT, () => {
  log(`Airwave ${Airwave.VERSION} running, map: ${map.name}`);
  log(`ATC scope:  http://localhost:${PORT}/`);
  log(`Network:    ws://localhost:${PORT}/ws`);
  log(`Simulated pilots: ${hub.sources.length ? hub.sources[0].target : 0}`);
  log(`Airport layouts: ${layoutList().length} (add more with: node tools/fetch-layouts.js)`);
  log(`Network password: ${PASSWORD ? 'on' : 'off'}, ATC password: ${ATC_PASSWORD ? 'on' : 'off'}`);
});
