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
const { REQUEST_GROUPS } = require('./lib/requests');

const VERSION = '0.6.0';
const UI_PORT = Number(process.env.AIRWAVE_PILOT_PORT || 8090);
const CONFIG_FILE = process.env.AIRWAVE_PILOT_CONFIG || path.join(__dirname, 'config.json');
const RULES_FILE = path.join(__dirname, 'matching-rules.json');
const DEFAULTS = {
  server: process.env.AIRWAVE_SERVER || 'wss://airwave-lwhv.onrender.com/ws', password: '', callsign: '', name: '', type: 'A20N', sim: 'msfs', xplaneHost: '127.0.0.1', stand: '', pttSim: '',
  autoTune: true, fp: { dep: '', arr: '', route: '', cruise: 36000 }
};

// ------------------------------------------------------------ state
let config = loadConfig();
const logLines = [];
const state = {
  net: 'offline', netText: 'Not connected', sim: 'offline', simText: '', plugin: null,
  own: null, freq: '122.800', atc: [], lastInstr: null, wantOnline: false, callsign: null, mapName: '', atis: {}
};
const traffic = new TrafficManager({ maxRange: 80 });
const matcher = new ModelMatcher({ rulesFile: RULES_FILE, log });
let sim = null, ws = null, uiClients = new Set(), lastCom = null, reconnectTimer = null;
// Radio messages kept for the in-sim panels (MSFS toolbar panel, X-Plane window)
const radio = []; let radioId = 0, instrId = 0;

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
    try { const { MsfsAdapter } = require('./lib/msfs'); sim = new MsfsAdapter({ matcher, log, pttInput: config.pttSim }); }
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
  sim.on('command', c => onUi(c)); // buttons in the X-Plane panel
  sim.on('ptt', on => onUi({ t: 'ptt', on }));    // push-to-talk button in the sim
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
      state.atis = {}; (m.atis || []).forEach(a => { state.atis[a.icao] = a; });
      pushState(); break;
    case 'atis': {
      const prev = state.atis[m.icao]; state.atis[m.icao] = m;
      if (prev && prev.letter !== m.letter && [config.fp.dep, config.fp.arr].includes(m.icao)) log(m.icao + ' ATIS is now information ' + m.letter);
      pushState(); break;
    }
    case 'traffic':
      state.atc = m.atc || [];
      traffic.update((m.traffic || []).filter(a => a.cs !== state.callsign), state.own);
      break;
    case 'msg':
      radio.push({ id: ++radioId, from: m.from, text: m.text, freq: m.freq, mine: m.from === state.callsign, system: !!m.system, at: m.at || Date.now() });
      if (radio.length > 40) radio.shift();
      pushPanel();
      toUi({ t: 'msg', from: m.from, text: m.text, freq: m.freq, private: m.private, system: m.system, atis: !!m.atis, mine: m.from === state.callsign, at: m.at || Date.now() });
      break;
    case 'instr':
      state.lastInstr = { id: ++instrId, from: m.from, kind: m.kind, value: m.value, text: m.text, at: Date.now(), readBack: false };
      if (m.kind === 'contact') { const f = String(m.value).match(/1\d\d\.\d{3}/); if (f) state.lastInstr.freq = f[0]; }
      if (sim && sim.follow) sim.follow(m);
      log('ATC ' + m.from + ': ' + m.text);
      toUi({ t: 'instr', instr: state.lastInstr });
      pushState(); break;
    case 'voice': toUi(m); break; // someone talking on your frequency: played by the Airwave Pilot window
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
    atis: [config.fp.dep, config.fp.arr].filter((x, i, a) => x && a.indexOf(x) === i).map(icao => state.atis[icao] || { icao, none: true }),
    atisFreqs: Object.values(state.atis).filter(a => a.freq).map(a => ({ icao: a.icao, freq: a.freq, letter: a.letter })),
    stats: sim && sim.stats ? sim.stats() : null
  };
}
// Compact state for the in-sim panels.
function panelState(since) {
  const atcHere = state.atc.find(c => c.freq === state.freq);
  return {
    callsign: state.callsign || config.callsign || '', net: state.net, netText: state.netText, sim: state.sim, simText: state.simText,
    freq: state.freq, station: atcHere ? atcHere.name : (state.freq === '122.800' ? 'UNICOM' : 'No ATC on this frequency'),
    instr: state.lastInstr, atc: state.atc.map(c => ({ id: c.cs || c.facility, name: c.name, freq: c.freq })),
    msgs: radio.filter(r => r.id > (since || 0)).slice(-12), lastMsg: radioId, squawk: state.own ? state.own.squawk : null,
    atisFreqs: Object.values(state.atis).filter(a => a.freq).map(a => ({ icao: a.icao, freq: a.freq, letter: a.letter })),
    atis: [config.fp.dep, config.fp.arr].filter(Boolean).map(icao => state.atis[icao]).filter(Boolean).map(a => ({ icao: a.icao, letter: a.letter, freq: a.freq }))
  };
}
function pushPanel() { if (sim && sim.panel) sim.panel(panelState(radioId - 6)); }
setInterval(pushPanel, 1000);
function toUi(m) { const s = JSON.stringify(m); for (const c of uiClients) if (c.readyState === 1) c.send(s); }
function pushState() { toUi(snapshot()); }
setInterval(pushState, 1000);

function onUi(m) {
  switch (m.t) {
    case 'config': {
      const prevSim = config.sim, prevHost = config.xplaneHost;
      const c = m.config || {};
      const prevPtt = config.pttSim;
      for (const k of ['server', 'password', 'callsign', 'name', 'type', 'sim', 'xplaneHost', 'stand', 'pttSim']) if (typeof c[k] === 'string' && !(k === 'password' && c[k] === '••••••')) config[k] = c[k].trim();
      if (typeof c.autoTune === 'boolean') config.autoTune = c.autoTune;
      config.callsign = config.callsign.toUpperCase(); config.type = config.type.toUpperCase();
      if (c.fp) config.fp = { dep: String(c.fp.dep || '').toUpperCase(), arr: String(c.fp.arr || '').toUpperCase(), route: String(c.fp.route || '').toUpperCase(), cruise: Number(c.fp.cruise) || 0 };
      saveConfig();
      if (config.sim !== prevSim || config.xplaneHost !== prevHost || (config.sim === 'msfs' && config.pttSim !== prevPtt)) startSim();
      if (state.net === 'online') sendFlightPlan();
      break;
    }
    case 'connect': state.wantOnline = true; connect(); break;
    case 'disconnect': state.wantOnline = false; connect(); state.net = 'offline'; state.netText = 'Disconnected'; break;
    case 'tune': if (/^1[1-3]\d\.\d{3}$/.test(m.freq)) tune(m.freq, 'panel'); break;
    case 'send': { const text = String(m.text || '').trim().slice(0, 240); if (text) send({ t: 'msg', freq: state.freq, text }); break; }
    case 'req': {
      // Requests and replies: the server words them. Initial calls carry your stand and the ATIS letter you have.
      const kind = String(m.kind || '');
      if (!REQUEST_GROUPS.some(g => g.items.some(i => i.kind === kind))) break;
      const onGround = state.own ? state.own.onGround : true;
      const a = state.atis[onGround ? config.fp.dep : config.fp.arr];
      send({ t: 'req', kind, value: m.value == null ? '' : String(m.value).slice(0, 60), stand: onGround ? config.stand : '', atis: a ? a.letter : '' });
      break;
    }
    case 'voice': {
      // Your microphone, from the Airwave Pilot window, while push-to-talk is held.
      if (state.net !== 'online') break;
      if (m.end) { send({ t: 'voice', end: true }); break; }
      if (typeof m.data === 'string' && m.data.length <= 12000) send({ t: 'voice', seq: Number(m.seq) || 0, rate: m.rate === 8000 ? 8000 : 16000, data: m.data });
      break;
    }
    case 'ptt': {
      const open = [...uiClients].some(c => c.readyState === 1);
      if (!open && m.on) log('Push-to-talk needs the Airwave Pilot window open in your browser (it uses the microphone).');
      toUi({ t: 'ptt', on: !!m.on });
      return; // no state push needed
    }
    case 'installAddons': {
      const report = require('./install-addons').installAddons();
      report.forEach(r => log('Sim panels: ' + r.sim + ': ' + r.text));
      toUi({ t: 'addons', report });
      break;
    }
    case 'readback': {
      const i = state.lastInstr; if (!i) break;
      const body = i.text.replace(/^[A-Z0-9_]+,\s*/, '');
      send({ t: 'msg', freq: state.freq, text: body.charAt(0).toUpperCase() + body.slice(1) + ', ' + state.callsign });
      i.readBack = true;
      if (i.kind === 'contact' && i.freq) setTimeout(() => tune(i.freq, 'contact instruction'), 1500);
      break;
    }
  }
  pushState(); pushPanel();
}

const UI_FILE = path.join(__dirname, 'ui.html');
const PANEL_FILE = path.join(__dirname, 'panel.html');
const PANEL_COMMANDS = ['connect', 'disconnect', 'tune', 'send', 'readback', 'req'];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const cors = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  if (url.pathname === '/' || url.pathname === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return fs.createReadStream(UI_FILE).pipe(res); }
  // The in-sim panel: a small page the MSFS toolbar panel shows, polling /api/panel (the sim's browser is old, so no WebSockets)
  if (url.pathname === '/panel') { res.writeHead(200, Object.assign({ 'content-type': 'text/html; charset=utf-8' }, cors)); return fs.createReadStream(PANEL_FILE).pipe(res); }
  if (url.pathname === '/voice.js') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); return fs.createReadStream(path.join(__dirname, '..', 'shared', 'airwave-voice.js')).pipe(res); }
  if (url.pathname === '/api/requests') { res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, cors)); return res.end(JSON.stringify(REQUEST_GROUPS)); }
  if (url.pathname === '/api/panel') { res.writeHead(200, Object.assign({ 'content-type': 'application/json' }, cors)); return res.end(JSON.stringify(panelState(Number(url.searchParams.get('since')) || 0))); }
  if (url.pathname === '/api/cmd' && req.method === 'OPTIONS') { res.writeHead(204, Object.assign({ 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST' }, cors)); return res.end(); }
  if (url.pathname === '/api/cmd' && req.method === 'POST') {
    let body = ''; req.on('data', c => { body += c; if (body.length > 4000) req.destroy(); });
    req.on('end', () => {
      let m = null; try { m = JSON.parse(body); } catch (e) { /* bad json */ }
      const ok = m && PANEL_COMMANDS.includes(m.t);
      if (ok) onUi(m);
      res.writeHead(ok ? 200 : 400, Object.assign({ 'content-type': 'application/json' }, cors)); res.end(JSON.stringify(ok ? panelState(0) : { error: 'unknown command' }));
    });
    return;
  }
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
server.on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  // Already running (e.g. the shortcut was clicked twice): just show the open copy.
  console.log('Airwave Pilot is already running.');
  if (process.env.AIRWAVE_PILOT_OPEN === '1' && process.platform === 'win32') require('child_process').exec('start "" "http://localhost:' + UI_PORT + '"');
  setTimeout(() => process.exit(0), 500);
});
server.listen(UI_PORT, '127.0.0.1', () => {
  log(`Airwave Pilot ${VERSION}: open http://localhost:${UI_PORT} in your browser`);
  // The desktop shortcut sets AIRWAVE_PILOT_OPEN so the window opens by itself.
  if (process.env.AIRWAVE_PILOT_OPEN === '1' && process.platform === 'win32') require('child_process').exec('start "" "http://localhost:' + UI_PORT + '"');
  startSim();
});

process.on('SIGINT', () => { if (sim) sim.stop(); setTimeout(() => process.exit(0), 300); });
module.exports = { onUi, state, traffic, panelState, config: () => config };
