'use strict';
/*
 * A pretend simulator for trying Airwave Pilot without MSFS or X-Plane.
 * It flies a simple aircraft that follows ATC heading, altitude and speed instructions.
 */
const { EventEmitter } = require('events');
const toRad = d => d * Math.PI / 180;

class DemoSim extends EventEmitter {
  constructor({ start = { lat: 37.75, lon: 23.70 }, log = () => {} } = {}) {
    super();
    this.log = log;
    this.s = { lat: start.lat, lon: start.lon, alt: 9000, hdg: 40, gs: 250, vs: 0, tHdg: 40, tAlt: 9000, tSpd: 250 };
    this.list = new Map();
    this.frames = 0;
  }
  start() {
    this.emit('status', { sim: 'demo', connected: true, text: 'Demo flight (no simulator)' });
    this.timer = setInterval(() => this.step(0.25), 250);
  }
  stop() { clearInterval(this.timer); }
  // Lets ATC instructions steer the demo aircraft, so the whole loop can be tried.
  follow(instr) {
    if (instr.kind === 'hdg') this.s.tHdg = instr.value;
    if (instr.kind === 'alt') this.s.tAlt = instr.value;
    if (instr.kind === 'spd' && instr.value) this.s.tSpd = instr.value;
  }
  step(dt) {
    const s = this.s;
    const d = ((s.tHdg - s.hdg + 540) % 360) - 180;
    const turn = Math.max(-3 * dt, Math.min(3 * dt, d));
    s.hdg = (s.hdg + turn + 360) % 360;
    s.vs = Math.max(-1800, Math.min(2000, (s.tAlt - s.alt) * 2));
    s.alt += s.vs * dt / 60;
    s.gs += Math.max(-1.5 * dt, Math.min(1.5 * dt, s.tSpd - s.gs));
    const nm = s.gs * dt / 3600;
    s.lat += nm * Math.cos(toRad(s.hdg)) / 60;
    s.lon += nm * Math.sin(toRad(s.hdg)) / (60 * Math.cos(toRad(s.lat)));
    this.emit('position', { lat: s.lat, lon: s.lon, alt: s.alt, hdg: s.hdg, gs: s.gs, vs: s.vs, pitch: 2, bank: turn / dt * 8, onGround: false, squawk: '4521' });
  }
  add(a) { this.list.set(a.cs, a); }
  remove(a) { this.list.delete(a.cs); }
  removeAll() { this.list.clear(); }
  render(stateOf) { this.frames++; for (const a of this.list.values()) a._demoState = stateOf(a); }
  stats() { return { shown: this.list.size, total: this.list.size, models: 0, matches: [] }; }
}

module.exports = { DemoSim };
