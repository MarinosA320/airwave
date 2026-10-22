'use strict';
/*
 * Turns the network's once-a-second traffic updates into smooth motion for the sim.
 * Each aircraft is dead-reckoned from its last report (speed, track, vertical speed), and
 * any jump when a new report arrives is blended out over a second instead of snapping.
 */
const NM_PER_DEG = 60;
const toRad = d => d * Math.PI / 180;
const norm360 = h => ((h % 360) + 360) % 360;
const angleDiff = (a, b) => ((b - a + 540) % 360) - 180;
const BLEND_S = 1.0;
const STALE_S = 12;

function project(s, dt) {
  const nm = s.gs * dt / 3600;
  return {
    lat: s.lat + nm * Math.cos(toRad(s.hdg)) / NM_PER_DEG,
    lon: s.lon + nm * Math.sin(toRad(s.hdg)) / (NM_PER_DEG * Math.cos(toRad(s.lat))),
    alt: s.onGround ? s.alt : s.alt + s.vs * dt / 60
  };
}

class TrafficManager {
  constructor({ maxRange = 60, now = () => Date.now() / 1000 } = {}) {
    this.maxRange = maxRange;
    this.now = now;
    this.aircraft = new Map();   // cs -> state
    this.listeners = { add: [], remove: [] };
  }
  on(ev, fn) { this.listeners[ev].push(fn); }
  emit(ev, a) { for (const fn of this.listeners[ev]) fn(a); }

  // Called with each "traffic" message from the server.
  update(list, own) {
    const t = this.now();
    const seen = new Set();
    for (const r of list) {
      if (own && distNm(own, r) > this.maxRange) continue;
      seen.add(r.cs);
      let a = this.aircraft.get(r.cs);
      if (!a) {
        a = { cs: r.cs, type: r.type, airline: airlineOf(r.cs), fp: r.fp, report: r, reportT: t, offset: { lat: 0, lon: 0, alt: 0 }, offsetT: t, turnRate: 0 };
        this.aircraft.set(r.cs, a);
        this.emit('add', a);
        continue;
      }
      // Where we are currently drawing it, so the new report can be blended in from there.
      const drawn = this.stateAt(a, t);
      const prev = a.report;
      const dtr = Math.max(0.2, t - a.reportT);
      a.turnRate = Math.max(-4, Math.min(4, angleDiff(prev.hdg, r.hdg) / dtr));
      a.report = r; a.reportT = t; a.fp = r.fp; a.type = r.type || a.type;
      a.offset = { lat: drawn.lat - r.lat, lon: drawn.lon - r.lon, alt: drawn.alt - r.alt };
      a.offsetT = t;
      // A big jump (teleport, slew) is not blended.
      if (Math.abs(a.offset.lat) * NM_PER_DEG > 2 || Math.abs(a.offset.alt) > 1500) a.offset = { lat: 0, lon: 0, alt: 0 };
    }
    for (const [cs, a] of this.aircraft) {
      if (!seen.has(cs) || t - a.reportT > STALE_S) { this.aircraft.delete(cs); this.emit('remove', a); }
    }
  }

  // Smoothed position, attitude and configuration for drawing right now.
  stateAt(a, t = this.now()) {
    const r = a.report, dt = Math.min(5, t - a.reportT);
    const hdg = norm360(r.hdg + a.turnRate * dt);
    const p = project({ lat: r.lat, lon: r.lon, alt: r.alt, gs: r.gs, hdg: r.hdg + a.turnRate * dt / 2, vs: r.vs, onGround: r.onGround }, dt);
    const k = Math.max(0, 1 - (t - a.offsetT) / BLEND_S);
    const pitch = r.pitch != null && r.pitch !== 0 ? r.pitch : r.onGround ? 0 : Math.max(-10, Math.min(15, Math.atan2(r.vs, Math.max(60, r.gs) * 101.27) * 180 / Math.PI + 2.5));
    const bank = r.bank != null && r.bank !== 0 ? r.bank : r.onGround ? 0 : Math.max(-30, Math.min(30, a.turnRate * 8));
    const agl = r.alt - (a.groundAlt || 0);
    return {
      lat: p.lat + a.offset.lat * k, lon: p.lon + a.offset.lon * k, alt: p.alt + a.offset.alt * k,
      hdg, pitch, bank, gs: r.gs, onGround: !!r.onGround,
      gearDown: !!r.onGround || (r.vs < 0 && agl < 4000) || (r.vs >= 0 && agl < 1500 && r.gs < 220),
      lights: { nav: true, beacon: true, strobe: !r.onGround || r.gs > 30, landing: !r.onGround ? agl < 10000 : r.gs > 30, taxi: !!r.onGround && r.gs > 3 }
    };
  }

  list() { return [...this.aircraft.values()]; }
}

function airlineOf(cs) { const m = /^([A-Z]{3})\d/.exec(cs || ''); return m ? m[1] : ''; }
function distNm(a, b) {
  const x = (b.lon - a.lon) * Math.cos(toRad((a.lat + b.lat) / 2)) * 60;
  return Math.hypot(x, (b.lat - a.lat) * 60);
}

module.exports = { TrafficManager, airlineOf, distNm };
