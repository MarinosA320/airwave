#!/usr/bin/env node
/*
 * Airwave Pilot: connects your simulator to an Airwave server.
 *   node pilot-client/pilot.js        then open http://localhost:8090
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { TrafficManager } = require('./lib/traffic');
const { ModelMatcher } = require('./lib/matcher');

const VERSION = '0.4.0';
const UI_PORT = Number(process.env.AIRWAVE_PILOT_PORT || 8090);
const CONFIG_FILE = process.env.AIRWAVE_PILOT_CONFIG || path.join(__dirname, 'config.json');
const RULES_FILE = path.join(__dirname, 'matching-rules.json');
const DEFAULTS = {
  server: process.env.AIRWAVE_SERVER || 'wss://airwave-lwhv.onrender.com/ws', password: '', callsign: '', name: '', type: 'A20N', sim: 'msfs', xplaneHost: '127.0.0.1',
  autoTune: true, fp: { dep: '', arr: '', route: '', cruise: 36000 }
};

// ------------------------------------------------------------ state
let config = loadConfig();
const logLines = [];
const state = {
  net: 'offline', netText: 'Not connected', sim: 'offline', simText: '', plugin: null,
  own: null, freq: '122.800', atc: [], lastInstr: null, wantOnline: false, callsign: null, mapName: ''
};
const traffic = new TrafficManager({ maxRange: 80 });
const matcher = new ModelMatcher({ rulesFile: RULES_FILE, log });
let sim = null, ws = null, uiClients = new Set(), lastCom = null, reconnectTimer = null;

function log(text) {
  const line = new Date().toISOString().slice(11, 19) + ' ' + text;
  console.log(line); logLines.push(line); if (logLines.length > 300) logLines.shift();
  toUi({ t: 'log', line });
}
function loadConfig() {
  try { return Object.assign({}, DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))); } catch (e) { return Object.assign({}, DEFAULTS); }
}
function saveConfig() { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) { log('Could not save settings: ' + e.message); } }

// ------------------------------------------------------------ simulator
function startSim() {
  if (sim) { sim.removeAllListeners(); sim.stop(); }
  traffic.list().forEach(a => traffic.emit('remove', a));
  traffic.aircraft.clear();
  state.own = null; state.plugin = null;
  if (config.sim === 'xplane') { const { XPlaneAdapter } = require('./lib/xplane'); sim = new XPlaneAdapter({ host: config.xplaneHost, log }); }
  else if (config.sim === 'demo') { const { DemoSim } = require('./lib/demo-sim'); sim = new DemoSim({ log }); }
  else {
    try { const { MsfsAdapter } = require('./lib/msfs'); sim = new MsfsAdapter({ matcher, log }); }
    catch (e) { log('SimConnect library missing. Run "npm install" in the Airwave folder. (' + e.message + ')'); return; }
  }
  sim.on('status', s => { state.sim = s.connected ? 'online' : 'waiting'; state.simText = s.text; pushState(); });
  sim.on('position', p => { state.own = p; });
  sim.on('com1', f => {
    if (f === lastCom) return; lastCom = f;
    if (config.autoTune && /^1[1-3]\d\.\d{3}$/.test(f)) tune(f, 'COM1');
  });
  sim.on('plugin', p => { state.plugin = p; pushState(); });
  sim.on('models', () => pushState());
  sim.start();
}
traffic.on('add', a => sim && sim.add(a));
traffic.on('remove', a => sim && sim.remove(a));
setInterval(() => { if (sim) sim.render(a => traffic.stateAt(a)); }, 50);

// ------------------------------------------------------------ network
function connect() {
  clearTimeout(reconnectTimer);
  if (ws) { ws.removeAllListeners(); try { ws.close(); } catch (e) { /* closing */ } ws = null; }
  if (!state.wantOnline) return;
  const cs = String(config.callsign || '').toUpperCase();
  if (!/^[A-Z0-9_]{2,12}$/.test(cs)) { state.netText = 'Enter a callsign (letters and digits, like AEE123)'; state.net = 'offline'; return pushState(); }
  state.net = 'connecting'; state.netText = 'Connecting to ' + config.server; pushState();
  const slow = setTimeout(() => { if (state.net === 'connecting') { state.netText = 'Waiting for ' + config.server + '. A sleeping online server takes about a minute to wake up…'; pushState(); } }, 5000);
  try { ws = new WebSocket(config.server); } catch (e) { state.net = 'offline'; state.netText = 'Bad server address: ' + config.server; return pushState(); }
  ws.on('open', () => {
    clearTimeout(slow);
    send({ t: 'hello', role: 'pilot', callsign: cs, aircraft: config.type, name: config.name, password: config.password || '', client: 'Airwave Pilot ' + VERSION });
    sendFlightPlan();
  });
  ws.on('message', d => { let m; try { m = JSON.parse(d); } catch (e) { return; } onServer(m); });
  ws.on('close', () => {
    state.net = 'offline'; state.netText = state.wantOnline ? 'Connection lost, retrying…' : 'Disconnected';
    traffic.update([], null); pushState();
    if (state.wantOnline) reconnectTimer = setTimeout(connect, 5000);
  });
  ws.on('error', e => { state.netText = 'Could not reach ' + config.server + ' (' + e.code + ')'; pushState(); });
}
function send(m) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); }
function sendFlightPlan() { const f = config.fp; send({ t: 'fp', dep: f.dep, arr: f.arr, route: f.route, cruise: Number(f.cruise) || 0, type: config.type }); }
function tune(freq, why) {
  state.freq = freq; send({ t: 'tune', freq });
  const atc = state.atc.find(c => c.freq === freq);
  log(`Tuned ${freq}${atc ? ' (' + atc.name + ')' : ''}${why ? ' from ' + why : ''}`);
  pushState();
}

function onServer(m) {
  switch (m.t) {
    case 'welcome':
      state.net = 'online'; state.callsign = m.callsign; state.mapName = m.map ? m.map.name : '';
      state.netText = 'Connected as ' + m.callsign + (state.mapName ? ' · ' + state.mapName : '');
      log(state.netText);
      send({ t: 'tune', freq: state.freq });
      pushState(); break;
    case 'traffic':
      state.atc = m.atc || [];
      traffic.update((m.traffic || []).filter(a => a.cs !== state.callsign), state.own);
      break;
    case 'msg':
      toUi({ t: 'msg', from: m.from, text: m.text, freq: m.freq, private: m.private, system: m.system, mine: m.from === state.callsign, at: m.at || Date.now() });
      break;
    case 'instr':
      state.lastInstr = { from: m.from, kind: m.kind, value: m.value, text: m.text, at: Date.now() };
      if (m.kind === 'contact') { const f = String(m.value).match(/1\d\d\.\d{3}/); if (f) state.lastInstr.freq = f[0]; }
      if (sim && sim.follow) sim.follow(m);
      log('ATC ' + m.from + ': ' + m.text);
      toUi({ t: 'instr', instr: state.lastInstr });
      pushState(); break;
    case 'error':
      log('Server: ' + m.text);
      if (/in use|Callsign must|password/i.test(m.text)) { state.wantOnline = false; state.netText = m.text; }
      pushState(); break;
  }
}
setInterval(() => {
  if (state.net !== 'online' || !state.own) return;
  const p = state.own;
  send({ t: 'pos', lat: p.lat, lon: p.lon, alt: Math.round(p.alt), hdg: Math.round(p.hdg), gs: Math.round(p.gs), vs: Math.round(p.vs), pitch: p.pitch, bank: p.bank, onGround: p.onGround, squawk: p.squawk });
}, 1000);

// ------------------------------------------------------------ local control panel
function snapshot() {
  return {
    t: 'state', version: VERSION, config: Object.assign({}, config, { password: config.password ? '••••••' : '' }), net: state.net, netText: state.netText, sim: state.sim, simText: state.simText,
    plugin: state.plugin ? { models: state.plugin.models || 0 } : null, own: state.own, freq: state.freq, atc: state.atc,
    lastInstr: state.lastInstr, wantOnline: state.wantOnline, traffic: traffic.list().length,
    stats: sim && sim.stats ? sim.stats() : null
  };
}
function toUi(m) { const s = JSON.stringify(m); for (const c of uiClients) if (c.readyState === 1) c.send(s); }
function pushState() { toUi(snapshot()); }
setInterval(pushState, 1000);

function onUi(m) {
  switch (m.t) {
    case 'config': {
      const prevSim = config.sim, prevHost = config.xplaneHost;
      const c = m.config || {};
      for (const k of ['server', 'password', 'callsign', 'name', 'type', 'sim', 'xplaneHost']) if (typeof c[k] === 'string' && !(k === 'password' && c[k] === '••••••')) config[k] = c[k].trim();
      if (typeof c.autoTune === 'boolean') config.autoTune = c.autoTune;
      config.callsign = config.callsign.toUpperCase(); config.type = config.type.toUpperCase();
      if (c.fp) config.fp = { dep: String(c.fp.dep || '').toUpperCase(), arr: String(c.fp.arr || '').toUpperCase(), route: String(c.fp.route || '').toUpperCase(), cruise: Number(c.fp.cruise) || 0 };
      saveConfig();
      if (config.sim !== prevSim || config.xplaneHost !== prevHost) startSim();
      if (state.net === 'online') sendFlightPlan();
      break;
    }
    case 'connect': state.wantOnline = true; connect(); break;
    case 'disconnect': state.wantOnline = false; connect(); state.net = 'offline'; state.netText = 'Disconnected'; break;
    case 'tune': if (/^1[1-3]\d\.\d{3}$/.test(m.freq)) tune(m.freq, 'panel'); break;
    case 'send': { const text = String(m.text || '').trim().slice(0, 240); if (text) send({ t: 'msg', freq: state.freq, text }); break; }
    case 'readback': {
      const i = state.lastInstr; if (!i) break;
      const body = i.text.replace(/^[A-Z0-9_]+,\s*/, '');
      send({ t: 'msg', freq: state.freq, text: body.charAt(0).toUpperCase() + body.slice(1) + ', ' + state.callsign });
      if (i.kind === 'contact' && i.freq) setTimeout(() => tune(i.freq, 'contact instruction'), 1500);
      break;
    }
  }
  pushState();
}

const UI_FILE = path.join(__dirname, 'ui.html');
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return fs.createReadStream(UI_FILE).pipe(res); }
  res.writeHead(404); res.end();
});
const wss = new WebSocket.Server({ server, path: '/ui' });
wss.on('connection', c => {
  uiClients.add(c);
  c.send(JSON.stringify(snapshot()));
  logLines.slice(-60).forEach(line => c.send(JSON.stringify({ t: 'log', line })));
  c.on('message', d => { try { onUi(JSON.parse(d)); } catch (e) { /* ignore */ } });
  c.on('close', () => uiClients.delete(c));
});
server.listen(UI_PORT, '127.0.0.1', () => {
  log(`Airwave Pilot ${VERSION}: open http://localhost:${UI_PORT} in your browser`);
  startSim();
});

process.on('SIGINT', () => { if (sim) sim.stop(); setTimeout(() => process.exit(0), 300); });
module.exports = { onUi, state, traffic, config: () => config };
