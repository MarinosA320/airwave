/*
 * Airwave core: network hub, protocol handling, maps, procedures and simulated traffic.
 * Runs unchanged in Node (the real server) and in the browser (the scope's demo mode).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Airwave = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '0.6.0';

  // ---------------------------------------------------------------- geo helpers
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const norm360 = h => ((h % 360) + 360) % 360;
  const angleDiff = (from, to) => ((to - from + 540) % 360) - 180; // -180..180
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function offsetNm(a, b) { // x east, y north, in nm, from a to b
    return {
      x: (b.lon - a.lon) * Math.cos(toRad((a.lat + b.lat) / 2)) * 60,
      y: (b.lat - a.lat) * 60
    };
  }
  function distNm(a, b) { const o = offsetNm(a, b); return Math.hypot(o.x, o.y); }
  function bearing(a, b) { const o = offsetNm(a, b); return norm360(toDeg(Math.atan2(o.x, o.y))); }
  function move(p, hdg, nm) {
    return {
      lat: p.lat + nm * Math.cos(toRad(hdg)) / 60,
      lon: p.lon + nm * Math.sin(toRad(hdg)) / (60 * Math.cos(toRad(p.lat)))
    };
  }
  function pointInPoly(p, poly) { // poly: [[lat,lon],...]
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > p.lat) !== (yj > p.lat) && p.lon < (xj - xi) * (p.lat - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // ---------------------------------------------------------------- London demo map
  // Approximate positions, for demonstration only. Not for real-world navigation.
  const DEMO_SECTOR = {
    id: 'LON-DEMO',
    name: 'London demo',
    note: 'Approximate positions for demonstration only. Not for real-world navigation.',
    center: { lat: 51.50, lon: -0.20 },
    transitionAlt: 6000,
    sectors: [
      { id: 'N', name: 'North', polygon: [[52.18, -1.05], [52.22, -0.20], [52.12, 0.55], [51.92, 1.05], [51.52, 1.10], [51.50, 0.30], [51.56, -0.40], [51.52, -1.10]] },
      { id: 'S', name: 'South', polygon: [[51.52, -1.10], [51.56, -0.40], [51.50, 0.30], [51.52, 1.10], [51.20, 1.45], [50.88, 1.05], [50.82, 0.10], [50.86, -0.70], [51.05, -1.15]] }
    ],
    facilities: [
      { id: 'LON_CTR', name: 'London Control', freq: '127.100', kind: 'CTR', covers: ['N', 'S'] },
      { id: 'LON_N_CTR', name: 'London Control North', freq: '133.175', kind: 'CTR', covers: ['N'] },
      { id: 'LON_S_CTR', name: 'London Control South', freq: '134.125', kind: 'CTR', covers: ['S'] }
    ],
    unicom: '122.800',
    airports: [
      { icao: 'EGLL', name: 'Heathrow', lat: 51.4700, lon: -0.4543, elev: 83, scheduled: true, runways: [
        { id: '27R', name: '09L/27R', lat: 51.4775, lon: -0.4543, hdg: 270, len: 2.1, active: true },
        { id: '27L', name: '09R/27L', lat: 51.4647, lon: -0.4543, hdg: 270, len: 2.0 }] },
      { icao: 'EGKK', name: 'Gatwick', lat: 51.1481, lon: -0.1903, elev: 202, scheduled: true, runways: [
        { id: '26L', name: '08R/26L', lat: 51.1481, lon: -0.1903, hdg: 258, len: 1.7, active: true }] },
      { icao: 'EGSS', name: 'Stansted', lat: 51.8850, lon: 0.2350, elev: 348, scheduled: true, runways: [
        { id: '22', name: '04/22', lat: 51.8850, lon: 0.2350, hdg: 220, len: 1.65, active: true }] },
      { icao: 'EGGW', name: 'Luton', lat: 51.8747, lon: -0.3683, elev: 526, scheduled: true, runways: [
        { id: '25', name: '07/25', lat: 51.8747, lon: -0.3683, hdg: 255, len: 1.2, active: true }] },
      { icao: 'EGLC', name: 'London City', lat: 51.5053, lon: 0.0553, elev: 19, scheduled: true, runways: [
        { id: '27', name: '09/27', lat: 51.5053, lon: 0.0553, hdg: 273, len: 0.8, active: true }] }
    ],
    fixes: [
      { id: 'BNN', lat: 51.7264, lon: -0.5500, kind: 'vor' },
      { id: 'LAM', lat: 51.6461, lon: 0.1517, kind: 'vor' },
      { id: 'BIG', lat: 51.3311, lon: 0.0347, kind: 'vor' },
      { id: 'OCK', lat: 51.3050, lon: -0.4472, kind: 'vor' },
      { id: 'CPT', lat: 51.4920, lon: -1.2190, kind: 'vor' },
      { id: 'DET', lat: 51.3040, lon: 0.5970, kind: 'vor' },
      { id: 'BKY', lat: 51.9900, lon: 0.0620, kind: 'vor' },
      { id: 'SFD', lat: 50.7600, lon: 0.1220, kind: 'vor' }
    ],
    airways: [['CPT', 'OCK'], ['OCK', 'BIG'], ['BIG', 'DET'], ['BNN', 'BKY'], ['BKY', 'LAM'], ['LAM', 'DET'], ['SFD', 'BIG'], ['CPT', 'BNN']]
  };

  // ---------------------------------------------------------------- maps
  const MAPS = {};
  function registerMap(map) {
    map.fixIndex = new Map();
    for (const f of map.fixes || []) map.fixIndex.set(f.id, f);
    for (const w of map.waypoints || []) if (!map.fixIndex.has(w.id)) map.fixIndex.set(w.id, w);
    for (const ap of map.airports) {
      ap.procedures = ap.procedures || [];
      for (const w of ap.waypoints || []) if (!map.fixIndex.has(w.id)) map.fixIndex.set(w.id, w);
    }
    map.facilities.forEach(f => { if (!f.kind) f.kind = 'CTR'; if (f.rank == null) f.rank = f.kind === 'CTR' ? 4 : 3; });
    const pts = map.sectors.flatMap(s => s.polygon);
    map.bounds = pts.length ? {
      minLat: Math.min(...pts.map(p => p[0])), maxLat: Math.max(...pts.map(p => p[0])),
      minLon: Math.min(...pts.map(p => p[1])), maxLon: Math.max(...pts.map(p => p[1]))
    } : null;
    MAPS[map.id] = map;
    return map;
  }
  registerMap(DEMO_SECTOR);

  function runwayGeometry(rwy) {
    const recip = norm360(rwy.hdg + 180);
    const thr = move(rwy, recip, rwy.len / 2);
    const end = move(rwy, rwy.hdg, rwy.len / 2);
    const faf = move(thr, recip, 8);
    return { thr, end, faf, recip };
  }
  function activeRunway(ap) { return ap.runways.find(r => r.active) || ap.runways[0]; }

  // Procedures: { type: 'SID'|'STAR'|'APP', name, runway, approach: 'ILS'|'LOC'|'RNAV'|'LPV'|'VOR'|'NDB'|..., legs: [{fix, alt, altType, spd}] }
  const APP_PREFERENCE = ['ILS', 'LPV', 'RNAV', 'RNP', 'LOC', 'VOR', 'VORDME', 'NDB', 'VISUAL'];
  function proceduresFor(ap, type, rwyId) {
    return (ap.procedures || []).filter(p => p.type === type && (!rwyId || !p.runway || p.runway === rwyId || p.runway === 'ALL'));
  }
  function bestApproach(ap, rwyId) {
    const list = proceduresFor(ap, 'APP', rwyId);
    return list.sort((a, b) => rank(a) - rank(b))[0] || null;
    function rank(p) { const i = APP_PREFERENCE.indexOf((p.approach || '').toUpperCase()); return i < 0 ? 99 : i; }
  }
  function resolveLegs(map, proc) {
    return (proc.legs || []).map(l => {
      const f = l.lat != null ? l : map.fixIndex.get(l.fix);
      return f ? { id: l.fix || l.id, lat: f.lat, lon: f.lon, alt: l.alt, altType: l.altType || (l.alt ? 'at' : null), spd: l.spd, faf: !!l.faf } : null;
    }).filter(Boolean);
  }
  function taxiTarget(to) {
    const t = String(to || '').toUpperCase().trim();
    let m;
    if ((m = t.match(/^(?:HP|HOLDING POINT)\s*(?:RWY|RUNWAY)?\s*(\d{2}[LRC]?)$/))) return 'holding point runway ' + m[1];
    if ((m = t.match(/^(?:STAND|GATE|S)\s*([A-Z0-9]{1,4})$/))) return 'stand ' + m[1];
    if ((m = t.match(/^(?:RWY|RUNWAY)\s*(\d{2}[LRC]?)$/))) return 'runway ' + m[1];
    return t.toLowerCase();
  }
  // Final approach legs, preceded by the initial-approach transition that starts at `from`, if the chart has one.
  function approachRoute(map, proc, from) {
    if (!proc) return [];
    const tr = from && proc.transitions && proc.transitions[from] ? resolveLegs(map, { legs: proc.transitions[from] }) : [];
    const legs = dedupe(tr.concat(resolveLegs(map, proc)));
    if (legs.length && !legs.some(l => l.faf)) legs[legs.length - 1].faf = true;
    return legs;
  }
  // The transition start nearest to a point (for traffic arriving without a STAR).
  function nearestTransition(map, proc, p) {
    const starts = Object.keys((proc && proc.transitions) || {}).map(id => map.fixIndex.get(id) && { id, f: map.fixIndex.get(id) }).filter(Boolean);
    starts.sort((a, b) => distNm(p, a.f) - distNm(p, b.f));
    return starts[0] ? starts[0].id : null;
  }
  function approachName(proc) {
    if (!proc) return 'approach';
    const k = (proc.approach || '').toUpperCase();
    return (k === 'VORDME' ? 'VOR DME' : k === 'RNAV' ? 'RNP' : k) + ' approach';
  }

  // Magnetic variation (degrees, east positive) from the map's WMM grid, bilinear. 0 if the map has none.
  function magVar(map, p) {
    const g = map && map.magvar; if (!g || !g.rows) return 0;
    const fy = (p.lat - g.lat0) / g.step, fx = (p.lon - g.lon0) / g.step;
    const rows = g.rows, ny = rows.length - 1, nx = rows[0].length - 1;
    const y0 = clamp(Math.floor(fy), 0, ny), x0 = clamp(Math.floor(fx), 0, nx);
    const y1 = Math.min(ny, y0 + 1), x1 = Math.min(nx, x0 + 1);
    const ty = clamp(fy - y0, 0, 1), tx = clamp(fx - x0, 0, 1);
    const a = rows[y0][x0] + (rows[y0][x1] - rows[y0][x0]) * tx, b = rows[y1][x0] + (rows[y1][x1] - rows[y1][x0]) * tx;
    return a + (b - a) * ty;
  }
  // Magnetic bearing from a to b (QDM when a is the aircraft and b the station).
  function magBearing(map, a, b) { return norm360(bearing(a, b) - magVar(map, a)); }

  // ---------------------------------------------------------------- phraseology
  function altPhrase(ft, sector) {
    const ta = (sector && sector.transitionAlt) || 6000;
    return ft > ta ? 'flight level ' + Math.round(ft / 100) : 'altitude ' + ft + ' feet';
  }
  function instrPhrase(kind, value, dir, sector, currentAlt, extra) {
    switch (kind) {
      case 'hdg': return (dir === 'L' ? 'turn left heading ' : dir === 'R' ? 'turn right heading ' : 'fly heading ') + String(value).padStart(3, '0');
      case 'alt': return (currentAlt == null ? '' : value > currentAlt + 100 ? 'climb ' : value < currentAlt - 100 ? 'descend ' : 'maintain ') + altPhrase(value, sector);
      case 'spd': return value ? 'speed ' + value + ' knots' : 'resume normal speed';
      case 'direct': return 'proceed direct ' + value;
      case 'ils': return 'cleared ' + (extra || 'approach') + ' runway ' + value;
      case 'star': return 'cleared ' + value + ' arrival';
      case 'sid': return 'cleared ' + value + ' departure';
      case 'squawk': return 'squawk ' + value;
      case 'taxi': return 'taxi to ' + taxiTarget(value && value.to) + (value && value.via && value.via.length ? ' via ' + value.via.join(', ') : '');
      case 'resume': return 'resume own navigation';
      case 'contact': return 'contact ' + value;
      default: return kind + ' ' + value;
    }
  }

  // ---------------------------------------------------------------- coverage (top-down)
  function facilityCovers(f, p, sec) {
    if (f.area) {
      if (distNm(p, f.area) > f.area.radius) return false;
      if (p.alt != null && f.area.ceiling && p.alt > f.area.ceiling) return false;
      if ((f.kind === 'GND' || f.kind === 'DEL') && !p.onGround) return false;
      if (f.only && (f.only === 'arr') !== !!p.arriving) return false;
      return true;
    }
    return !!sec && (f.covers || []).includes(sec.id);
  }

  // ---------------------------------------------------------------- hub
  const CS_RE = /^[A-Z0-9_]{2,12}$/;

  class Session {
    constructor(hub, id, send) {
      this.hub = hub; this.id = id; this._send = send;
      this.role = null; this.callsign = null; this.freq = null;
      this.pos = null; this.fp = null; this.type = null;
      this.owner = null; this.handoff = null; this.cleared = {};
      this.facility = null; this.isBot = false; this.closed = false;
    }
    send(m) { if (!this.closed) { try { this._send(m); } catch (e) { /* client gone */ } } }
    error(text) { this.send({ t: 'error', text }); }
    close() { this.hub._remove(this); }

    receive(m) {
      if (this.closed || !m || typeof m !== 'object' || typeof m.t !== 'string') return;
      const h = this.hub;
      if (m.t !== 'hello' && !this.role) return this.error('Send hello first.');
      switch (m.t) {
        case 'hello': return h._hello(this, m);
        case 'pos': {
          if (this.role !== 'pilot') return;
          const n = (v, lo, hi, d = 0) => (typeof v === 'number' && isFinite(v) ? clamp(v, lo, hi) : d);
          this.pos = {
            lat: n(m.lat, -90, 90), lon: n(m.lon, -180, 180), alt: Math.round(n(m.alt, -2000, 60000)),
            hdg: Math.round(norm360(n(m.hdg, -720, 720))), gs: Math.round(n(m.gs, 0, 2000)),
            vs: Math.round(n(m.vs, -20000, 20000)), onGround: !!m.onGround,
            pitch: Math.round(n(m.pitch, -90, 90) * 10) / 10, bank: Math.round(n(m.bank, -180, 180) * 10) / 10
          };
          if (typeof m.squawk === 'string' && /^[0-7]{4}$/.test(m.squawk)) this.squawk = m.squawk;
          return;
        }
        case 'fp': {
          if (this.role !== 'pilot') return;
          const s = (v, max) => (typeof v === 'string' ? v.toUpperCase().slice(0, max) : '');
          this.fp = { dep: s(m.dep, 4), arr: s(m.arr, 4), route: s(m.route, 300), cruise: Number(m.cruise) || 0 };
          if (m.type) this.type = s(m.type, 4);
          return;
        }
        case 'tune':
          if (typeof m.freq === 'string' && /^1[1-3]\d\.\d{3}$/.test(m.freq)) this.freq = m.freq;
          return;
        case 'msg': {
          const text = String(m.text || '').slice(0, 240).trim();
          if (!text) return;
          if (m.to) {
            const t = h.byCallsign(String(m.to).toUpperCase());
            if (!t) return this.error(m.to + ' is not connected.');
            const out = { t: 'msg', from: this.callsign, to: t.callsign, text, private: true };
            t.send(out); this.send(out);
            return;
          }
          if (!this.freq) return this.error('Tune a frequency first.');
          h.radio(this.callsign, this.freq, text);
          return;
        }
        case 'instr': return h._instr(this, m);
        case 'assume': return h._assume(this, m);
        case 'release': return h._release(this, m);
        case 'handoff': return h._handoff(this, m);
        case 'ping': return this.send({ t: 'pong', ts: m.ts });
        default: return this.error('Unknown message type ' + m.t + '.');
      }
    }
  }

  class Hub {
    constructor(opts = {}) {
      this.sector = opts.sector ? (opts.sector.fixIndex ? opts.sector : registerMap(opts.sector)) : DEMO_SECTOR;
      this.sessions = new Map();
      this.nextId = 1;
      this.sources = [];
      this.time = 0;
      this.log = opts.log || (() => {});
      this.password = opts.password || '';        // needed by everyone, if set
      this.atcPassword = opts.atcPassword || '';  // needed to log on as a controller, if set
    }
    connect(send) { const s = new Session(this, this.nextId++, send); this.sessions.set(s.id, s); return s; }
    addSource(src) { this.sources.push(src); src.attach(this); return src; }
    byCallsign(cs) { for (const s of this.sessions.values()) if (s.callsign === cs) return s; return null; }
    pilots() { return [...this.sessions.values()].filter(s => s.role === 'pilot' && s.pos); }
    controllers() { return [...this.sessions.values()].filter(s => s.role === 'atc'); }
    airport(icao) { return this.sector.airports.find(a => a.icao === icao); }
    // Next free code in 4001-4777 (octal digits only), skipping codes already in use.
    assignSquawk() {
      const used = new Set();
      for (const p of this.sessions.values()) { if (p.squawk) used.add(p.squawk); if (p.cleared && p.cleared.sq) used.add(p.cleared.sq); }
      this.sqNext = this.sqNext || 0;
      for (let i = 0; i < 512; i++) {
        const n = (this.sqNext + i) % 511 + 1;
        const code = '4' + n.toString(8).padStart(3, '0');
        if (!used.has(code)) { this.sqNext = n; return code; }
      }
      return '4000';
    }

    _remove(s) {
      if (s.closed) return;
      s.closed = true;
      this.sessions.delete(s.id);
      if (s.role === 'atc') {
        for (const p of this.sessions.values()) {
          if (p.owner === s.callsign) p.owner = null;
          if (p.handoff === s.callsign) p.handoff = null;
        }
      }
      if (s.callsign) { this.log(s.callsign + ' disconnected'); this.broadcast({ t: 'left', callsign: s.callsign }); }
    }

    _hello(s, m) {
      if (s.role) return s.error('Already connected.');
      const cs = String(m.callsign || '').toUpperCase();
      if (!CS_RE.test(cs)) return s.error('Callsign must be 2 to 12 letters, digits or underscores.');
      if (this.byCallsign(cs)) return s.error(cs + ' is already in use.');
      const role = m.role === 'atc' ? 'atc' : m.role === 'observer' ? 'observer' : 'pilot';
      const pw = String(m.password || '');
      // Simulated traffic runs inside the server, so it never needs a password.
      if (!s.isBot && this.password && pw !== this.password && !(role === 'atc' && this.atcPassword && pw === this.atcPassword)) return s.error('Wrong network password.');
      if (!s.isBot && role === 'atc' && this.atcPassword && pw !== this.atcPassword) return s.error('Controller positions need the ATC password.');
      if (role === 'atc') {
        const fac = this.sector.facilities.find(f => f.id === m.facility);
        if (!fac) return s.error('Unknown ATC position ' + m.facility + '.');
        s.facility = fac; s.freq = fac.freq;
      }
      s.role = role; s.callsign = cs;
      if (role === 'pilot') { s.type = String(m.aircraft || 'ZZZZ').toUpperCase().slice(0, 4); s.squawk = '2000'; s.freq = this.sector.unicom; }
      s.send({ t: 'welcome', id: s.id, callsign: cs, role, freq: s.freq, facility: s.facility && s.facility.id, version: VERSION, map: { id: this.sector.id, name: this.sector.name } });
      this.log(cs + ' connected as ' + role + (s.facility ? ' (' + s.facility.id + ' ' + s.freq + ')' : ''));
      if (role === 'atc') this.radio('SERVER', s.freq, s.facility.name + ' is now online on ' + s.freq + '.', true);
    }

    _target(atc, m) {
      if (atc.role !== 'atc') { atc.error('Only controllers can do that.'); return null; }
      const t = this.byCallsign(String(m.to || '').toUpperCase());
      if (!t || t.role !== 'pilot') { atc.error((m.to || 'That aircraft') + ' is not connected.'); return null; }
      return t;
    }

    _instr(atc, m) {
      const t = this._target(atc, m); if (!t) return;
      if (t.owner && t.owner !== atc.callsign) return atc.error(t.callsign + ' is controlled by ' + t.owner + '.');
      const kind = String(m.kind);
      let value = m.value, extra = null, procName = null, dir = m.dir === 'L' || m.dir === 'R' ? m.dir : null;
      const arrAp = this.airport(t.fp && t.fp.arr);
      if (kind === 'hdg') { value = Math.round(Number(value)); if (!(value >= 1 && value <= 360)) return atc.error('Heading must be 1 to 360.'); t.cleared.hdg = value; }
      else if (kind === 'alt') { value = Math.round(Number(value)); if (!(value >= 1000 && value <= 45000)) return atc.error('Altitude must be 1000 to 45000 ft.'); t.cleared.alt = value; }
      else if (kind === 'spd') { value = Math.round(Number(value)); if (!(value === 0 || (value >= 130 && value <= 350))) return atc.error('Speed must be 130 to 350 kt, or 0 to cancel.'); t.cleared.spd = value || null; }
      else if (kind === 'direct') {
        value = String(value || '').toUpperCase();
        if (!this.sector.fixIndex.has(value)) return atc.error('Unknown fix ' + value + '.');
        delete t.cleared.hdg;
      }
      else if (kind === 'ils') {
        if (!arrAp) return atc.error(t.callsign + ' is not landing at an airport on this map.');
        const rwy = activeRunway(arrAp);
        let proc = null;
        if (m.value) {
          const want = String(m.value).toUpperCase();
          proc = proceduresFor(arrAp, 'APP').find(p => p.name.toUpperCase() === want);
          if (!proc) return atc.error(arrAp.icao + ' has no approach called ' + m.value + '.');
        } else proc = bestApproach(arrAp, rwy.id);
        value = proc && proc.runway && proc.runway !== 'ALL' ? proc.runway : rwy.id;
        extra = approachName(proc); delete t.cleared.hdg;
        t.cleared.app = proc ? proc.name : 'RWY ' + value;
        procName = proc ? proc.name : null;
      }
      else if (kind === 'sid') {
        const depAp = this.airport(t.fp && t.fp.dep);
        if (!depAp) return atc.error(t.callsign + ' is not departing from an airport on this map.');
        value = String(value || '').toUpperCase();
        if (!proceduresFor(depAp, 'SID').some(p => p.name === value)) return atc.error(depAp.icao + ' has no SID called ' + value + '.');
        t.cleared.sid = value; delete t.cleared.hdg;
      }
      else if (kind === 'squawk') {
        value = String(value || '').toUpperCase();
        if (!value || value === 'AUTO') value = this.assignSquawk();
        if (!/^[0-7]{4}$/.test(value)) return atc.error('A squawk is four digits from 0 to 7, like 4521.');
        if (['7500', '7600', '7700'].includes(value)) return atc.error(value + ' is an emergency code. Choose another squawk.');
        t.cleared.sq = value;
      }
      else if (kind === 'taxi') {
        const v = value && typeof value === 'object' ? value : { to: String(value || '') };
        const to = String(v.to || '').toUpperCase().trim().slice(0, 30);
        const via = (Array.isArray(v.via) ? v.via : String(v.via || '').split(/[\s,]+/)).map(x => String(x).toUpperCase().trim()).filter(Boolean).slice(0, 12);
        if (!to) return atc.error('Say where to taxi, for example HP 03R or stand 204.');
        if (!via.every(x => /^[A-Z0-9]{1,4}$/.test(x))) return atc.error('Taxiway names are letters and digits, like A, B2 or N.');
        value = { to, via }; t.cleared.taxi = taxiTarget(to) + (via.length ? ' via ' + via.join(' ') : '');
      }
      else if (kind === 'star') {
        if (!arrAp) return atc.error(t.callsign + ' is not landing at an airport on this map.');
        value = String(value || '').toUpperCase();
        if (!proceduresFor(arrAp, 'STAR').some(p => p.name === value)) return atc.error(arrAp.icao + ' has no STAR called ' + value + '.');
        t.cleared.star = value; delete t.cleared.hdg;
      }
      else if (kind === 'resume') { delete t.cleared.hdg; }
      else if (kind === 'contact') { value = String(value || ''); }
      else return atc.error('Unknown instruction ' + kind + '.');
      if (!t.owner) t.owner = atc.callsign;
      const text = t.callsign + ', ' + instrPhrase(kind, value, dir, this.sector, t.pos && t.pos.alt, extra);
      this.radio(atc.callsign, atc.freq, text);
      t.send({ t: 'instr', from: atc.callsign, to: t.callsign, kind, value, dir, extra, proc: procName, text });
    }

    _assume(atc, m) {
      const t = this._target(atc, m); if (!t) return;
      if (t.owner && t.owner !== atc.callsign && t.handoff !== atc.callsign) return atc.error(t.callsign + ' is controlled by ' + t.owner + '. Ask for a handoff.');
      const prev = t.owner ? this.byCallsign(t.owner) : null;
      t.owner = atc.callsign; t.handoff = null;
      if (prev && prev !== atc) {
        const text = t.callsign + ', ' + instrPhrase('contact', atc.facility.name + ' ' + atc.freq);
        this.radio(prev.callsign, prev.freq, text);
        t.send({ t: 'instr', from: prev.callsign, to: t.callsign, kind: 'contact', value: atc.freq, text });
      }
    }
    _release(atc, m) {
      const t = this._target(atc, m); if (!t) return;
      if (t.owner === atc.callsign) { t.owner = null; t.handoff = null; t.cleared = {}; }
    }
    _handoff(atc, m) {
      const t = this._target(atc, m); if (!t) return;
      if (t.owner !== atc.callsign) return atc.error('Assume ' + t.callsign + ' before handing it off.');
      const next = this.byCallsign(String(m.next || '').toUpperCase());
      if (!next || next.role !== 'atc') return atc.error((m.next || 'That controller') + ' is not online.');
      t.handoff = next.callsign;
      next.send({ t: 'handoff', from: atc.callsign, callsign: t.callsign });
    }

    radio(from, freq, text, system) {
      const out = { t: 'msg', from, freq, text, system: !!system, at: Date.now() };
      for (const s of this.sessions.values()) if (s.freq === freq || s.role === 'observer') s.send(out);
    }
    broadcast(m) { for (const s of this.sessions.values()) if (!s.isBot) s.send(m); }

    // Which controller an aircraft here should talk to: the most specific online position covering it.
    coverage(p) {
      const sec = this.sector.sectors.find(z => pointInPoly(p, z.polygon));
      let best = null, bk = null;
      for (const c of this.controllers()) {
        const f = c.facility;
        if (!facilityCovers(f, p, sec)) continue;
        const key = f.rank * 100 + (f.covers ? f.covers.length : 0);
        if (!best || key < bk) { best = c; bk = key; }
      }
      return best ? { freq: best.freq, atc: best } : { freq: this.sector.unicom, atc: null };
    }

    snapshot() {
      return this.pilots().map(p => ({
        cs: p.callsign, type: p.type, sq: p.squawk, freq: p.freq, bot: p.isBot,
        lat: +p.pos.lat.toFixed(6), lon: +p.pos.lon.toFixed(6), alt: p.pos.alt, hdg: p.pos.hdg, gs: p.pos.gs, vs: p.pos.vs,
        onGround: p.pos.onGround, pitch: p.pos.pitch, bank: p.pos.bank,
        fp: p.fp, owner: p.owner, handoff: p.handoff, cleared: p.cleared, proc: p.procName || null
      }));
    }

    tick(dt) {
      this.time += dt;
      for (const src of this.sources) src.tick(dt);
      const traffic = this.snapshot();
      const atc = this.controllers().map(c => ({ cs: c.callsign, freq: c.freq, facility: c.facility.id, name: c.facility.name }));
      for (const s of this.sessions.values()) {
        if (s.isBot || !s.role) continue;
        if (s.role === 'pilot') {
          const near = s.pos ? traffic.filter(a => a.cs !== s.callsign && distNm(s.pos, a) < 120) : [];
          s.send({ t: 'traffic', time: this.time, traffic: near, atc });
        } else s.send({ t: 'traffic', time: this.time, traffic, atc });
      }
    }
  }

  // ---------------------------------------------------------------- simulated traffic profiles
  const FAR_POS = {
    EGLL: [51.47, -0.45], EGKK: [51.15, -0.19], EGCC: [53.35, -2.27], EGPH: [55.95, -3.37], EGPF: [55.87, -4.43], EIDW: [53.42, -6.27],
    LFPG: [49.01, 2.55], EHAM: [52.31, 4.76], EDDF: [50.03, 8.57], EDDM: [48.35, 11.79], EDDB: [52.36, 13.50], LSZH: [47.46, 8.55],
    LOWW: [48.11, 16.57], LIRF: [41.80, 12.24], LIMC: [45.63, 8.72], LEMD: [40.47, -3.56], LEBL: [41.30, 2.08], LPPT: [38.77, -9.13],
    EKCH: [55.62, 12.66], ESSA: [59.65, 17.92], ENGM: [60.19, 11.10], EPWA: [52.17, 20.97], LKPR: [50.10, 14.26], LHBP: [47.44, 19.26],
    LROP: [44.57, 26.10], LBSF: [42.70, 23.41], LYBE: [44.82, 20.31], LTFM: [41.26, 28.74], LCLK: [34.88, 33.62], LLBG: [32.01, 34.89],
    HECA: [30.12, 31.41], OMDB: [25.25, 55.36], OTHH: [25.27, 51.61], LGAV: [37.94, 23.94], KJFK: [40.64, -73.78]
  };
  const PROFILES = {
    'LON-DEMO': {
      dest: [['EGLL', 0.42], ['EGKK', 0.24], ['EGSS', 0.15], ['EGGW', 0.11], ['EGLC', 0.08]],
      ops: {
        EGLL: [['BAW', ['A320', 'A321', 'A20N', 'B77W', 'A35K']], ['VIR', ['A35K', 'B789']], ['DLH', ['A20N', 'A321']], ['AFR', ['A320']], ['KLM', ['B738']], ['UAE', ['A388', 'B77W']]],
        EGKK: [['EZY', ['A319', 'A320', 'A20N']], ['BAW', ['A320']], ['WZZ', ['A21N']]],
        EGSS: [['RYR', ['B738', 'B38M']], ['EZY', ['A320']], ['TOM', ['B738']]],
        EGGW: [['EZY', ['A20N', 'A320']], ['WZZ', ['A21N', 'A320']]],
        EGLC: [['CFE', ['E190']], ['KLC', ['E190']]]
      },
      far: ['EGPF', 'EGPH', 'EIDW', 'LFPG', 'EHAM', 'EDDF', 'LEMD', 'LIRF', 'LGAV', 'LSZH', 'EKCH', 'ESSA', 'LPPT', 'OMDB', 'KJFK'],
      domestic: 0, exits: ['CPT', 'DET', 'BKY', 'SFD'], holdRadius: 30, spawnNew: [55, 63], spawnInitial: [22, 60], count: 10
    },
    'GREECE': {
      dest: [['LGAV', 0.30], ['LGTS', 0.10], ['LGIR', 0.08], ['LGRP', 0.06], ['LGKR', 0.05], ['LGSR', 0.05], ['LGMK', 0.05], ['LGZA', 0.04], ['LGKO', 0.04],
        ['LGSA', 0.03], ['LGKV', 0.02], ['LGPZ', 0.02], ['LGKF', 0.02], ['LGSM', 0.02], ['LGIO', 0.02], ['LGMT', 0.02], ['LGPA', 0.01], ['LGNX', 0.01], ['LGRX', 0.01], ['LGKL', 0.01], ['LGSK', 0.01], ['LGKA', 0.01]],
      ops: {
        LGAV: [['AEE', ['A320', 'A20N', 'A321', 'A21N']], ['AEE', ['A20N']], ['OAL', ['DH8D', 'AT76']], ['SEH', ['A20N', 'AT76']], ['RYR', ['B738']], ['EZY', ['A320']], ['WZZ', ['A21N']], ['DLH', ['A20N']], ['BAW', ['A320']], ['AFR', ['A20N']], ['UAE', ['B77W']], ['QTR', ['B788']]],
        LGTS: [['AEE', ['A320', 'A20N']], ['SEH', ['A20N']], ['RYR', ['B738']], ['WZZ', ['A21N']], ['EZY', ['A320']], ['DLH', ['A20N']]],
        _island: [['AEE', ['A320', 'A20N']], ['SEH', ['A20N', 'AT76']], ['RYR', ['B738']], ['EZY', ['A320', 'A20N']], ['TOM', ['B738']], ['EXS', ['B738']], ['TRA', ['B738']], ['CFG', ['A320']]],
        _small: [['OAL', ['AT76', 'DH8D']], ['SEH', ['AT76']]]
      },
      bigIsland: ['LGIR', 'LGRP', 'LGKR', 'LGSR', 'LGMK', 'LGZA', 'LGKO', 'LGSA', 'LGKF', 'LGSM', 'LGPZ', 'LGKV', 'LGMT', 'LGIO'],
      far: ['EGLL', 'EGKK', 'EGCC', 'LFPG', 'EHAM', 'EDDF', 'EDDM', 'EDDB', 'LSZH', 'LOWW', 'LIRF', 'LIMC', 'EKCH', 'ESSA', 'EPWA', 'LKPR', 'LHBP', 'LROP', 'LBSF', 'LTFM', 'LCLK', 'LLBG', 'OMDB', 'OTHH'],
      domestic: 0.4, holdRadius: 30, spawnNew: [70, 90], spawnInitial: [20, 75], count: 24, departRange: 90
    }
  };
  // Airlines that only fly from their own hubs.
  const HOME_BASES = { UAE: ['OMDB'], QTR: ['OTHH'], DLH: ['EDDF', 'EDDM'], BAW: ['EGLL'], AFR: ['LFPG'], KLM: ['EHAM'], VIR: ['KJFK'], CFE: ['EGLC'], KLC: ['EHAM'], TRA: ['EHAM'], EXS: ['EGCC'], CFG: ['EDDF', 'EDDM'] };
  function autoProfile(map) {
    const aps = map.airports.filter(a => a.scheduled !== false);
    return { dest: aps.map(a => [a.icao, 1 / aps.length]), ops: {}, far: Object.keys(FAR_POS), domestic: 0.3, holdRadius: 30, spawnNew: [60, 80], spawnInitial: [20, 60], count: 12, departRange: 90 };
  }

  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

  class SimPilot {
    constructor(src, spec) {
      Object.assign(this, spec);
      this.src = src; this.hub = src.hub; this.sector = this.hub.sector;
      this.atcAlt = null; this.atcSpd = null; this.mode = 'nav'; this.ilsArmed = false;
      this.pending = []; this.t = 0; this.requestedHigher = false; this.done = false;
      this.session = this.hub.connect(m => this.onMsg(m));
      this.session.isBot = true;
      this.session.receive({ t: 'hello', role: 'pilot', callsign: this.cs, aircraft: this.type });
      this.session.receive({ t: 'fp', dep: this.dep, arr: this.arr, route: this.routeText, cruise: this.cruise, type: this.type });
      this.session.squawk = this.squawk;
      this.session.procName = this.procName || null;
      this.freq = this.session.freq;
      this.push();
    }
    get ap() { return this.hub.airport(this.arriving ? this.arr : this.dep); }
    say(text, delay = 1.5 + this.src.rand() * 2) { this.pending.push({ at: this.t + delay, text }); this.pending.sort((a, b) => a.at - b.at); }
    push() {
      this.session.receive({ t: 'pos', lat: this.lat, lon: this.lon, alt: Math.round(this.alt), hdg: Math.round(this.hdg), gs: Math.round(this.gs()), vs: Math.round(this.vs || 0), squawk: this.squawk });
    }
    gs() { return this.ias * (1 + this.alt / 1000 * 0.018); }
    fix(id) { const f = this.sector.fixIndex.get(id); return f ? { id, lat: f.lat, lon: f.lon } : null; }
    approachLegs() { return this.geo.appLegs.length ? this.geo.appLegs.slice() : [Object.assign({ id: 'FAF', faf: true }, this.geo.faf)]; }
    tail() { return this.arriving ? this.approachLegs() : [this.exitPoint]; }

    onMsg(m) {
      if (m.t !== 'instr' || m.to !== this.cs) return;
      const cs = this.cs;
      switch (m.kind) {
        case 'hdg': this.mode = 'hdg'; this.tHdg = m.value; this.turnDir = m.dir; break;
        case 'alt': this.atcAlt = m.value; this.requestedHigher = true; break;
        case 'spd': this.atcSpd = m.value || null; break;
        case 'direct': {
          const f = this.fix(m.value); this.mode = 'nav';
          const i = this.route.findIndex((w, k) => k >= this.wp && w.id === f.id);
          if (i >= 0) this.wp = i;
          else { this.route = [f].concat(this.tail()); this.wp = 0; }
          break;
        }
        case 'star': {
          const star = proceduresFor(this.ap, 'STAR').find(p => p.name === m.value);
          this.route = dedupe(resolveLegs(this.sector, star).concat(this.approachLegs())); this.wp = 0; this.mode = 'nav';
          this.procName = star.name; this.session.procName = star.name;
          break;
        }
        case 'squawk': this.squawk = m.value; break;
        case 'taxi': break;
        case 'sid': {
          if (this.arriving) break;
          const sid = proceduresFor(this.ap, 'SID').find(p => p.name === m.value);
          const legs = resolveLegs(this.sector, sid);
          this.route = legs.concat([this.exitPoint]); this.wp = 0; this.mode = 'nav';
          const top = legs.filter(l => l.alt).pop(); if (top && !this.atcAlt) this.initialClimb = top.alt;
          this.procName = sid.name; this.session.procName = sid.name;
          break;
        }
        case 'ils':
          {
            const proc = m.proc ? proceduresFor(this.ap, 'APP').find(p => p.name === m.proc) : bestApproach(this.ap, this.geo.rwy.id);
            if (proc) {
              // Join the transition that starts at the next fix on the current route, if there is one.
              const ahead = this.mode === 'nav' ? this.route.slice(this.wp).map(w => w.id) : [];
              const from = ahead.find(id => proc.transitions && proc.transitions[id]);
              const legs = approachRoute(this.sector, proc, from || (this.mode === 'nav' ? null : nearestTransition(this.sector, proc, this)));
              if (legs.length) {
                this.geo.appLegs = legs;
                if (this.mode !== 'hdg') {
                  const i = from ? ahead.indexOf(from) : -1;
                  this.route = dedupe((i >= 0 ? this.route.slice(this.wp, this.wp + i) : []).concat(legs)); this.wp = 0;
                }
              }
            }
          }
          if (this.mode === 'hdg') this.ilsArmed = true;
          else this.mode = 'nav';
          break;
        case 'resume': this.mode = 'nav'; break;
        case 'contact': {
          const freq = (String(m.value).match(/1\d\d\.\d{3}/) || [])[0];
          this.say((freq || m.value) + ', ' + cs);
          if (freq) { this.contactPending = true; setTimeoutLike(this, 4, () => { this.contactPending = false; this.tune(freq); this.checkIn(); }); }
          return;
        }
      }
      const from = this.hub.byCallsign(m.from);
      if (from && from.freq && from.freq !== this.freq && !this.contactPending) this.tune(from.freq);
      const rb = instrPhrase(m.kind, m.value, m.dir, this.sector, this.alt, m.extra);
      this.say(rb.charAt(0).toUpperCase() + rb.slice(1) + ', ' + cs);
    }

    tune(freq) { this.freq = freq; this.session.receive({ t: 'tune', freq }); }
    checkIn() {
      const ownerS = this.session.owner && this.hub.byCallsign(this.session.owner);
      const cov = this.hub.coverage(this);
      const name = ownerS ? ownerS.facility.name : cov.atc ? cov.atc.facility.name : null;
      if (!name) return;
      const level = this.alt > (this.sector.transitionAlt || 6000) ? 'flight level ' + Math.round(this.alt / 100) : Math.round(this.alt / 100) * 100 + ' feet';
      const tgt = this.targetAlt();
      const trend = tgt > this.alt + 300 ? ' climbing ' + altPhrase(tgt, this.sector) : tgt < this.alt - 300 ? ' descending ' + altPhrase(tgt, this.sector) : '';
      this.say(name + ', ' + this.cs + ', ' + level + trend + (this.arriving ? ', inbound ' + this.arr : '') + (this.procName ? ', ' + this.procName : ''));
    }

    targetAlt() {
      if (this.mode === 'final') return this.gsAlt;
      if (this.atcAlt) return this.atcAlt;
      const next = this.mode === 'nav' ? this.route[this.wp] : null;
      if (this.arriving) {
        const d = distNm(this, this.geo.thr);
        let alt = Math.min(this.cruise, Math.max(this.ap.elev + 3000, Math.round(d * 290 / 1000) * 1000));
        if (next && next.alt && (next.altType === 'at' || next.altType === 'above')) alt = Math.max(alt, next.alt);
        if (next && next.alt && next.altType === 'below') alt = Math.min(alt, next.alt);
        // Arrivals never climb on their own, except to meet an "at or above" constraint.
        const floor = next && next.alt && (next.altType === 'at' || next.altType === 'above') ? next.alt : 0;
        return Math.min(alt, Math.max(this.alt, floor));
      }
      const hasAtc = !!this.session.owner || !!this.hub.coverage(this).atc;
      return hasAtc ? this.initialClimb : (distNm(this, this.ap) > 12 ? this.cruise : this.initialClimb);
    }
    targetSpd() {
      if (this.atcSpd) return this.atcSpd;
      const next = this.mode === 'nav' ? this.route[this.wp] : null;
      if (next && next.spd) return next.spd;
      if (this.mode === 'final') { const d = distNm(this, this.geo.thr); return d < 5 ? 140 : 165; }
      if (this.arriving) { const d = distNm(this, this.geo.thr); if (d < 14) return 185; if (d < 28) return 220; }
      const slow = this.type === 'AT76' || this.type === 'DH8D';
      return this.alt < 10000 ? (slow ? 210 : 250) : (slow ? 240 : 290);
    }

    step(dt) {
      this.t += dt;
      while (this.pending.length && this.pending[0].at <= this.t) {
        const p = this.pending.shift();
        if (p.fn) p.fn(); else this.session.receive({ t: 'msg', freq: this.freq, text: p.text });
      }
      // Frequency follows the controlling controller, otherwise the most specific online position (top-down).
      if (!this.contactPending) {
        const owner = this.session.owner && this.hub.byCallsign(this.session.owner);
        const cov = owner ? { freq: owner.freq, atc: owner } : this.hub.coverage(this);
        if (cov.freq !== this.freq) { this.tune(cov.freq); if (cov.atc && !owner) this.checkIn(); }
      }
      const geo = this.geo;
      // Lateral
      let tHdg = this.hdg, dir = null;
      if (this.mode === 'hdg') {
        tHdg = this.tHdg; dir = this.turnDir;
        if (this.ilsArmed) {
          const xt = this.crossTrack();
          if (Math.abs(xt.xt) < 1.0 && xt.along > 2 && xt.along < 25 && Math.abs(angleDiff(this.hdg, geo.rwy.hdg)) < 75) {
            this.mode = 'final'; this.ilsArmed = false; this.turnDir = null;
          }
        }
      }
      if (this.mode === 'nav') {
        const wp = this.route[this.wp];
        if (!wp) { if (this.arriving) this.mode = 'final'; }
        else {
          tHdg = bearing(this, wp);
          const capture = clamp(this.gs() / 160, 1.2, 2.5);
          if (distNm(this, wp) < capture) {
            this.wp++;
            if (this.arriving && wp.faf) this.mode = 'final';
          }
        }
      }
      if (this.mode === 'final') {
        const xt = this.crossTrack();
        tHdg = norm360(geo.rwy.hdg - clamp(xt.xt * 35, -35, 35));
        this.gsAlt = Math.max(this.ap.elev, this.ap.elev + 50 + xt.along * 318);
        if (xt.along < 0.2) return this.finish('landed at ' + this.arr);
      }
      const diff = angleDiff(this.hdg, tHdg);
      let turn = diff;
      if (dir === 'L' && diff > 0 && Math.abs(diff) > 2) turn = diff - 360;
      if (dir === 'R' && diff < 0 && Math.abs(diff) > 2) turn = diff + 360;
      if (Math.abs(diff) < 2) this.turnDir = null;
      this.hdg = norm360(this.hdg + clamp(turn, -3 * dt, 3 * dt));
      // Vertical
      const tAlt = this.targetAlt();
      const rate = this.mode === 'final' ? 900 : tAlt > this.alt ? 2200 : 1800;
      const dAlt = clamp(tAlt - this.alt, -rate * dt / 60, rate * dt / 60);
      if (this.mode === 'final') this.alt = Math.min(this.alt, Math.max(this.alt + dAlt, this.gsAlt));
      else this.alt += dAlt;
      this.vs = dAlt / dt * 60;
      // Speed
      const tSpd = Math.min(this.targetSpd(), this.alt < 10000 ? 250 : 999);
      this.ias += clamp(tSpd - this.ias, -1.5 * dt, 2 * dt);
      // Move
      const p = move(this, this.hdg, this.gs() * dt / 3600);
      this.lat = p.lat; this.lon = p.lon;
      // Departures that have levelled off with a controller ask for climb once.
      if (!this.arriving && !this.requestedHigher && this.session.owner && this.alt >= this.initialClimb - 100) {
        this.requestedHigher = true; this.say('request climb, ' + this.cs, 3);
      }
      if (!this.arriving && distNm(this, this.depRef) > this.departRange) return this.finish('left the area');
      if (this.arriving && distNm(this, geo.thr) > 160) return this.finish('left the area');
      this.push();
    }

    crossTrack() {
      const o = offsetNm(this.geo.thr, this);
      const u = { x: Math.sin(toRad(this.geo.rwy.hdg)), y: Math.cos(toRad(this.geo.rwy.hdg)) };
      return { along: -(o.x * u.x + o.y * u.y), xt: o.x * u.y - o.y * u.x };
    }
    finish(why) { this.done = true; this.session.close(); this.hub.log(this.cs + ' ' + why); }
  }

  function setTimeoutLike(pilot, delay, fn) { pilot.pending.push({ at: pilot.t + delay, fn }); pilot.pending.sort((a, b) => a.at - b.at); }

  class SimTrafficSource {
    constructor(opts = {}) {
      this.opts = opts;
      this.rand = rng(opts.seed || Date.now());
      this.pilots = []; this.used = new Set(); this.cooldown = 0;
      this.substep = opts.substep || 0.5;
    }
    attach(hub) {
      this.hub = hub;
      this.profile = PROFILES[hub.sector.id] || autoProfile(hub.sector);
      this.target = this.opts.count == null ? this.profile.count : this.opts.count;
      for (let i = 0; i < this.target; i++) this.spawn(true);
    }
    pick(arr) { return arr[Math.floor(this.rand() * arr.length)]; }
    between([a, b]) { return a + this.rand() * (b - a); }
    pickDest() {
      const list = this.profile.dest.filter(([k]) => this.hub.airport(k));
      const total = list.reduce((s, [, w]) => s + w, 0);
      let r = this.rand() * total;
      for (const [k, w] of list) { if ((r -= w) < 0) return k; }
      return list[0][0];
    }
    operatorsFor(icao) {
      const P = this.profile;
      if (P.ops[icao]) return P.ops[icao];
      if (P.bigIsland && P.bigIsland.includes(icao)) return P.ops._island;
      return P.ops._small || [['ZZZ', ['A320']]];
    }
    otherEnd(icao, op) {
      const P = this.profile;
      const domesticOp = ['OAL', 'SEH'].includes(op) || (op === 'AEE' && this.rand() < 0.5);
      if ((P.domestic && this.rand() < P.domestic) || domesticOp) {
        const opts = P.dest.map(d => d[0]).filter(k => k !== icao && this.hub.airport(k));
        if (opts.length) { const k = this.pick(opts); const a = this.hub.airport(k); return { icao: k, lat: a.lat, lon: a.lon }; }
      }
      const home = HOME_BASES[op] && HOME_BASES[op].filter(f => FAR_POS[f] && f !== icao);
      const k = home && home.length ? this.pick(home) : this.pick(P.far.filter(f => FAR_POS[f] && f !== icao));
      return { icao: k, lat: FAR_POS[k][0], lon: FAR_POS[k][1] };
    }

    spawn(initial, attempt) {
      const S = this.hub.sector, P = this.profile;
      const icao = this.pickDest();
      const ap = this.hub.airport(icao);
      const rwy = activeRunway(ap);
      const g = runwayGeometry(rwy);
      const app = bestApproach(ap, rwy.id);
      const geo = Object.assign({ rwy, appLegs: approachRoute(S, app, null) }, g);
      const [op, types] = this.pick(this.operatorsFor(icao));
      let cs; do { cs = op + (100 + Math.floor(this.rand() * 8900)); } while (this.used.has(cs) || this.hub.byCallsign(cs));
      const type = this.pick(types);
      const squawk = Array.from({ length: 4 }, () => Math.floor(this.rand() * 8)).join('');
      const other = this.otherEnd(icao, op);
      const arriving = this.rand() < 0.55;
      const turboprop = type === 'AT76' || type === 'DH8D';
      const cruise = (turboprop ? 170 + Math.floor(this.rand() * 6) * 10 : type === 'E190' ? 280 : 340 + Math.floor(this.rand() * 4) * 10) * 100;
      const spec = { cs, type, squawk, arriving, geo, cruise, departRange: P.departRange || 75, initialClimb: 6000 };
      if (arriving) {
        const inbound = bearing(ap, other) + (this.rand() - 0.5) * 50;
        const dist = initial ? this.between(P.spawnInitial) : this.between(P.spawnNew);
        const p = move(ap, P.exits ? this.rand() * 360 : inbound, dist);
        const stars = proceduresFor(ap, 'STAR', rwy.id);
        let route, routeText, procName = null;
        if (stars.length) {
          const star = stars.map(s => ({ s, legs: resolveLegs(S, s) })).filter(x => x.legs.length).sort((a, b) => distNm(p, a.legs[0]) - distNm(p, b.legs[0]))[0];
          if (star) {
            const end = star.legs[star.legs.length - 1].id;
            if (app && app.transitions && app.transitions[end]) geo.appLegs = approachRoute(S, app, end);
            route = dedupe(star.legs.concat(appLegsOr(geo))); procName = star.s.name; routeText = star.s.name + ' ' + (app ? app.name : 'RWY' + rwy.id);
          }
        }
        if (!route && app && app.transitions) {
          const from = nearestTransition(S, app, p);
          if (from) { geo.appLegs = approachRoute(S, app, from); route = appLegsOr(geo); routeText = app.name + ' via ' + from; }
        }
        if (!route) {
          const hold = S.fixes.filter(f => distNm(f, ap) < P.holdRadius).sort((a, b) => distNm(p, a) - distNm(p, b))[0];
          const useHold = hold && distNm(p, hold) + 3 < distNm(p, g.faf) + 10 && distNm(hold, g.faf) > 3;
          route = (useHold ? [{ id: hold.id, lat: hold.lat, lon: hold.lon }] : []).concat(appLegsOr(geo));
          routeText = (useHold ? hold.id + ' ' : '') + (app ? app.name : 'RWY' + rwy.id);
        }
        const alt = clamp(Math.round(dist * 290 / 1000) * 1000, 5000, cruise);
        Object.assign(spec, { dep: other.icao, arr: icao, lat: p.lat, lon: p.lon, alt, ias: alt > 10000 ? (turboprop ? 230 : 290) : 230, route, wp: 0, routeText, procName });
        spec.hdg = bearing(p, route[0]);
      } else {
        const sids = proceduresFor(ap, 'SID', rwy.id);
        const start = move(g.end, rwy.hdg, 1);
        let exitPoint, routeText, procName = null, sidLegs = [];
        if (P.exits) { const f = S.fixIndex.get(this.pick(P.exits)); exitPoint = { id: f.id, lat: f.lat, lon: f.lon }; routeText = rwy.id + ' ' + f.id + ' DCT'; }
        else { const b = bearing(ap, other); exitPoint = Object.assign({ id: 'EXIT' }, move(ap, b, (P.departRange || 90) + 30)); routeText = rwy.id + ' DCT ' + other.icao; }
        if (sids.length) {
          const sid = sids.map(s => ({ s, legs: resolveLegs(S, s) })).filter(x => x.legs.length).sort((a, b) => distNm(exitPoint, a.legs[a.legs.length - 1]) - distNm(exitPoint, b.legs[b.legs.length - 1]))[0];
          if (sid) { sidLegs = sid.legs; procName = sid.s.name; routeText = rwy.id + ' ' + sid.s.name + ' DCT ' + other.icao; const top = sid.legs.filter(l => l.alt).pop(); if (top) spec.initialClimb = top.alt; }
        }
        const route = [Object.assign({ id: 'RWY' }, move(start, rwy.hdg, 4))].concat(sidLegs, [exitPoint]);
        const along = initial ? this.between([2, 25]) : 2;
        let p = move(start, rwy.hdg, Math.min(along, 5)), wp = 0;
        if (along > 6) { wp = 1; p = move(route[0], bearing(route[0], route[1]), Math.min(along - 5, distNm(route[0], route[1]) - 2)); }
        const alt = clamp(ap.elev + along * 350, 1500, spec.initialClimb);
        Object.assign(spec, { dep: icao, arr: other.icao, lat: p.lat, lon: p.lon, alt, ias: along > 6 ? 250 : 190, route, wp, exitPoint, routeText, procName, depRef: { lat: ap.lat, lon: ap.lon } });
        spec.hdg = bearing(p, route[wp]);
      }
      if (P.exits && !spec.depRef) spec.depRef = S.center;
      if (P.exits) { spec.depRef = S.center; spec.departRange = 75; }
      // Keep new traffic clear of existing traffic so the sim doesn't start with a conflict.
      const tooClose = this.pilots.some(q => !q.done && distNm(q, spec) < 8 && Math.abs(q.alt - spec.alt) < 2000);
      if (tooClose) return (attempt || 0) < 12 ? this.spawn(initial, (attempt || 0) + 1) : null;
      this.used.add(cs);
      this.pilots.push(new SimPilot(this, spec));
    }

    tick(dt) {
      let left = dt;
      while (left > 1e-6) {
        const h = Math.min(this.substep, left); left -= h;
        for (const p of this.pilots) if (!p.done) p.step(h);
      }
      this.pilots = this.pilots.filter(p => !p.done);
      this.cooldown -= dt;
      if (this.pilots.length < this.target && this.cooldown <= 0) { this.spawn(false); this.cooldown = (20 + this.rand() * 30) * 10 / Math.max(10, this.target); }
    }
    setCount(n) { this.target = n; }
  }
  function dedupe(route) { return route.filter((w, i) => !i || w.id !== route[i - 1].id || w.id === 'FAF'); }
  function appLegsOr(geo) { return geo.appLegs.length ? geo.appLegs.map(l => Object.assign({}, l)) : [Object.assign({ id: 'FAF', faf: true }, geo.faf)]; }

  return {
    VERSION, Hub, SimTrafficSource, DEMO_SECTOR, MAPS, registerMap,
    geo: { distNm, bearing, move, offsetNm, pointInPoly, angleDiff, norm360 },
    runwayGeometry, activeRunway, proceduresFor, bestApproach, resolveLegs, approachRoute, instrPhrase, altPhrase, magVar, magBearing, taxiTarget
  };
});
