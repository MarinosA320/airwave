#!/usr/bin/env node
/*
 * Airwave server.
 *   node server/server.js [--port 8080] [--bots 24] [--map greece|london]
 *
 * Settings can also come from environment variables, which is how hosted servers (Render etc.) set them:
 *   PORT, AIRWAVE_MAP, AIRWAVE_BOTS, AIRWAVE_PASSWORD (everyone), AIRWAVE_ATC_PASSWORD (controllers), AIRWAVE_MAX_CLIENTS
 *   AIRWAVE_EDITOR_PASSWORD   password for the sector editor (defaults to the ATC password)
 *   GITHUB_TOKEN              lets the server save editor changes to the GitHub repo (contents: write)
 *   GITHUB_REPO               owner/repo to save to (on Render this defaults to the deployed repo)
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

const EDITOR_PASSWORD = process.env.AIRWAVE_EDITOR_PASSWORD || ATC_PASSWORD;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || process.env.RENDER_GIT_REPO_SLUG || '';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || process.env.RENDER_GIT_BRANCH || 'main';
const OVERLAY_PATH = process.env.AIRWAVE_OVERLAY || 'data/overlay.json';
const MAX_OVERLAY_BYTES = 4 * 1024 * 1024;

const ROOT = path.join(__dirname, '..');
const LAYOUT_DIR = path.join(ROOT, 'data', 'layouts');
const log = m => console.log(new Date().toISOString().slice(11, 19), m);

function loadMap(name) {
  if (name === 'london') return Airwave.DEMO_SECTOR;
  const file = path.join(ROOT, 'data', name + '.json');
  if (!fs.existsSync(file)) { console.error('Map not found: ' + file); process.exit(1); }
  return Airwave.registerMap(JSON.parse(fs.readFileSync(file, 'utf8')));
}
// ------------------------------------------------------------ base map + editor overlay
const baseMap = loadMap(MAP_NAME);
const OVERLAY_FILE = path.join(ROOT, OVERLAY_PATH);
let overlay = null;
try { overlay = JSON.parse(fs.readFileSync(OVERLAY_FILE, 'utf8')); } catch { overlay = null; }
let map = Airwave.registerMap(Airwave.applyOverlay(baseMap, MAP_NAME === 'london' ? null : overlay));
let mapJson = '';
// Layouts are served separately, so the map file stays small.
const serializeMap = m => JSON.stringify(m, (k, v) => (k === 'fixIndex' || k === 'cfg' || k === 'layout' ? undefined : v));
mapJson = serializeMap(map);
const BOTS = Number(opt('bots', process.env.AIRWAVE_BOTS != null && process.env.AIRWAVE_BOTS !== '' ? process.env.AIRWAVE_BOTS : -1));

const hub = new Airwave.Hub({ sector: map, log, password: PASSWORD, atcPassword: ATC_PASSWORD });
function useOverlay(ov, why) {
  overlay = ov;
  map = Airwave.registerMap(Airwave.applyOverlay(baseMap, ov));
  mapJson = serializeMap(map);
  hub.setMap(map);
  log(`Map edits applied (revision ${ov ? ov.rev : 0}${why ? ', ' + why : ''})`);
}

// ------------------------------------------------------------ saving edits to GitHub
// Render's free disk is wiped when the server sleeps, so the GitHub repo is the permanent copy.
// Commits say [skip render] so saving an edit does not restart the server.
async function github(method, apiPath, body) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'airwave-server', 'x-github-api-version': '2022-11-28' };
  if (GITHUB_TOKEN) headers.authorization = 'Bearer ' + GITHUB_TOKEN;
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch('https://api.github.com/repos/' + GITHUB_REPO + apiPath, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
async function loadOverlayFromGitHub() {
  if (!GITHUB_REPO || MAP_NAME === 'london') return;
  try {
    const r = await github('GET', '/contents/' + OVERLAY_PATH + '?ref=' + GITHUB_BRANCH);
    if (r.status !== 200) return;
    const ov = JSON.parse(Buffer.from(r.data.content, 'base64').toString('utf8'));
    if (!overlay || (ov.rev || 0) > (overlay.rev || 0)) useOverlay(ov, 'loaded from GitHub');
  } catch (e) { log('Could not read map edits from GitHub: ' + e.message); }
}
async function saveOverlayToGitHub(ov, by) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return { saved: false, why: 'GitHub saving is not set up (GITHUB_TOKEN). Edits last until the server restarts.' };
  const cur = await github('GET', '/contents/' + OVERLAY_PATH + '?ref=' + GITHUB_BRANCH);
  const body = {
    message: `Map edit r${ov.rev} by ${by} [skip render]`,
    content: Buffer.from(JSON.stringify(ov, null, 1)).toString('base64'),
    branch: GITHUB_BRANCH
  };
  if (cur.status === 200) body.sha = cur.data.sha;
  const put = await github('PUT', '/contents/' + OVERLAY_PATH, body);
  if (put.status !== 200 && put.status !== 201) return { saved: false, why: 'GitHub refused the save (' + put.status + (put.data && put.data.message ? ': ' + put.data.message : '') + ').' };
  return { saved: true, commit: put.data.commit && put.data.commit.sha };
}

// ------------------------------------------------------------ editor saves
function checkOverlay(ov) {
  if (!ov || typeof ov !== 'object') return 'The edit is empty.';
  if (ov.sectors && !Array.isArray(ov.sectors)) return 'Sectors must be a list.';
  for (const sct of ov.sectors || []) {
    if (!sct.id || !Array.isArray(sct.polygon) || sct.polygon.length < 3) return 'Sector ' + (sct.id || '?') + ' needs a name and at least 3 points.';
    if (sct.polygon.some(q => !Array.isArray(q) || Math.abs(q[0]) > 90 || Math.abs(q[1]) > 180)) return 'Sector ' + sct.id + ' has a bad point.';
  }
  for (const f of ov.facilities || []) {
    if (!/^[A-Z0-9_]{2,12}$/.test(f.id || '')) return 'Position ' + (f.id || '?') + ': use letters, digits and _ (like LGGG_W_CTR).';
    if (!/^1[1-3]\d\.\d{3}$/.test(f.freq || '')) return 'Position ' + f.id + ': frequency must look like 132.225.';
  }
  for (const f of (ov.fixes && ov.fixes.upsert) || []) {
    if (!/^[A-Z0-9]{2,7}$/.test(f.id || '') || !(Math.abs(f.lat) <= 90 && Math.abs(f.lon) <= 180)) return 'Waypoint ' + (f.id || '?') + ' needs a 2-7 character name and a position.';
  }
  return null;
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
const isLocal = req => /^(::1|127\.|::ffff:127\.)/.test(req.socket.remoteAddress || '') && !req.headers['x-forwarded-for'];
async function handleSave(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req, MAX_OVERLAY_BYTES)); } catch (e) { return json(res, { error: e.message === 'too large' ? 'The edit is too big to save.' : 'The edit could not be read.' }, 400); }
  if (EDITOR_PASSWORD ? body.password !== EDITOR_PASSWORD : !isLocal(req)) return json(res, { error: EDITOR_PASSWORD ? 'Wrong editor password.' : 'Editing is off on this server: set AIRWAVE_EDITOR_PASSWORD or AIRWAVE_ATC_PASSWORD.' }, 403);
  const rev = overlay ? overlay.rev || 0 : 0;
  if ((body.baseRev || 0) !== rev) return json(res, { error: 'Someone saved changes after you opened the editor. Reload the editor to get them, then redo your change.', rev }, 409);
  const problem = checkOverlay(body.overlay);
  if (problem) return json(res, { error: problem }, 400);
  const by = String(body.by || 'editor').replace(/[^\w .-]/g, '').slice(0, 30) || 'editor';
  const ov = Object.assign({}, body.overlay, { rev: rev + 1, updated: new Date().toISOString(), by });
  try { fs.mkdirSync(path.dirname(OVERLAY_FILE), { recursive: true }); fs.writeFileSync(OVERLAY_FILE, JSON.stringify(ov, null, 1)); } catch (e) { /* read-only disk is fine */ }
  useOverlay(ov, 'saved by ' + by);
  let gh = { saved: false, why: '' };
  try { gh = await saveOverlayToGitHub(ov, by); } catch (e) { gh = { saved: false, why: 'Could not reach GitHub: ' + e.message }; }
  if (gh.saved) log('Map edit r' + ov.rev + ' committed to GitHub ' + (gh.commit || '').slice(0, 7));
  return json(res, { ok: true, rev: ov.rev, github: gh });
}
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
  if (p === '/base-map.json') return json(res, serializeMap(baseMap));
  if (p === '/overlay.json') return json(res, overlay || { rev: 0 });
  if (p === '/editor' || p === '/editor/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    const body = fs.readFileSync(path.join(ROOT, 'atc-client', 'editor.html'), 'utf8');
    return res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
      '<script>window.AIRWAVE_EDITOR = ' + JSON.stringify({ needsPassword: !!EDITOR_PASSWORD, github: !!(GITHUB_TOKEN && GITHUB_REPO) }) + ';</script></head><body>' + body + '</body></html>');
  }
  if (p === '/editor/save' && req.method === 'POST') { handleSave(req, res).catch(e => json(res, { error: 'Saving failed: ' + e.message }, 500)); return; }
  if (p === '/layouts/') return json(res, [...new Set(layoutList().concat(map.airports.filter(a => a.layout).map(a => a.icao)))]);
  const lm = p.match(/^\/layouts\/([A-Z0-9]{4})\.json$/);
  if (lm) {
    const edited = map.airports.find(a => a.icao === lm[1] && a.layout);
    if (edited) return json(res, Object.assign({ icao: lm[1] }, edited.layout));
    const file = path.join(LAYOUT_DIR, lm[1] + '.json');
    if (!fs.existsSync(file)) return json(res, { error: 'No layout for ' + lm[1] }, 404);
    res.writeHead(200, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS));
    return fs.createReadStream(file).pipe(res);
  }
  if (p === '/healthz') return json(res, { ok: true });
  if (p === '/status') {
    return json(res, {
      version: Airwave.VERSION, map: map.id, mapRev: overlay ? overlay.rev || 0 : 0,
      pilots: hub.pilots().map(s => s.callsign),
      controllers: hub.controllers().map(c => ({ callsign: c.callsign, freq: c.freq })),
      layouts: layoutList(),
      runways: hub.runwayConfig()
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
  log(`Airwave ${Airwave.VERSION} running, map: ${map.name}${overlay ? ' + edits r' + overlay.rev : ''}`);
  log(`ATC scope:  http://localhost:${PORT}/`);
  log(`Network:    ws://localhost:${PORT}/ws`);
  log(`Simulated pilots: ${hub.sources.length ? hub.sources[0].target : 0}`);
  log(`Airport layouts: ${layoutList().length} (add more with: node tools/fetch-layouts.js)`);
  log(`Network password: ${PASSWORD ? 'on' : 'off'}, ATC password: ${ATC_PASSWORD ? 'on' : 'off'}`);
  log(`Sector editor: http://localhost:${PORT}/editor (${EDITOR_PASSWORD ? 'password' : 'this computer only'}; saving to GitHub ${GITHUB_TOKEN && GITHUB_REPO ? 'on (' + GITHUB_REPO + ')' : 'off'})`);
  loadOverlayFromGitHub();
});
