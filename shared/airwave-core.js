/*
 * Airwave core: network hub, protocol handling, maps, procedures and simulated traffic.
 * Runs unchanged in Node (the real server) and in the browser (the scope's demo mode).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Airwave = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '0.9.1';

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
  // A runway record describes one strip from its "id" end; "name" lists both ends ("03R/21L").
  function runwayEnd(ap, id) {
    for (const r of ap.runways) {
      if (r.id === id) return r;
      if ((r.name || '').split('/').includes(id)) return Object.assign({}, r, { id, hdg: norm360(r.hdg + 180), active: false });
    }
    return null;
  }
  function runwayEndIds(ap) { return [...new Set(ap.runways.flatMap(r => (r.name || r.id).split('/')))]; }
  // Runways in use for arrivals ('arr') or departures ('dep'): set live by controllers (ap.cfg),
  // or the map's default (ap.runwayConfig), or the single default runway.
  function runwaysInUse(ap, kind) {
    const cfg = ap.cfg || ap.runwayConfig;
    const ids = cfg && cfg[kind] && cfg[kind].length ? cfg[kind] : [activeRunway(ap).id];
    const out = ids.map(id => runwayEnd(ap, id)).filter(Boolean);
    return out.length ? out : [activeRunway(ap)];
  }

  // ---------------------------------------------------------------- map overlay (edits made in the sector editor)
  // The overlay replaces whole categories it contains, so an edit never half-merges with the base data.
  function applyOverlay(base, ov) {
    const m = JSON.parse(JSON.stringify(base, (k, v) => (k === 'fixIndex' ? undefined : v)));
    if (!ov) return m;
    if (Array.isArray(ov.sectors)) m.sectors = ov.sectors;
    if (Array.isArray(ov.facilities)) m.facilities = ov.facilities;
    if (ov.fixes) {
      const byId = new Map(m.fixes.map(f => [f.id, f]));
      for (const id of ov.fixes.remove || []) byId.delete(id);
      for (const f of ov.fixes.upsert || []) byId.set(f.id, Object.assign({}, byId.get(f.id), f));
      m.fixes = [...byId.values()];
    }
    if (Array.isArray(ov.airways)) m.airways = ov.airways;
    for (const [icao, a] of Object.entries(ov.airports || {})) {
      const ap = m.airports.find(x => x.icao === icao); if (!ap) continue;
      for (const k of ['procedures', 'waypoints', 'layout', 'runwayConfig']) if (a[k]) ap[k] = a[k];
    }
    m.overlayRev = ov.rev || 0;
    return m;
  }

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
      case 'spd': return value ? 'speed ' + value + ' knots' : 'no ATC speed restriction';
      case 'direct': return 'proceed direct ' + value;
      case 'ils': return 'cleared ' + (extra || 'approach') + ' runway ' + value;
      case 'star': return 'cleared ' + value + ' arrival';
      case 'sid': return 'cleared ' + value + ' departure';
      case 'squawk': return 'squawk ' + value;
      case 'taxi': return 'taxi to ' + taxiTarget(value && value.to) + (value && value.via && value.via.length ? ' via ' + value.via.join(', ') : '');
      case 'resume': return 'resume own navigation';
      case 'contact': return 'contact ' + value;
      case 'clearance': {
        const v = value || {};
        if (v.type === 'VFR') return 'cleared VFR' + (v.dest ? ' to ' + v.dest : '') + (v.route ? ' via ' + v.route : '') + (v.alt ? ', not above ' + altPhrase(v.alt, sector) : '') + ', squawk ' + v.sq;
        return 'cleared to ' + (v.dest || 'destination') + (v.sid ? ' via ' + v.sid + ' departure' : ' via flight planned route') + (v.rwy ? ', runway ' + v.rwy : '') + (v.alt ? ', climb initially ' + altPhrase(v.alt, sector) : '') + ', squawk ' + v.sq;
      }
      case 'pushback': return 'push back and start up approved' + (value ? ', facing ' + value : '');
      case 'lineup': return 'runway ' + value + ', line up and wait';
      case 'takeoff': return (extra ? extra + ', ' : '') + 'runway ' + value + ', cleared for take-off';
      case 'land': return (extra ? extra + ', ' : '') + 'runway ' + value + ', cleared to land';
      case 'goaround': return 'go around, I say again, go around' + (extra ? ', ' + extra : ', fly published missed approach');
      case 'holdshort': return 'hold short of runway ' + value;
      case 'cross': return 'cross runway ' + value;
      case 'rwy': return 'expect runway ' + value;
      case 'text': case 'reply': return String(value || '');
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

  // ---------------------------------------------------------------- ground movement on airport layouts
  // A layout is ap.layout (edited in the sector editor) or ap.ground (OpenStreetMap, attached by the server).
  function groundOf(ap) { return (ap && (ap.layout || ap.ground)) || null; }
  const hide = (o, k, v) => Object.defineProperty(o, k, { value: v, writable: true, configurable: true, enumerable: false });
  // Taxiway network: nodes are taxiway points; OpenStreetMap taxiways share points where they meet.
  function taxiGraph(ap) {
    const L = groundOf(ap);
    if (!L || !L.taxiways || !L.taxiways.length) return null;
    if (ap._graph && ap._graph.L === L) return ap._graph;
    const nodes = new Map();
    const node = q => { const k = (+q[0]).toFixed(6) + ',' + (+q[1]).toFixed(6); let n = nodes.get(k); if (!n) { n = { lat: +q[0], lon: +q[1], e: [] }; nodes.set(k, n); } return n; };
    for (const t of L.taxiways) {
      const ref = String(t.ref || '').toUpperCase();
      for (let i = 1; i < t.line.length; i++) {
        const a = node(t.line[i - 1]), b = node(t.line[i]);
        if (a === b) continue;
        const d = distNm(a, b); a.e.push({ n: b, d, ref }); b.e.push({ n: a, d, ref });
      }
    }
    const g = { L, nodes: [...nodes.values()] };
    hide(ap, '_graph', g);
    return g;
  }
  function nearestNodes(g, p, count, filter) {
    const out = [];
    for (const n of g.nodes) if (n.e.length && (!filter || filter(n))) out.push([distNm(p, n), n]);
    out.sort((a, b) => a[0] - b[0]);
    return out.slice(0, count).map(x => x[1]);
  }
  // Shortest taxi route (Dijkstra). Taxiways named in "prefer" (a clearance's "via") count as shorter.
  function taxiPath(g, from, to, prefer) {
    if (from === to) return [{ lat: from.lat, lon: from.lon, ref: '' }];
    const dist = new Map([[from, 0]]), prev = new Map(), done = new Set(), heap = [[0, from]];
    const up = () => { let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
      return top;
    };
    while (heap.length) {
      const [d, n] = pop();
      if (done.has(n)) continue;
      done.add(n);
      if (n === to) break;
      for (const e of n.e) {
        const nd = d + e.d * (prefer && prefer.size && !prefer.has(e.ref) ? 2.5 : 1);
        if (nd < (dist.has(e.n) ? dist.get(e.n) : Infinity)) { dist.set(e.n, nd); prev.set(e.n, { n, ref: e.ref }); heap.push([nd, e.n]); up(); }
      }
    }
    if (!done.has(to)) return null;
    const pts = []; let c = to;
    while (c !== from) { const p = prev.get(c); pts.push({ lat: c.lat, lon: c.lon, ref: p.ref }); c = p.n; }
    pts.push({ lat: from.lat, lon: from.lon, ref: '' });
    return pts.reverse();
  }
  // Route between any two points, through the nearest taxiway points that connect.
  function groundRoute(g, a, b, prefer) {
    const froms = a.e ? [a] : nearestNodes(g, a, 4), tos = b.e ? [b] : nearestNodes(g, b, 6);
    for (const f of froms) for (const t of tos) { const p = taxiPath(g, f, t, prefer); if (p) return p; }
    return null;
  }
  // Runway positions from OurAirports can be tens of metres off. Where the OpenStreetMap layout has the runway,
  // use its ends instead, so traffic rolls down the real centreline (only when both agree roughly).
  function refineRunways(ap) {
    const L = groundOf(ap); if (!L || !L.runways || !L.runways.length) return 0;
    let n = 0;
    for (const r of ap.runways) {
      const ends = (r.name || r.id).split('/');
      const pts = L.runways.filter(x => x.ref && x.ref.split(/[/ ]/).some(e => ends.includes(e.replace(/^0(?=\d[LRC]?$)/, '0')) || ends.includes(e))).flatMap(x => x.line.map(q => ({ lat: q[0], lon: q[1] })));
      if (pts.length < 2) continue;
      let a = pts[0], b = pts[1], best = 0;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) { const d = distNm(pts[i], pts[j]); if (d > best) { best = d; a = pts[i]; b = pts[j]; } }
      let hdg = bearing(a, b);
      if (Math.abs(angleDiff(hdg, r.hdg)) > 90) { [a, b] = [b, a]; hdg = norm360(hdg + 180); }
      // Move the centre sideways onto the mapped centreline; keep the published length (mapped runways are often split).
      const o = offsetNm(a, r), u = { x: Math.sin(toRad(hdg)), y: Math.cos(toRad(hdg)) };
      const along = o.x * u.x + o.y * u.y, side = Math.abs(o.x * u.y - o.y * u.x);
      if (Math.abs(angleDiff(hdg, r.hdg)) > 10 || side > 0.15) continue;
      const c = move(a, hdg, along);
      Object.assign(r, { lat: +c.lat.toFixed(6), lon: +c.lon.toFixed(6), hdg: +hdg.toFixed(1), len: +Math.max(r.len, best).toFixed(3) });
      n++;
    }
    return n;
  }
  function viaOf(path) { const out = []; for (const p of path) if (p.ref && /^[A-Z0-9]{1,4}$/.test(p.ref) && out[out.length - 1] !== p.ref) out.push(p.ref); return out; }
  // Position relative to a runway end: "along" from its threshold (NM, positive down the runway), "off" the centreline.
  function runwayFrame(rwy, p) {
    const g = runwayGeometry(rwy);
    const o = offsetNm(g.thr, p), u = { x: Math.sin(toRad(rwy.hdg)), y: Math.cos(toRad(rwy.hdg)) };
    return { along: o.x * u.x + o.y * u.y, off: Math.abs(o.x * u.y - o.y * u.x), g };
  }
  // Where departures join a runway: the taxiway point on the centreline nearest the threshold.
  function runwayEntry(g, rwy) {
    let best = null, bd = Infinity;
    for (const n of g.nodes) {
      if (!n.e.length) continue;
      const f = runwayFrame(rwy, n);
      if (f.off < 0.03 && f.along > -0.1 && f.along < 0.4 && n.e.some(e => runwayFrame(rwy, e.n).off > 0.03)) { const d = Math.abs(f.along); if (d < bd) { bd = d; best = n; } }
    }
    return best;
  }

  // ---------------------------------------------------------------- weather and ATIS
  const PHONETIC = ['Alfa', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett', 'Kilo', 'Lima', 'Mike', 'November', 'Oscar', 'Papa', 'Quebec', 'Romeo', 'Sierra', 'Tango', 'Uniform', 'Victor', 'Whiskey', 'X-ray', 'Yankee', 'Zulu'];
  function windText(w) {
    if (!w) return '';
    if (!w.wspd) return 'wind calm';
    const dir = w.wdir === 'VRB' || w.wdir == null ? 'variable' : String(Math.round(w.wdir / 10) * 10 || 360).padStart(3, '0') + ' degrees';
    return 'wind ' + dir + ' ' + Math.round(w.wspd) + ' knots' + (w.wgst ? ' gusting ' + Math.round(w.wgst) : '');
  }
  // Used when no real METAR is available: wind roughly down the runway in use, so the runway choice makes sense.
  function simulatedWeather(ap, now) {
    const hour = Math.floor(now / 3600000);
    const h = (ap.icao.charCodeAt(2) * 31 + ap.icao.charCodeAt(3) * 17 + hour * 7) % 100;
    const rwy = runwaysInUse(ap, 'arr')[0];
    return { wdir: Math.round(norm360(rwy.hdg + 5 + (h % 30) - 15) / 10) * 10 || 360, wspd: 4 + (h % 9), visib: 10, qnh: 1009 + (h % 11), temp: 14 + (h % 13), dewp: 6 + (h % 7), clouds: [], simulated: true };
  }

  // ---------------------------------------------------------------- pilot requests
  // kind: what the pilot asks for; arg: what the value is; initial: a first call that names the station.
  const REQUESTS = {
    ifr: { arg: 'dest', initial: true, say: (v, c) => (c.stand ? 'stand ' + c.stand + ', ' : '') + (c.atis ? 'information ' + c.atis + ', ' : '') + 'request IFR clearance' + (v ? ' to ' + v : '') },
    vfr: { arg: 'dest', initial: true, say: (v, c) => (c.stand ? 'stand ' + c.stand + ', ' : '') + (c.atis ? 'information ' + c.atis + ', ' : '') + 'request VFR clearance' + (v ? ' to ' + v : '') },
    startup: { initial: true, say: (v, c) => (c.stand ? 'stand ' + c.stand + ', ' : '') + 'request start-up and pushback' },
    taxi: { initial: true, say: (v, c) => (c.stand ? 'stand ' + c.stand + ', ' : '') + 'request taxi' + (v ? ' to ' + v : '') },
    twy: { arg: 'twy', say: v => 'request taxi via ' + v },
    intersection: { arg: 'twy', say: v => 'request intersection departure from ' + v },
    ready: { initial: true, say: (v, c) => 'ready for departure' + (v || c.rwy ? ', runway ' + (v || c.rwy) : '') },
    vacated: { initial: true, say: (v, c) => 'runway' + (v || c.rwy ? ' ' + (v || c.rwy) : '') + ' vacated' + (c.via ? ' via ' + c.via : '') + (c.stand ? ', request taxi to stand ' + c.stand : '') },
    rwy: { arg: 'rwy', say: v => 'request runway ' + v },
    sid: { arg: 'sid', say: v => 'request ' + v + ' departure' },
    star: { arg: 'star', say: v => 'request ' + v + ' arrival' },
    app: { arg: 'app', say: v => 'request ' + v + (/RWY|RUNWAY/.test(v) ? '' : ' approach') },
    visual: { arg: 'rwy', say: v => 'request visual approach' + (v ? ' runway ' + v : '') },
    higher: { arg: 'alt', say: (v, c) => 'request climb ' + altPhrase(v, c.sector) },
    lower: { arg: 'alt', say: (v, c) => 'request descent ' + altPhrase(v, c.sector) },
    direct: { arg: 'fix', say: v => 'request direct ' + v },
    weather: { arg: 'hdg', say: v => 'request heading ' + String(v).padStart(3, '0') + ' due to weather' },
    speed: { say: () => 'request no ATC speed restriction' },
    confirmspeed: { say: () => 'confirm no speed restriction' },
    checkin: { initial: true, say: (v, c) => c.level + (v ? ', information ' + v : '') },
    established: { initial: true, say: (v, c) => 'established' + (v ? ' ' + v : '') + (c.rwy ? ', runway ' + c.rwy : '') },
    goaround: { say: () => 'going around' },
    unable: { arg: 'reason', say: v => 'unable' + (v ? ' ' + v : '') },
    sayagain: { say: () => 'say again' },
    standby: { say: () => 'standby' },
    wilco: { say: () => 'wilco' },
    cancelifr: { say: () => 'cancel IFR' },
    pan: { arg: 'reason', say: v => 'PAN PAN, PAN PAN, PAN PAN' + (v ? ', ' + v : '') },
    mayday: { arg: 'reason', say: v => 'MAYDAY, MAYDAY, MAYDAY' + (v ? ', ' + v : '') }
  };
  function cleanReqValue(arg, v) {
    if (v == null || v === '') return '';
    if (arg === 'alt') { let s = String(v).toUpperCase().trim(); const n = s.startsWith('FL') ? Number(s.slice(2)) * 100 : Number(s); return n >= 500 && n <= 60000 ? Math.round(n) : ''; }
    if (arg === 'hdg') { const n = Math.round(Number(v)); return n >= 1 && n <= 360 ? n : ''; }
    const s = String(v).replace(/[^\w .,/+'-]/g, '').trim();
    return arg === 'reason' ? s.slice(0, 60) : s.slice(0, 30).toUpperCase();
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
          if (typeof m.freq === 'string' && /^1[1-3]\d\.\d{3}$/.test(m.freq)) { this.freq = m.freq; h._tuned(this); }
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
        case 'runways': return h._runways(this, m);
        case 'req': return h._req(this, m);
        case 'voice': return h._voice(this, m);
        case 'atis': return h._atisRemarks(this, m);
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
      this.weather = {};                          // real METARs by ICAO, set by the server (simulated weather otherwise)
      this.atisState = {};                        // letter, text and controller remarks by ICAO
      this.reqId = 0;
      this.now = opts.now || (() => Date.now());
    }
    connect(send) { const s = new Session(this, this.nextId++, send); this.sessions.set(s.id, s); return s; }
    addSource(src) { this.sources.push(src); src.attach(this); return src; }
    byCallsign(cs) { for (const s of this.sessions.values()) if (s.callsign === cs) return s; return null; }
    pilots() { return [...this.sessions.values()].filter(s => s.role === 'pilot' && s.pos); }
    controllers() { return [...this.sessions.values()].filter(s => s.role === 'atc'); }
    airport(icao) { return this.sector.airports.find(a => a.icao === icao); }
    runwayConfig() {
      const out = {};
      for (const ap of this.sector.airports) if (ap.cfg) out[ap.icao] = ap.cfg;
      return out;
    }
    // Swap in an edited map; live runway settings carry over.
    setMap(map) {
      const cfg = this.runwayConfig();
      this.sector = map.fixIndex ? map : registerMap(map);
      for (const [icao, c] of Object.entries(cfg)) { const ap = this.airport(icao); if (ap) ap.cfg = c; }
      this.broadcast({ t: 'map', id: this.sector.id, rev: this.sector.overlayRev || 0 });
    }
    _runways(s, m) {
      if (s.role !== 'atc') return s.error('Only controllers can change runways.');
      const ap = this.airport(String(m.icao || '').toUpperCase());
      if (!ap) return s.error('Unknown airport ' + m.icao + '.');
      const ends = runwayEndIds(ap);
      const pick = v => (Array.isArray(v) ? v : []).map(x => String(x).toUpperCase()).filter(x => ends.includes(x));
      const arr = pick(m.arr), dep = pick(m.dep);
      if (!arr.length && !dep.length) return s.error('Choose at least one runway for ' + ap.icao + '.');
      ap.cfg = { arr: arr.length ? arr : dep, dep: dep.length ? dep : arr };
      this.broadcast({ t: 'runways', cfg: this.runwayConfig() });
      this.radio('SERVER', s.freq, ap.icao + ' runways: arrivals ' + ap.cfg.arr.join(', ') + ', departures ' + ap.cfg.dep.join(', ') + '.', true);
      this.log(s.callsign + ' set ' + ap.icao + ' runways arr ' + ap.cfg.arr + ' dep ' + ap.cfg.dep);
    }
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
      s.send({ t: 'welcome', id: s.id, callsign: cs, role, freq: s.freq, facility: s.facility && s.facility.id, version: VERSION, map: { id: this.sector.id, name: this.sector.name, rev: this.sector.overlayRev || 0 }, runways: this.runwayConfig(), atis: s.isBot ? [] : this.atisList() });
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
        const rwy = (t.rwy && runwayEnd(arrAp, t.rwy)) || runwaysInUse(arrAp, 'arr')[0];
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
      else if (kind === 'clearance') {
        const v = value && typeof value === 'object' ? value : {};
        const depAp = this.airport(t.fp && t.fp.dep);
        const type = v.type === 'VFR' ? 'VFR' : 'IFR';
        const dest = String(v.dest || (t.fp && t.fp.arr) || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 20);
        let sq = String(v.sq || '').toUpperCase();
        if (!sq || sq === 'AUTO') sq = this.assignSquawk();
        if (!/^[0-7]{4}$/.test(sq)) return atc.error('A squawk is four digits from 0 to 7, like 4521.');
        const sid = type === 'IFR' && v.sid ? String(v.sid).toUpperCase() : '';
        if (sid && depAp && !proceduresFor(depAp, 'SID').some(p => p.name === sid)) return atc.error(depAp.icao + ' has no SID called ' + sid + '.');
        const alt = Math.round(Number(String(v.alt || '').toUpperCase().replace(/^FL(\d+)$/, (x, n) => n * 100))) || 0;
        if (alt && !(alt >= 1000 && alt <= 45000)) return atc.error('Initial level must be 1000 to 45000 ft.');
        const rwy = v.rwy ? String(v.rwy).toUpperCase() : (depAp && sid ? (proceduresFor(depAp, 'SID').find(p => p.name === sid) || {}).runway || '' : '');
        value = { type, dest, sid, alt, sq, rwy: rwy && rwy !== 'ALL' ? rwy : '', route: String(v.route || '').toUpperCase().slice(0, 60) };
        t.cleared.clr = type; t.cleared.sq = sq; if (alt) t.cleared.alt = alt; if (sid) t.cleared.sid = sid;
        if (value.rwy) t.rwy = value.rwy;
      }
      else if (kind === 'pushback') { value = String(value || '').toUpperCase().replace(/[^A-Z ]/g, '').slice(0, 12); t.cleared.push = true; }
      else if (['lineup', 'takeoff', 'land', 'holdshort', 'cross', 'rwy'].includes(kind)) {
        // The airport this is about: departure or destination, whichever the aircraft is near; else the nearest airport.
        const near = [t.fp && this.airport(t.fp.dep), t.fp && this.airport(t.fp.arr)].filter(Boolean).filter(a => !t.pos || distNm(t.pos, a) < (kind === 'land' || kind === 'rwy' ? 60 : 15));
        const ap = (kind === 'land' ? near[near.length - 1] : near[0]) || (t.pos ? this.sector.airports.slice().sort((a, b) => distNm(t.pos, a) - distNm(t.pos, b))[0] : null);
        if (!ap) return atc.error('No airport for ' + t.callsign + '.');
        value = String(value || t.rwy || runwaysInUse(ap, kind === 'land' ? 'arr' : 'dep')[0].id).toUpperCase();
        if (!runwayEnd(ap, value)) return atc.error(ap.icao + ' has no runway ' + value + '.');
        if (kind === 'takeoff' || kind === 'land') { extra = windText(this.weatherFor(ap)); t.cleared[kind === 'land' ? 'land' : 'tkof'] = value; }
        if (kind === 'lineup') t.cleared.lu = value;
        if (kind === 'rwy' || kind === 'takeoff' || kind === 'lineup' || kind === 'land') t.rwy = value;
      }
      else if (kind === 'goaround') { extra = m.extra ? String(m.extra).slice(0, 80) : null; delete t.cleared.land; }
      else if (kind === 'text' || kind === 'reply') {
        value = String(value || '').replace(/[<>]/g, '').trim().slice(0, 200);
        if (!value) return atc.error('Type the message first.');
      }
      else return atc.error('Unknown instruction ' + kind + '.');
      if (m.visual && kind === 'ils') extra = 'visual approach';
      if (t.req && kind !== 'text' && !(kind === 'reply' && m.keep)) t.req = null; // an instruction answers the pending request ("standby" keeps it open)
      if (!t.owner) t.owner = atc.callsign;
      const text = t.callsign + ', ' + instrPhrase(kind, value, dir, this.sector, t.pos && t.pos.alt, extra);
      this.radio(atc.callsign, atc.freq, text);
      t.send({ t: 'instr', from: atc.callsign, to: t.callsign, kind, value, dir, extra, proc: procName, text });
      // "Contact ..." passes the aircraft on to whoever is on that frequency (or nobody).
      if (kind === 'contact') {
        const f = (String(value).match(/1\d\d\.\d{3}/) || [])[0];
        const next = f && this.controllers().find(c => c.freq === f && c !== atc);
        t.owner = next ? next.callsign : null; t.handoff = null;
      }
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

    // ------------------------------------------------ pilot requests
    _req(s, m) {
      if (s.role !== 'pilot') return s.error('Only pilots send requests.');
      const kind = String(m.kind || ''), def = REQUESTS[kind];
      if (!def) return s.error('Unknown request ' + kind + '.');
      const value = cleanReqValue(def.arg, m.value);
      if (!s.freq) return s.error('Tune a frequency first.');
      const owner = s.owner && this.byCallsign(s.owner);
      const atc = owner && owner.freq === s.freq ? owner : this.controllers().find(c => c.freq === s.freq) || null;
      const ap = this.airport(s.fp && (s.pos && s.fp.arr && this.airport(s.fp.arr) && distNm(s.pos, this.airport(s.fp.arr)) < 20 ? s.fp.arr : s.fp.dep));
      const level = !s.pos ? '' : s.pos.onGround ? (m.stand ? 'stand ' + m.stand : 'on ground') : s.pos.alt > (this.sector.transitionAlt || 6000) ? 'flight level ' + Math.round(s.pos.alt / 100) : Math.round(s.pos.alt / 100) * 100 + ' feet';
      const ctx = { sector: this.sector, rwy: m.rwy || s.rwy || '', stand: cleanReqValue('twy', m.stand), via: cleanReqValue('twy', m.via), atis: m.atis ? cleanReqValue('twy', m.atis).slice(0, 8) : (ap && this.atisState[ap.icao] ? PHONETIC[this.atisState[ap.icao].n % 26] : ''), level };
      if (def.arg && value === '' && ['alt', 'fix', 'rwy', 'sid', 'star', 'app', 'twy', 'hdg'].includes(def.arg) && kind !== 'visual') return s.error('That request needs a value (' + def.arg + ').');
      const phrase = def.say(value, ctx);
      const text = (def.initial && atc ? atc.facility.name + ', ' + s.callsign + ', ' : s.callsign + ', ') + phrase;
      s.req = ['wilco', 'standby', 'sayagain', 'checkin', 'goaround'].includes(kind) ? s.req : { id: ++this.reqId, kind, value, text };
      if (kind === 'mayday' || kind === 'pan') s.emergency = kind === 'mayday' ? 'MAYDAY' : 'PAN';
      this.radio(s.callsign, s.freq, text);
      for (const c of this.controllers()) if (c.freq === s.freq || c === owner) c.send({ t: 'req', from: s.callsign, id: s.req ? s.req.id : 0, kind, value, text });
    }
    // ------------------------------------------------ voice: short audio chunks relayed to everyone on the same frequency
    _voice(s, m) {
      if (s.role !== 'pilot' && s.role !== 'atc') return;
      if (!s.freq || typeof m.data !== 'string' && !m.end) return;
      if (m.data && m.data.length > 12000) return s.error('Voice chunk too large.');
      const now = this.now();
      s.voiceWin = s.voiceWin && now - s.voiceWin.t < 1000 ? s.voiceWin : { t: now, n: 0 };
      if (++s.voiceWin.n > 30) return; // more than 30 chunks a second is not speech
      const out = { t: 'voice', from: s.callsign, freq: s.freq, seq: Number(m.seq) || 0, rate: m.rate === 8000 ? 8000 : 16000, data: m.data || '', end: !!m.end };
      for (const o of this.sessions.values()) if (o !== s && !o.isBot && o.freq === s.freq) o.send(out);
    }
    // ------------------------------------------------ weather and ATIS
    setWeather(icao, w) { this.weather[icao] = w; }
    weatherFor(ap) { return this.weather[ap.icao] || simulatedWeather(ap, this.now()); }
    atisFor(icao) {
      const ap = this.airport(icao); if (!ap) return null;
      const w = this.weatherFor(ap), arr = runwaysInUse(ap, 'arr').map(r => r.id), dep = runwaysInUse(ap, 'dep').map(r => r.id);
      const app = bestApproach(ap, arr[0]);
      const st = this.atisStateOf(icao);
      const letter = PHONETIC[st.n % 26];
      const fac = this.sector.facilities.find(f => f.airport === icao && /Approach|Tower|Information/.test(f.name));
      const name = fac ? fac.name.replace(/ (Approach|Tower|Information)$/, '') : (ap.city || ap.name || icao).split(/[-/(]/)[0].trim();
      const time = new Date(this.now()).toISOString().slice(11, 16).replace(':', '');
      const vis = w.visib == null ? '' : w.visib >= 10 ? 'visibility 10 kilometres or more' : 'visibility ' + Math.round(w.visib * 1.609) + ' kilometres';
      const cloud = (w.clouds || []).filter(c => c.base).map(c => ({ FEW: 'few', SCT: 'scattered', BKN: 'broken', OVC: 'overcast' }[c.cover] || c.cover) + ' ' + c.base + ' feet').join(', ');
      const parts = [
        name + ' information ' + letter + ', time ' + time + '.',
        app ? 'Expect ' + approachName(app) + ' runway ' + (app.runway && app.runway !== 'ALL' ? app.runway : arr[0]) + '.' : '',
        arr.join() === dep.join() ? 'Runway in use ' + arr.join(' and ') + '.' : 'Landing runway ' + arr.join(' and ') + ', departure runway ' + dep.join(' and ') + '.',
        windText(w).replace(/^w/, 'W') + '.', vis ? vis.replace(/^v/, 'V') + '.' : '', cloud ? cloud.replace(/^./, c => c.toUpperCase()) + '.' : (w.visib >= 10 ? 'No significant cloud.' : ''),
        w.temp != null ? 'Temperature ' + Math.round(w.temp) + ', dew point ' + Math.round(w.dewp) + '.' : '',
        w.qnh ? 'QNH ' + Math.round(w.qnh) + '.' : '',
        st.remarks ? st.remarks.replace(/\.?$/, '.') : '', w.simulated ? 'Simulated weather.' : '',
        'Advise on initial contact you have information ' + letter + '.'
      ];
      return { icao, freq: ap.atis || null, letter, text: parts.filter(Boolean).join(' '), raw: w.raw || null };
    }
    // A new letter whenever runways, weather or remarks change. Pilots tuned to the ATIS hear the new one.
    updateAtis(force) {
      for (const ap of this.sector.airports) {
        if (!ap.atis && !(this.atisState[ap.icao] && this.atisState[ap.icao].remarks)) continue;
        const w = this.weatherFor(ap);
        const sig = JSON.stringify([runwaysInUse(ap, 'arr').map(r => r.id), runwaysInUse(ap, 'dep').map(r => r.id), w.raw || [w.wdir, w.wspd, w.qnh], (this.atisState[ap.icao] || {}).remarks]);
        const st = this.atisStateOf(ap.icao);
        if (st.sig === sig && !force) continue;
        if (st.sig !== null) st.n++;
        st.sig = sig;
        const a = this.atisFor(ap.icao);
        this.broadcast(Object.assign({ t: 'atis' }, a));
        if (a.freq) for (const s of this.sessions.values()) if (!s.isBot && s.freq === a.freq) s.send({ t: 'msg', from: ap.icao + '_ATIS', freq: a.freq, text: a.text, atis: true, at: this.now() });
      }
    }
    atisStateOf(icao) { return this.atisState[icao] || (this.atisState[icao] = { n: Math.floor(this.now() / 3600000) % 26, sig: null, remarks: '' }); }
    atisList() { return this.sector.airports.filter(a => a.atis || (this.atisState[a.icao] && this.atisState[a.icao].remarks)).map(a => this.atisFor(a.icao)); }
    _atisRemarks(s, m) {
      if (s.role !== 'atc') return s.error('Only controllers can change the ATIS.');
      const ap = this.airport(String(m.icao || '').toUpperCase()); if (!ap) return s.error('Unknown airport ' + m.icao + '.');
      const st = this.atisStateOf(ap.icao);
      st.remarks = String(m.remarks || '').replace(/[<>]/g, '').slice(0, 200).trim();
      this.updateAtis();
    }
    // Tuning an ATIS frequency plays that ATIS (the nearest airport using it).
    _tuned(s) {
      if (s.isBot) return;
      const aps = this.sector.airports.filter(a => a.atis === s.freq);
      if (!aps.length) return;
      const ap = s.pos ? aps.sort((a, b) => distNm(s.pos, a) - distNm(s.pos, b))[0] : aps[0];
      const a = this.atisFor(ap.icao);
      s.send({ t: 'msg', from: ap.icao + '_ATIS', freq: s.freq, text: a.text, atis: true, at: this.now() });
    }

    radio(from, freq, text, system) {
      const out = { t: 'msg', from, freq, text, system: !!system, at: Date.now() };
      for (const s of this.sessions.values()) if (s.freq === freq || s.role === 'observer') s.send(out);
    }
    broadcast(m) { for (const s of this.sessions.values()) if (!s.isBot) s.send(m); }

    // Which controller an aircraft here should talk to: the most specific online position covering it.
    // prefer: a position kind to pick among equally specific ones (DEL for clearances, GND for taxi).
    coverage(p, prefer) {
      const sec = this.sector.sectors.find(z => pointInPoly(p, z.polygon));
      let best = null, bk = null;
      for (const c of this.controllers()) {
        const f = c.facility;
        if (!facilityCovers(f, p, sec)) continue;
        const key = f.rank * 100 + (f.covers ? f.covers.length : 0) + (prefer && f.kind !== prefer ? 0.5 : 0);
        if (!best || key < bk) { best = c; bk = key; }
      }
      return best ? { freq: best.freq, atc: best } : { freq: this.sector.unicom, atc: null };
    }

    snapshot() {
      return this.pilots().map(p => ({
        cs: p.callsign, type: p.type, sq: p.squawk, freq: p.freq, bot: p.isBot,
        lat: +p.pos.lat.toFixed(6), lon: +p.pos.lon.toFixed(6), alt: p.pos.alt, hdg: p.pos.hdg, gs: p.pos.gs, vs: p.pos.vs,
        onGround: p.pos.onGround, pitch: p.pos.pitch, bank: p.pos.bank,
        fp: p.fp, owner: p.owner, handoff: p.handoff, cleared: p.cleared, proc: p.procName || null, rwy: p.rwy || null,
        req: p.req || null, emergency: p.emergency || null, phase: p.phase || null, rt: p.rt || null
      }));
    }

    tick(dt) {
      this.time += dt;
      for (const src of this.sources) src.tick(dt);
      if ((this.atisCheck = (this.atisCheck || 0) - dt) <= 0) { this.atisCheck = 10; this.updateAtis(); }
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

  // Ground phases shown on the scope tag.
  const PHASE_TAG = { parked: 'STAND', pushback: 'PUSH', pushed: 'START', taxi: 'TAXI', holding: 'HOLD', lineup: 'LU', takeoff: 'TKOF', flare: 'LAND', rollout: 'ROLL', taxiin: 'TAXI', vacated: 'TAXI', arrived: 'STAND' };

  class SimPilot {
    constructor(src, spec) {
      Object.assign(this, spec);
      this.src = src; this.hub = src.hub; this.sector = this.hub.sector;
      this.atcAlt = null; this.atcSpd = null; this.mode = this.mode || 'nav'; this.ilsArmed = false;
      this.pending = []; this.t = 0; this.requestedHigher = false; this.done = false;
      this.phase = this.phase || 'air'; this.onGround = this.phase !== 'air'; this.gspd = this.gspd || 0;
      this.clr = {}; this.wait = null; this.blockedFor = 0; this.ignoreBlockUntil = 0;
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
    // A structured request, so the controller gets reply buttons for it.
    request(kind, value, delay = 1.5 + this.src.rand() * 2) {
      const stand = this.stand && this.stand.ref;
      this.wait = { kind, since: this.t, first: this.wait && this.wait.kind === kind ? this.wait.first : this.t };
      setTimeoutLike(this, delay, () => this.session.receive({ t: 'req', kind, value, stand: this.phase === 'parked' || kind === 'vacated' ? stand : '', rwy: this.geo.rwy.id, via: this.exitVia || '' }));
    }
    push() {
      this.session.receive({ t: 'pos', lat: this.lat, lon: this.lon, alt: Math.round(this.alt), hdg: Math.round(this.hdg), gs: Math.round(this.gs()), vs: Math.round(this.vs || 0), squawk: this.squawk, onGround: this.onGround });
      this.session.phase = PHASE_TAG[this.phase] || null;
      if ((this.rtAt = (this.rtAt || 0) - 1) <= 0) { this.rtAt = 4; this.session.rt = this.remainingRoute(); }
    }
    // What is left of the route, for the scope: [id, lat, lon, alt, altType] (taxi routes have no ids).
    remainingRoute() {
      const pt = (w, id) => [id == null ? w.id || '' : id, +w.lat.toFixed(4), +w.lon.toFixed(4), w.alt || 0, w.altType || ''];
      if (this.onGround && this.path && ['taxi', 'taxiin', 'pushed', 'vacated', 'lineup'].includes(this.phase)) {
        const end = this.phase === 'taxi' ? this.holdIdx + 1 : this.path.length;
        const pts = this.path.slice(this.pi, end);
        const step = Math.max(1, Math.ceil(pts.length / 30));
        return pts.filter((p, i) => i % step === 0 || i === pts.length - 1).map((p, i, a) => pt(p, i === a.length - 1 ? (this.phase === 'taxi' ? 'HP ' + this.geo.rwy.id : this.stand ? this.stand.ref : '') : ''));
      }
      if (this.phase !== 'air' && this.phase !== 'flare') return null;
      const out = this.mode === 'final' ? [] : this.route.slice(this.wp).map(w => pt(w, w.id === 'EXIT' ? 'to ' + this.arr : w.id === 'GA' ? 'GO AROUND' : w.id));
      if (this.arriving && (!out.length || out[out.length - 1][0] !== 'RW' + this.geo.rwy.id)) out.push(pt(this.geo.thr, 'RW' + this.geo.rwy.id));
      return out.slice(0, 24);
    }
    gs() { return this.onGround || this.phase === 'flare' ? this.gspd : this.ias * (1 + this.alt / 1000 * 0.018); }
    fix(id) { const f = this.sector.fixIndex.get(id); return f ? { id, lat: f.lat, lon: f.lon } : null; }
    approachLegs() { return this.geo.appLegs.length ? this.geo.appLegs.slice() : [Object.assign({ id: 'FAF', faf: true }, this.geo.faf)]; }
    tail() { return this.arriving ? this.approachLegs() : [this.exitPoint]; }
    setSid(name) {
      const sid = proceduresFor(this.ap, 'SID').find(p => p.name === name); if (!sid) return;
      const legs = resolveLegs(this.sector, sid);
      const rwyPt = this.route && this.route[0] && this.route[0].id === 'RWY' ? [this.route[0]] : [];
      this.route = rwyPt.concat(legs, [this.exitPoint]); this.wp = 0;
      if (this.phase === 'air') { this.route = legs.concat([this.exitPoint]); this.mode = 'nav'; }
      const top = legs.filter(l => l.alt).pop(); if (top && !this.atcAlt) this.initialClimb = top.alt;
      this.procName = sid.name; this.session.procName = sid.name;
    }

    onMsg(m) {
      if (m.t !== 'instr' || m.to !== this.cs) return;
      const cs = this.cs;
      if (this.wait) this.wait = null;
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
        case 'sid': if (!this.arriving) this.setSid(m.value); break;
        case 'clearance': {
          const v = m.value || {};
          this.clr.ifr = true; this.squawk = v.sq || this.squawk;
          if (!this.arriving && v.rwy && v.rwy !== this.geo.rwy.id && this.onGround && ['parked', 'pushback', 'pushed'].includes(this.phase)) this.setRunway(v.rwy);
          if (!this.arriving && v.sid) this.setSid(v.sid);
          if (v.alt) this.initialClimb = v.alt;
          break;
        }
        case 'pushback': this.clr.push = true; break;
        case 'taxi': this.clr.taxi = m.value || {}; if (this.phase === 'taxi' || this.phase === 'taxiin') this.retaxi = true; break;
        case 'lineup': this.clr.lineup = true; break;
        case 'takeoff': this.clr.takeoff = true; break;
        case 'land': this.clr.land = true; break;
        case 'goaround': if (this.arriving && (this.phase === 'air' || this.phase === 'flare')) this.goAround(); break;
        case 'rwy':
          if (m.value !== this.geo.rwy.id && runwayEnd(this.ap, m.value) && (this.arriving ? this.phase === 'air' : ['parked', 'pushback', 'pushed'].includes(this.phase))) this.setRunway(m.value);
          break;
        case 'holdshort': case 'cross': break;
        case 'text': case 'reply': this.say('Roger, ' + cs); return;
        case 'ils':
          {
            const proc = m.proc ? proceduresFor(this.ap, 'APP').find(p => p.name === m.proc) : bestApproach(this.ap, this.geo.rwy.id);
            if (proc && proc.runway && proc.runway !== this.geo.rwy.id && runwayEnd(this.ap, proc.runway)) this.setRunway(proc.runway);
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
      const rb = instrPhrase(m.kind, m.value, m.dir, this.sector, this.alt, m.extra).replace(/^wind [^,]*, /, '');
      this.say(rb.charAt(0).toUpperCase() + rb.slice(1) + ', ' + cs);
    }

    tune(freq) { this.freq = freq; this.session.receive({ t: 'tune', freq }); }
    setRunway(id) {
      const rwy = runwayEnd(this.ap, id); if (!rwy) return;
      Object.assign(this.geo, { rwy }, runwayGeometry(rwy));
      this.session.rwy = id;
      if (!this.arriving && this.onGround) this.planDeparture();
    }
    // Where this aircraft talks to: on the runway or in the air it is with tower or above, on the apron with ground or delivery.
    covPoint() { return { lat: this.lat, lon: this.lon, alt: this.alt, arriving: this.arriving, onGround: this.onGround && !['holding', 'lineup', 'takeoff', 'rollout'].includes(this.phase) }; }
    coverage() {
      const owner = this.session.owner && this.hub.byCallsign(this.session.owner);
      if (owner) return { freq: owner.freq, atc: owner };
      return this.hub.coverage(this.covPoint(), this.phase === 'parked' && !this.clr.ifr ? 'DEL' : this.onGround ? 'GND' : null);
    }
    hasAtc() { return !!this.coverage().atc; }
    checkIn() {
      if (this.onGround) return;
      const cov = this.coverage();
      const name = cov.atc ? cov.atc.facility.name : null;
      if (!name) return;
      const level = this.alt > (this.sector.transitionAlt || 6000) ? 'flight level ' + Math.round(this.alt / 100) : Math.round(this.alt / 100) * 100 + ' feet';
      const tgt = this.targetAlt();
      const trend = tgt > this.alt + 300 ? ' climbing ' + altPhrase(tgt, this.sector) : tgt < this.alt - 300 ? ' descending ' + altPhrase(tgt, this.sector) : '';
      const atis = this.arriving && this.hub.atisState[this.arr] ? ', information ' + PHONETIC[this.hub.atisState[this.arr].n % 26] : '';
      this.say(name + ', ' + this.cs + ', ' + level + trend + (this.arriving ? ', inbound ' + this.arr : '') + (this.procName ? ', ' + this.procName : '') + atis);
    }

    targetAlt() {
      if (this.goingAround) return Math.max(this.alt, this.gaAlt);
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
      if (this.mode === 'final') { const d = distNm(this, this.geo.thr); return d < 5 ? this.vref() : 165; }
      if (this.arriving) { const d = distNm(this, this.geo.thr); if (d < 14) return 185; if (d < 28) return 220; }
      const slow = this.type === 'AT76' || this.type === 'DH8D';
      return this.alt < 10000 ? (slow ? 210 : 250) : (slow ? 240 : 290);
    }
    turboprop() { return this.type === 'AT76' || this.type === 'DH8D'; }
    vref() { return this.turboprop() ? 115 : /B77|A35|A33|B78|A38|B74/.test(this.type) ? 150 : 140; }

    step(dt) {
      this.t += dt;
      while (this.pending.length && this.pending[0].at <= this.t) {
        const p = this.pending.shift();
        if (p.fn) p.fn(); else this.session.receive({ t: 'msg', freq: this.freq, text: p.text });
      }
      // Frequency follows the controlling controller, otherwise the most specific online position (top-down).
      if (!this.contactPending) {
        const cov = this.coverage();
        if (cov.freq !== this.freq) { this.tune(cov.freq); if (cov.atc && !this.session.owner) this.checkIn(); }
      }
      if (this.phase !== 'air') { this.groundStep(dt); if (!this.done) this.push(); return; }
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
            if (this.goingAround && this.wp >= this.gaLegs) this.goingAround = false;
            if (this.arriving && wp.faf && !this.goingAround) this.mode = 'final';
          }
        }
      }
      if (this.mode === 'final') {
        const xt = this.crossTrack();
        tHdg = norm360(geo.rwy.hdg - clamp(xt.xt * 35, -35, 35));
        this.gsAlt = Math.max(this.ap.elev, this.ap.elev + 50 + xt.along * 318);
        // With a controller: report established, and go around if there is no landing clearance by short final.
        const twr = this.hasAtc();
        if (twr && !this.calledFinal && xt.along < 10 && xt.along > 1.5) { this.calledFinal = true; this.request('established', this.procName && /RWY/.test(this.procName) ? this.procName : (this.session.procName || '')); }
        if (twr && !this.clr.land && xt.along < 0.6) return this.goAround();
        if (xt.along < 0.03) { this.phase = 'flare'; this.gspd = this.gs(); this.tdz = 0; }
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
        this.requestedHigher = true; this.request('higher', this.cruise, 3);
      }
      if (!this.arriving && distNm(this, this.depRef) > this.departRange) return this.finish('left the area');
      if (this.arriving && distNm(this, geo.thr) > 160) return this.finish('left the area');
      this.push();
    }

    goAround() {
      const ap = this.ap, rwy = this.geo.rwy;
      const proc = proceduresFor(ap, 'APP', rwy.id).find(p => p.name === this.session.procName) || bestApproach(ap, rwy.id);
      const missed = proc && proc.missed && proc.missed.length ? resolveLegs(this.sector, { legs: proc.missed }) : [];
      const straight = Object.assign({ id: 'GA' }, move(this.geo.thr, rwy.hdg, 6));
      const legs = missed.length ? missed : [straight];
      if (this.phase === 'flare') { this.phase = 'air'; this.onGround = false; this.ias = Math.max(this.gspd, this.vref()); }
      this.mode = 'nav'; this.route = dedupe(legs.concat(this.approachLegs())); this.wp = 0; this.gaLegs = legs.length;
      this.goingAround = true; this.gaAlt = Math.max(ap.elev + 3000, ...legs.filter(l => l.alt).map(l => l.alt));
      this.atcAlt = null; this.atcSpd = null; this.clr.land = false; this.calledFinal = false;
      this.hub.log(this.cs + ' going around at ' + ap.icao);
      if (this.hasAtc()) this.request('goaround', '', 1);
    }

    // ------------------------------------------------ ground: departures from a stand, arrivals to a stand
    groundStep(dt) {
      const ap = this.ap, g = taxiGraph(ap), rwy = this.geo.rwy, atc = this.hasAtc();
      const waited = k => this.wait && this.wait.kind === k ? this.t - this.wait.since : Infinity;
      const ask = (k, v) => { if (waited(k) > 150) this.request(k, v); };
      const tooLong = () => this.wait && this.t - this.wait.first > 600;
      switch (this.phase) {
        case 'parked': {
          this.gspd = 0;
          if (this.t < this.readyAt) return;
          if (atc) {
            if (tooLong()) return this.finish('cancelled at ' + ap.icao + ' (no clearance)');
            if (!this.clr.ifr && !this.clr.push && !this.clr.taxi) return ask('ifr', this.arr);
            if (!this.clr.push && !this.clr.taxi) return ask('startup');
          }
          this.wait = null; this.phase = 'pushback'; this.pushFrom = { lat: this.lat, lon: this.lon };
          return;
        }
        case 'pushback': {
          // Tug pushes the aircraft back, nose staying put, to the taxilane behind the stand.
          const tgt = this.pushNode, d = distNm(this, tgt);
          this.gspd = Math.min(this.gspd + 0.5 * dt, 3);
          const stepNm = this.gspd * dt / 3600;
          if (stepNm >= d) {
            Object.assign(this, { lat: tgt.lat, lon: tgt.lon });
            this.phase = 'pushed'; this.pushedAt = this.t; this.gspd = 0;
            if (this.path && this.path[1]) this.turnTo = bearing(this.path[0], this.path[1]);
          } else { const p = move(this, bearing(this, tgt), stepNm); this.lat = p.lat; this.lon = p.lon; }
          return;
        }
        case 'pushed': {
          this.gspd = 0;
          if (this.turnTo != null) { const dd = angleDiff(this.hdg, this.turnTo); this.hdg = norm360(this.hdg + clamp(dd, -4 * dt, 4 * dt)); if (Math.abs(dd) < 1) this.turnTo = null; }
          if (this.t - this.pushedAt < 30) return; // engine start
          if (atc && !this.clr.taxi) { if (tooLong()) return this.finish('cancelled at ' + ap.icao + ' (no taxi clearance)'); return ask('taxi'); }
          this.wait = null;
          if (this.clr.taxi && this.clr.taxi.via && this.clr.taxi.via.length) this.planDeparture(new Set(this.clr.taxi.via));
          this.phase = 'taxi'; this.pi = 1;
          return;
        }
        case 'taxi':
          if (this.retaxi) { this.retaxi = false; this.planDeparture(new Set((this.clr.taxi && this.clr.taxi.via) || []), true); }
          if (this.followPath(dt, 18, this.holdIdx)) { this.phase = 'holding'; this.gspd = 0; this.holdSince = this.t; }
          return;
        case 'holding': {
          this.gspd = 0;
          if (atc) {
            if (this.clr.takeoff || this.clr.lineup) { this.wait = null; this.phase = 'lineup'; return; }
            if (tooLong()) return this.finish('cancelled at ' + ap.icao + ' (no take-off clearance)');
            return ask('ready', rwy.id);
          }
          if (this.t - this.holdSince > 8 && !this.runwayBusy()) { this.phase = 'lineup'; this.clr.takeoff = true; }
          return;
        }
        case 'lineup': {
          if (!this.linedUp) {
            if (this.followPath(dt, 10, this.path.length - 1)) {
              const dd = angleDiff(this.hdg, rwy.hdg);
              this.hdg = norm360(this.hdg + clamp(dd, -8 * dt, 8 * dt)); this.gspd = 0;
              if (Math.abs(dd) < 1) { this.hdg = rwy.hdg; this.linedUp = true; this.linedUpAt = this.t; }
            }
            return;
          }
          if (atc && !this.clr.takeoff) { if (this.t - this.linedUpAt > 240 && waited('ready') > 150) this.request('ready', rwy.id); return; }
          if (this.t - this.linedUpAt > 4) { this.phase = 'takeoff'; this.hub.log(this.cs + ' taking off from ' + ap.icao + ' runway ' + rwy.id); }
          return;
        }
        case 'takeoff': {
          this.gspd += 3.2 * dt;
          const p = move(this, rwy.hdg, this.gspd * dt / 3600); this.lat = p.lat; this.lon = p.lon; this.hdg = rwy.hdg;
          if (this.gspd >= this.vref() + 5) {
            Object.assign(this, { phase: 'air', onGround: false, ias: this.gspd, alt: ap.elev + 30, mode: 'nav', wp: 0 });
            this.vs = 1800;
          }
          return;
        }
        case 'flare': {
          // From the threshold: settle onto the runway about 300 m in, then roll out.
          this.gspd = Math.max(this.gspd - 0.6 * dt, this.vref() - 10);
          const p = move(this, rwy.hdg, this.gspd * dt / 3600); this.lat = p.lat; this.lon = p.lon;
          this.hdg = norm360(this.hdg + clamp(angleDiff(this.hdg, rwy.hdg), -2 * dt, 2 * dt));
          this.vs = this.alt - ap.elev > 20 ? -700 : -150;
          this.alt = Math.max(ap.elev, this.alt + this.vs * dt / 60);
          if (this.alt <= ap.elev + 0.5) this.touchdown();
          return;
        }
        case 'rollout': {
          const f = runwayFrame(rwy, this);
          const exit = this.exitNode;
          if (!this.backtrack && exit && exit.along < f.along - 0.01) this.backtrack = true;
          if (this.backtrack) this.gspd = Math.max(0, this.gspd - 3 * dt);
          else this.gspd = Math.max(exit && f.along < exit.along - 0.05 && this.gspd < 30 ? 25 : 18, this.gspd - 3 * dt);
          const p = move(this, rwy.hdg, this.gspd * dt / 3600); this.lat = p.lat; this.lon = p.lon; this.hdg = rwy.hdg;
          if (!exit) { if (this.gspd <= 30) return this.finish('landed and vacated ' + ap.icao); return; }
          if (this.backtrack ? this.gspd <= 6 : f.along >= exit.along - 0.01) { this.phase = 'taxiin'; this.pi = 0; }
          if (f.along > rwy.len + 0.1) return this.finish('ran out of runway at ' + ap.icao);
          return;
        }
        case 'taxiin': {
          if (!this.vacated && runwayFrame(rwy, this).off > 0.06) {
            this.vacated = true;
            if (atc) { this.phase = 'vacated'; this.gspd = 0; this.vacatedAt = this.t; this.request('vacated', rwy.id); return; }
          }
          if (this.retaxi) { this.retaxi = false; this.planArrivalTaxi(new Set((this.clr.taxi && this.clr.taxi.via) || [])); }
          if (this.followPath(dt, this.vacated ? 18 : 22, this.path.length - 1)) {
            this.phase = 'arrived'; this.gspd = 0; this.arrivedAt = this.t;
            if (this.stand) { this.lat = this.stand.lat; this.lon = this.stand.lon; }
          }
          return;
        }
        case 'vacated':
          this.gspd = 0;
          if (this.clr.taxi || this.t - this.vacatedAt > 120 || !atc) {
            if (this.clr.taxi && this.clr.taxi.via && this.clr.taxi.via.length) this.planArrivalTaxi(new Set(this.clr.taxi.via));
            this.wait = null; this.phase = 'taxiin';
          }
          return;
        case 'arrived':
          this.gspd = 0;
          if (this.t - this.arrivedAt > 150) return this.finish('parked at ' + ap.icao + (this.stand ? ' stand ' + this.stand.ref : ''));
          return;
      }
    }
    // Moves along this.path up to index "stopAt"; returns true when there.
    followPath(dt, maxSpd, stopAt) {
      const last = Math.min(stopAt == null ? this.path.length - 1 : stopAt, this.path.length - 1);
      if (this.pi > last) { this.gspd = 0; return true; }
      const tgt = this.path[this.pi], d = distNm(this, tgt), brg = d > 0.0005 ? bearing(this, tgt) : this.hdg;
      let want = maxSpd;
      const next = this.path[this.pi + 1];
      if (this.pi === last) want = Math.min(want, 4 + d * 600);        // ease into the stop
      else if (next && Math.abs(angleDiff(brg, bearing(tgt, next))) > 35 && d < 0.05) want = Math.min(want, 9);
      const turning = Math.abs(angleDiff(this.hdg, brg)) > 60;        // turn first (e.g. backtracking), then roll
      if (turning) want = Math.min(want, 4);
      if (this.blocked()) want = 0;
      this.gspd = clamp(this.gspd + clamp(want - this.gspd, -4 * dt, 2 * dt), 0, maxSpd);
      this.hdg = norm360(this.hdg + clamp(angleDiff(this.hdg, brg), -30 * dt, 30 * dt));
      const stepNm = this.gspd * dt / 3600;
      if (stepNm >= d) { this.lat = tgt.lat; this.lon = tgt.lon; this.pi++; return this.pi > last; }
      const p = move(this, turning ? this.hdg : brg, stepNm); this.lat = p.lat; this.lon = p.lon;
      return false;
    }
    // Waits behind other aircraft on the ground (no overtaking, no driving through each other).
    blocked() {
      if (this.t < this.ignoreBlockUntil) return false;
      for (const s of this.hub.pilots()) {
        if (s === this.session || !s.pos || !s.pos.onGround) continue;
        const d = distNm(this, s.pos);
        if (d > 0.035) continue;
        if (Math.abs(angleDiff(this.hdg, bearing(this, s.pos))) < 40) {
          this.blockedFor += this.src.substep;
          if (this.blockedFor > 45) { this.blockedFor = 0; this.ignoreBlockUntil = this.t + 20; return false; } // break a stand-off
          return true;
        }
      }
      this.blockedFor = 0;
      return false;
    }
    // Something on the runway, or an arrival on short final, keeps departures at the holding point (when no controller does it).
    runwayBusy() {
      const rwy = this.geo.rwy, ap = this.ap;
      for (const s of this.hub.pilots()) {
        if (s === this.session || !s.pos) continue;
        const otherEnd = (rwy.name || '').split('/').find(x => x !== rwy.id);
        for (const r of [rwy, otherEnd && runwayEnd(ap, otherEnd)].filter(Boolean)) {
          const f = runwayFrame(r, s.pos);
          if (s.pos.onGround && f.off < 0.03 && f.along > -0.05 && f.along < r.len + 0.05) return true;
          if (!s.pos.onGround && f.off < 0.6 && f.along < 0 && f.along > -5 && s.pos.alt < ap.elev + 2000) return true;
        }
      }
      return false;
    }
    // Taxi route from the stand to the runway, stopping at the holding point.
    planDeparture(prefer, fromHere) {
      const g = taxiGraph(this.ap), rwy = this.geo.rwy; if (!g) return;
      const entry = runwayEntry(g, rwy);
      const start = fromHere ? { lat: this.lat, lon: this.lon } : this.pushNode;
      const path = entry && groundRoute(g, start, entry, prefer);
      if (!path) return;
      const f = runwayFrame(rwy, entry);
      path.push(Object.assign({ ref: '' }, move(runwayGeometry(rwy).thr, rwy.hdg, Math.max(0.03, f.along + 0.02))));
      let j = path.length - 1;
      while (j > 0 && runwayFrame(rwy, path[j - 1]).off < 0.045) j--;
      this.path = path; this.holdIdx = Math.max(0, j - 1); this.pi = fromHere ? 0 : 1;
      this.exitVia = '';
      this.taxiVia = viaOf(path.slice(0, this.holdIdx + 1));
    }
    // After landing: the first exit the aircraft can make, then on to a free stand.
    touchdown() {
      const ap = this.ap, rwy = this.geo.rwy;
      this.phase = 'rollout'; this.onGround = true; this.alt = ap.elev; this.vs = 0; this.gspd = Math.min(this.gspd, this.vref());
      this.hub.log(this.cs + ' landed at ' + ap.icao + ' runway ' + rwy.id);
      const g = taxiGraph(ap); if (!g) return;
      const here = runwayFrame(rwy, this).along;
      const stop = (this.gspd * this.gspd - 25 * 25) / 6 / 3600 + 0.15;
      this.stand = this.src.freeStand(ap, this.cs);
      const all = g.nodes.map(n => ({ n, f: runwayFrame(rwy, n) }))
        .filter(x => x.f.off < 0.03 && x.f.along > -0.1 && x.f.along < rwy.len + 0.3 && x.n.e.some(e => runwayFrame(rwy, e.n).off > 0.035));
      // First exit past the stopping point; if there is none, stop, turn around and backtrack to the nearest one behind.
      const ahead = all.filter(x => x.f.along > here + stop).sort((a, b) => a.f.along - b.f.along);
      const behind = all.filter(x => x.f.along <= here + stop).sort((a, b) => b.f.along - a.f.along);
      for (const x of ahead.slice(0, 6).concat(behind.slice(0, 4))) {
        const target = this.stand ? this.stand : nearestNodes(g, ap, 1)[0];
        const off = x.n.e.filter(e => runwayFrame(rwy, e.n).off > 0.035).map(e => e.n);
        for (const o of off) {
          const p = groundRoute(g, o, target);
          if (!p) continue;
          this.exitNode = { lat: x.n.lat, lon: x.n.lon, along: x.f.along };
          this.path = [{ lat: x.n.lat, lon: x.n.lon, ref: '' }].concat(p, this.stand ? [{ lat: this.stand.lat, lon: this.stand.lon, ref: '' }] : []);
          this.exitVia = viaOf(p.slice(0, 3)).slice(0, 1).join('');
          return;
        }
      }
    }
    planArrivalTaxi(prefer) {
      const g = taxiGraph(this.ap); if (!g || !this.stand) return;
      const p = groundRoute(g, { lat: this.lat, lon: this.lon }, this.stand, prefer);
      if (p) { this.path = p.concat([{ lat: this.stand.lat, lon: this.stand.lon, ref: '' }]); this.pi = 0; }
    }

    crossTrack() {
      const o = offsetNm(this.geo.thr, this);
      const u = { x: Math.sin(toRad(this.geo.rwy.hdg)), y: Math.cos(toRad(this.geo.rwy.hdg)) };
      return { along: -(o.x * u.x + o.y * u.y), xt: o.x * u.y - o.y * u.x };
    }
    finish(why) { this.done = true; this.src.releaseStand(this.cs); this.session.close(); this.hub.log(this.cs + ' ' + why); }
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
    // Stands: a random free one (not reserved by another simulated flight, nobody parked on it).
    freeStand(ap, cs) {
      const L = groundOf(ap); if (!L || !L.stands || !L.stands.length) return null;
      this.stands = this.stands || new Map();
      const taken = new Set([...this.stands.values()].filter(v => v.icao === ap.icao).map(v => v.ref));
      const people = this.hub.pilots().filter(s => s.pos && s.pos.onGround && distNm(s.pos, ap) < 3).map(s => s.pos);
      const free = L.stands.filter(x => x.ref && !taken.has(x.ref) && !people.some(p => distNm(p, x) < 0.02));
      if (!free.length) return null;
      const st = this.pick(free);
      this.stands.set(cs, { icao: ap.icao, ref: st.ref });
      return { ref: st.ref, lat: st.lat, lon: st.lon };
    }
    releaseStand(cs) { if (this.stands) this.stands.delete(cs); }
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
      const arriving = this.rand() < 0.55;
      const inUse = runwaysInUse(ap, arriving ? 'arr' : 'dep');
      const rwy = inUse[Math.floor(this.rand() * inUse.length)];
      const g = runwayGeometry(rwy);
      const app = bestApproach(ap, rwy.id);
      const geo = Object.assign({ rwy, appLegs: approachRoute(S, app, null) }, g);
      const [op, types] = this.pick(this.operatorsFor(icao));
      let cs; do { cs = op + (100 + Math.floor(this.rand() * 8900)); } while (this.used.has(cs) || this.hub.byCallsign(cs));
      const type = this.pick(types);
      const squawk = Array.from({ length: 4 }, () => Math.floor(this.rand() * 8)).join('');
      const other = this.otherEnd(icao, op);
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
        const start = move(g.thr, rwy.hdg, rwy.len + 0.5);
        let exitPoint, routeText, procName = null, sidLegs = [];
        if (P.exits) { const f = S.fixIndex.get(this.pick(P.exits)); exitPoint = { id: f.id, lat: f.lat, lon: f.lon }; routeText = rwy.id + ' ' + f.id + ' DCT'; }
        else { const b = bearing(ap, other); exitPoint = Object.assign({ id: 'EXIT' }, move(ap, b, (P.departRange || 90) + 30)); routeText = rwy.id + ' DCT ' + other.icao; }
        if (sids.length) {
          const sid = sids.map(s => ({ s, legs: resolveLegs(S, s) })).filter(x => x.legs.length).sort((a, b) => distNm(exitPoint, a.legs[a.legs.length - 1]) - distNm(exitPoint, b.legs[b.legs.length - 1]))[0];
          if (sid) { sidLegs = sid.legs; procName = sid.s.name; routeText = rwy.id + ' ' + sid.s.name + ' DCT ' + other.icao; const top = sid.legs.filter(l => l.alt).pop(); if (top) spec.initialClimb = top.alt; }
        }
        const route = [Object.assign({ id: 'RWY' }, move(start, rwy.hdg, 4))].concat(sidLegs, [exitPoint]);
        // Where there is a taxiway layout, most departures start at a stand and taxi out.
        const graph = taxiGraph(ap);
        if (graph && runwayEntry(graph, rwy) && this.rand() < (initial ? 0.45 : 0.8)) {
          const stand = this.freeStand(ap, cs);
          const pushNode = stand && nearestNodes(graph, stand, 1)[0];
          if (stand && pushNode) {
            Object.assign(spec, { dep: icao, arr: other.icao, lat: stand.lat, lon: stand.lon, alt: ap.elev, ias: 0, route, wp: 0, exitPoint, routeText, procName,
              depRef: { lat: ap.lat, lon: ap.lon }, phase: 'parked', stand, pushNode, hdg: bearing(pushNode, stand), readyAt: 10 + this.rand() * (initial ? 240 : 90) });
            this.used.add(cs);
            const pilot = new SimPilot(this, spec);
            pilot.session.rwy = rwy.id;
            pilot.planDeparture();
            if (!pilot.path) { pilot.finish('could not find a taxi route at ' + icao); return (attempt || 0) < 12 ? this.spawn(initial, (attempt || 0) + 1) : null; }
            this.pilots.push(pilot);
            return;
          }
          this.releaseStand(cs);
        }
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
      const pilot = new SimPilot(this, spec);
      pilot.session.rwy = rwy.id;
      this.pilots.push(pilot);
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
    runwayGeometry, activeRunway, runwayEnd, runwayEndIds, runwaysInUse, applyOverlay, refineRunways, taxiGraph, groundRoute, runwayEntry, runwayFrame, REQUESTS, PHONETIC, windText, proceduresFor, bestApproach, resolveLegs, approachRoute, instrPhrase, altPhrase, magVar, magBearing, taxiTarget
  };
});
