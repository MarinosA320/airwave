'use strict';
/*
 * Microsoft Flight Simulator adapter (2024 and 2020) over SimConnect.
 *  - reads your aircraft (position, attitude, transponder, COM1) a few times a second
 *  - shows network traffic as AI aircraft, frozen and moved by Airwave every frame
 *  - lists installed aircraft and liveries for model matching
 */
const { EventEmitter } = require('events');
const {
  open, Protocol, SimConnectDataType, SimConnectPeriod, SimConnectConstants, RawBuffer,
  InitPosition, SimObjectType, EventFlag
} = require('node-simconnect');
const PRIORITY_HIGHEST = 1; // SIMCONNECT_GROUP_PRIORITY_HIGHEST
const { findPackagesPath, scanPackages } = require('./matcher');

// SimConnect's attitude signs are the opposite of Airwave's (pitch up and right bank are positive in Airwave).
// If remote aircraft appear nose-down or banking the wrong way, flip these.
const PITCH_SIGN = -1;
const BANK_SIGN = -1;

const DEF = { OWN: 1, MOVE: 2, GROUND: 3 };
const REQ = { OWN: 1, ENUM: 2 };
const EV = { FREEZE_LATLON: 1, FREEZE_ALT: 2, FREEZE_ATT: 3, GEAR_UP: 4, GEAR_DOWN: 5, LANDING_LIGHTS: 6, STROBES: 7, BEACON: 8, TAXI: 9 };
const MAX_AI = 40;

class MsfsAdapter extends EventEmitter {
  constructor({ matcher, log = () => {} }) {
    super();
    this.matcher = matcher; this.log = log;
    this.handle = null; this.is2024 = false; this.connected = false;
    this.ai = new Map();        // cs -> { a, objectId, reqId, gear, lights, groundAlt, cg }
    this.pending = new Map();   // reqId -> cs
    this.nextReq = 1000;
    this.stopped = false;
    this.enumBuffer = [];
  }

  async start() {
    this.stopped = false;
    while (!this.stopped && !this.connected) {
      try { await this.connect(); } catch (e) {
        this.emit('status', { sim: 'msfs', connected: false, text: 'Waiting for Microsoft Flight Simulator…' });
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }
  stop() { this.stopped = true; if (this.handle) { try { this.removeAll(); this.handle.close(); } catch (e) { /* closing */ } } }

  async connect() {
    let res, protocol;
    for (protocol of [Protocol.SunRise, Protocol.KittyHawk]) {
      try { res = await open('Airwave Pilot', protocol); break; } catch (e) { res = null; }
    }
    if (!res) throw new Error('not running');
    const { handle, recvOpen } = res;
    this.handle = handle; this.connected = true;
    this.is2024 = protocol === Protocol.SunRise;
    this.log(`Connected to ${recvOpen.applicationName} ${recvOpen.applicationVersionMajor}.${recvOpen.applicationVersionMinor} (${this.is2024 ? 'MSFS 2024' : 'MSFS 2020'})`);
    this.emit('status', { sim: 'msfs', connected: true, text: this.is2024 ? 'MSFS 2024 connected' : 'MSFS connected' });

    const add = (def, name, unit, type = SimConnectDataType.FLOAT64) => handle.addToDataDefinition(def, name, unit, type);
    [['PLANE LATITUDE', 'degrees'], ['PLANE LONGITUDE', 'degrees'], ['PLANE ALTITUDE', 'feet'], ['PLANE HEADING DEGREES TRUE', 'degrees'],
      ['GROUND VELOCITY', 'knots'], ['VERTICAL SPEED', 'feet per minute'], ['PLANE PITCH DEGREES', 'degrees'], ['PLANE BANK DEGREES', 'degrees'],
      ['SIM ON GROUND', 'bool'], ['TRANSPONDER CODE:1', 'Bco16'], ['COM ACTIVE FREQUENCY:1', 'MHz']].forEach(([n, u]) => add(DEF.OWN, n, u));
    [['PLANE LATITUDE', 'degrees'], ['PLANE LONGITUDE', 'degrees'], ['PLANE ALTITUDE', 'feet'],
      ['PLANE PITCH DEGREES', 'degrees'], ['PLANE BANK DEGREES', 'degrees'], ['PLANE HEADING DEGREES TRUE', 'degrees']].forEach(([n, u]) => add(DEF.MOVE, n, u));
    [['GROUND ALTITUDE', 'feet'], ['STATIC CG TO GROUND', 'feet']].forEach(([n, u]) => add(DEF.GROUND, n, u));

    const map = (id, name) => handle.mapClientEventToSimEvent(id, name);
    map(EV.FREEZE_LATLON, 'FREEZE_LATITUDE_LONGITUDE_SET'); map(EV.FREEZE_ALT, 'FREEZE_ALTITUDE_SET'); map(EV.FREEZE_ATT, 'FREEZE_ATTITUDE_SET');
    map(EV.GEAR_UP, 'GEAR_UP'); map(EV.GEAR_DOWN, 'GEAR_DOWN'); map(EV.LANDING_LIGHTS, 'LANDING_LIGHTS_SET'); map(EV.STROBES, 'STROBES_SET');
    map(EV.BEACON, 'BEACON_LIGHTS_SET'); map(EV.TAXI, 'TAXI_LIGHTS_SET');

    handle.requestDataOnSimObject(REQ.OWN, DEF.OWN, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SIM_FRAME, 0, 0, 12, 0);

    handle.on('simObjectData', d => this.onData(d));
    handle.on('assignedObjectID', r => this.onAssigned(r));
    handle.on('enumerateSimobjectAndLiveryList', r => this.onEnum(r));
    handle.on('exception', e => this.log('SimConnect exception ' + e.exception + ' (packet ' + e.sendId + ')'));
    handle.on('quit', () => this.onClosed('Simulator closed'));
    handle.on('close', () => this.onClosed('Connection to the simulator closed'));
    handle.on('error', e => this.onClosed('SimConnect error: ' + e.message));

    this.loadModels();
  }

  onClosed(why) {
    if (!this.connected) return;
    this.connected = false; this.handle = null;
    for (const v of this.ai.values()) { v.objectId = null; v.reqId = null; }
    this.pending.clear();
    this.log(why);
    this.emit('status', { sim: 'msfs', connected: false, text: why });
    if (!this.stopped) setTimeout(() => this.start(), 3000);
  }

  loadModels() {
    if (this.is2024) {
      this.enumBuffer = [];
      try { this.handle.enumerateSimObjectsAndLiveries(REQ.ENUM, SimObjectType.AIRCRAFT); return; } catch (e) { this.log('Could not list liveries: ' + e.message); }
    }
    const root = findPackagesPath();
    if (!root) { this.log('Could not find your MSFS packages folder. Add model rules in matching-rules.json.'); return; }
    this.matcher.setModels(scanPackages(root, this.log));
    this.emit('models', this.matcher.models.length);
  }
  onEnum(r) {
    for (const l of r.simobjectLiveries || []) this.enumBuffer.push({ title: l.aircraftTitle, livery: l.liveryName });
    if (r.entryNumber + 1 >= r.outOf) {
      this.matcher.setModels(this.enumBuffer);
      this.emit('models', this.matcher.models.length);
      for (const v of this.ai.values()) if (!v.objectId && !v.reqId) this.create(v);
    }
  }

  onData(d) {
    if (d.requestID === REQ.OWN) {
      const b = d.data;
      const lat = b.readFloat64(), lon = b.readFloat64(), alt = b.readFloat64(), hdg = b.readFloat64(), gs = b.readFloat64(), vs = b.readFloat64();
      const pitch = b.readFloat64() * PITCH_SIGN, bank = b.readFloat64() * BANK_SIGN, onGround = b.readFloat64() > 0.5;
      const sq = Math.round(b.readFloat64()), com = b.readFloat64();
      this.emit('position', { lat, lon, alt, hdg, gs, vs, pitch, bank, onGround, squawk: sq.toString(16).padStart(4, '0').slice(-4) });
      if (com > 100) this.emit('com1', com.toFixed(3));
      return;
    }
    for (const v of this.ai.values()) {
      if (v.groundReq === d.requestID) { v.groundAlt = d.data.readFloat64(); v.cg = d.data.readFloat64(); v.a.groundAlt = v.groundAlt; return; }
    }
  }

  // ------------------------------------------------------------ traffic
  add(a) {
    const v = { a, objectId: null, reqId: null, gear: null, lights: {} };
    this.ai.set(a.cs, v);
    if (this.connected) this.create(v);
  }
  create(v) {
    if (this.ai.size > MAX_AI && [...this.ai.values()].filter(x => x.objectId).length >= MAX_AI) return;
    const m = this.matcher.match(v.a.type, v.a.airline, v.a.cs);
    if (!m) return;
    v.model = m;
    const s = v.a.report;
    const pos = new InitPosition();
    Object.assign(pos, { latitude: s.lat, longitude: s.lon, altitude: s.alt, pitch: 0, bank: 0, heading: s.hdg, onGround: !!s.onGround, airspeed: Math.round(s.gs || 0) });
    v.reqId = this.nextReq++;
    this.pending.set(v.reqId, v.a.cs);
    const tail = v.a.cs.slice(0, 12);
    try {
      if (this.is2024 && m.livery) this.handle.aICreateNonATCAircraftEx1(m.title, m.livery, tail, pos, v.reqId);
      else this.handle.aICreateNonATCAircraft(m.title, tail, pos, v.reqId);
      this.log(`${v.a.cs} ${v.a.type} ${v.a.airline}: ${m.title}${m.livery ? ' / ' + m.livery : ''} (${m.why})`);
    } catch (e) { this.log('Could not create ' + v.a.cs + ': ' + e.message); }
  }
  onAssigned(r) {
    const cs = this.pending.get(r.requestID); this.pending.delete(r.requestID);
    const v = cs && this.ai.get(cs);
    if (!v) { try { this.handle.aIRemoveObject(r.objectID, this.nextReq++); } catch (e) { /* gone */ } return; }
    v.objectId = r.objectID;
    const ev = (id, val) => this.handle.transmitClientEvent(v.objectId, id, val, PRIORITY_HIGHEST, EventFlag.EVENT_FLAG_GROUPID_IS_PRIORITY);
    ev(EV.FREEZE_LATLON, 1); ev(EV.FREEZE_ALT, 1); ev(EV.FREEZE_ATT, 1);
    v.groundReq = this.nextReq++;
    this.handle.requestDataOnSimObject(v.groundReq, DEF.GROUND, v.objectId, SimConnectPeriod.SECOND);
  }
  remove(a) {
    const v = this.ai.get(a.cs); if (!v) return;
    this.ai.delete(a.cs);
    if (this.connected && v.objectId != null) { try { this.handle.aIRemoveObject(v.objectId, this.nextReq++); } catch (e) { /* gone */ } }
  }
  removeAll() { for (const v of [...this.ai.values()]) this.remove(v.a); }

  // Called ~20 times a second with the smoothed state of each aircraft.
  render(stateOf) {
    if (!this.connected) return;
    for (const v of this.ai.values()) {
      if (v.objectId == null) continue;
      const s = stateOf(v.a);
      let alt = s.alt;
      if (s.onGround && v.groundAlt != null) alt = v.groundAlt + (v.cg || 0);
      const buf = new RawBuffer(48);
      [s.lat, s.lon, alt, s.pitch * PITCH_SIGN, s.bank * BANK_SIGN, s.hdg].forEach(x => buf.writeFloat64(x));
      try { this.handle.setDataOnSimObject(DEF.MOVE, v.objectId, { buffer: buf, arrayCount: 0, tagged: false }); } catch (e) { /* sim busy */ }
      const ev = (id, val) => this.handle.transmitClientEvent(v.objectId, id, val, PRIORITY_HIGHEST, EventFlag.EVENT_FLAG_GROUPID_IS_PRIORITY);
      if (v.gear !== s.gearDown) { v.gear = s.gearDown; ev(s.gearDown ? EV.GEAR_DOWN : EV.GEAR_UP, 0); }
      for (const [k, id] of [['landing', EV.LANDING_LIGHTS], ['strobe', EV.STROBES], ['beacon', EV.BEACON], ['taxi', EV.TAXI]]) {
        if (v.lights[k] !== s.lights[k]) { v.lights[k] = s.lights[k]; ev(id, s.lights[k] ? 1 : 0); }
      }
    }
  }
  stats() {
    const list = [...this.ai.values()];
    return { shown: list.filter(v => v.objectId != null).length, total: list.length, models: this.matcher.models.length,
      matches: list.filter(v => v.model).map(v => ({ cs: v.a.cs, type: v.a.type, airline: v.a.airline, title: v.model.title, livery: v.model.livery, quality: v.model.quality })) };
  }
}

module.exports = { MsfsAdapter };
