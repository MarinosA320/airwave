#!/usr/bin/env python3
"""
Builds data/greece.json, the Airwave map for Greece, from OurAirports open data (public domain).

    python3 tools/build-greece.py

Needs data/src/{airports,runways,navaids,airport-frequencies}.csv from
https://github.com/davidmegginson/ourairports-data

The FIR outline and the area-control sector split are APPROXIMATE and drawn for Airwave.
Area-control frequencies are Airwave network frequencies, not real-world ones.
"""
import csv, json, math, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
SRC = os.path.join(ROOT, 'data', 'src')
OUT = os.path.join(ROOT, 'data', 'greece.json')

def rows(name):
    with open(os.path.join(SRC, name), encoding='utf-8') as f:
        return list(csv.DictReader(f))

def num(v, d=None):
    try: return float(v)
    except (TypeError, ValueError): return d

def bearing(lat1, lon1, lat2, lon2):
    x = (lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
    y = lat2 - lat1
    return (math.degrees(math.atan2(x, y)) + 360) % 360

def dist_nm(lat1, lon1, lat2, lon2):
    x = (lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2)) * 60
    return math.hypot(x, (lat2 - lat1) * 60)

def move(lat, lon, hdg, nm):
    return (lat + nm * math.cos(math.radians(hdg)) / 60,
            lon + nm * math.sin(math.radians(hdg)) / (60 * math.cos(math.radians(lat))))

# ------------------------------------------------------------------ airspace (approximate)
FIR = [  # (lat, lon), Athens FIR, simplified
    (39.65, 19.95), (39.86, 20.32), (40.10, 20.66), (40.45, 20.92), (40.85, 21.00), (40.95, 21.60),
    (41.12, 22.10), (41.13, 22.70), (41.35, 23.20), (41.40, 23.80), (41.57, 24.40), (41.45, 25.40),
    (41.35, 26.00), (41.72, 26.36), (41.30, 26.60), (40.85, 26.05), (40.20, 25.95), (39.95, 26.05),
    (39.30, 26.62), (38.95, 26.45), (38.35, 26.27), (37.95, 26.80), (37.70, 27.08), (37.35, 27.15),
    (36.90, 27.42), (36.60, 28.05), (36.40, 28.30), (36.15, 29.70), (35.00, 30.00), (34.00, 30.00),
    (34.00, 23.35), (35.83, 21.00), (37.50, 19.75), (39.25, 19.10)
]

def clip(poly, keep):
    """Sutherland-Hodgman clip against a half-plane given as (axis, value, side)."""
    axis, v, side = keep
    inside = (lambda p: p[axis] >= v) if side == '>=' else (lambda p: p[axis] < v)
    out = []
    for i in range(len(poly)):
        a, b = poly[i - 1], poly[i]
        ia, ib = inside(a), inside(b)
        if ia != ib:
            t = (v - a[axis]) / (b[axis] - a[axis])
            out.append((a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])))
        if ib: out.append(b)
    return out

def region(*planes):
    p = FIR
    for pl in planes: p = clip(p, pl)
    return [[round(a, 4), round(b, 4)] for a, b in p]

LAT, LON = 0, 1
SECTORS = [
    {'id': 'MAK', 'name': 'Makedonia', 'polygon': region((LAT, 39.6, '>='))},
    {'id': 'W', 'name': 'Athinai West', 'polygon': region((LAT, 39.6, '<'), (LAT, 35.9, '>='), (LON, 22.4, '<'))},
    {'id': 'C', 'name': 'Athinai Central', 'polygon': region((LAT, 39.6, '<'), (LAT, 35.9, '>='), (LON, 22.4, '>='), (LON, 24.6, '<'))},
    {'id': 'E', 'name': 'Athinai East', 'polygon': region((LAT, 39.6, '<'), (LAT, 35.9, '>='), (LON, 24.6, '>='))},
    {'id': 'S', 'name': 'Athinai South', 'polygon': region((LAT, 35.9, '<'))},
]
CTR = [  # Airwave network frequencies
    {'id': 'LGGG_CTR', 'name': 'Athinai Control', 'freq': '133.475', 'kind': 'CTR', 'covers': ['W', 'C', 'E', 'S']},
    {'id': 'LGGG_W_CTR', 'name': 'Athinai Control West', 'freq': '127.525', 'kind': 'CTR', 'covers': ['W']},
    {'id': 'LGGG_C_CTR', 'name': 'Athinai Control Central', 'freq': '132.225', 'kind': 'CTR', 'covers': ['C']},
    {'id': 'LGGG_E_CTR', 'name': 'Athinai Control East', 'freq': '134.775', 'kind': 'CTR', 'covers': ['E']},
    {'id': 'LGGG_S_CTR', 'name': 'Athinai Control South', 'freq': '125.575', 'kind': 'CTR', 'covers': ['S']},
    {'id': 'LGMD_CTR', 'name': 'Makedonia Control', 'freq': '133.975', 'kind': 'CTR', 'covers': ['MAK']},
]

# ------------------------------------------------------------------ airports
airports_src = [r for r in rows('airports.csv')
                if r['iso_country'] == 'GR' and r['ident'].startswith('LG')
                and r['type'] in ('large_airport', 'medium_airport', 'small_airport')]
by_id = {r['ident']: r for r in airports_src}

runways = {}
for r in rows('runways.csv'):
    if r['airport_ident'] not in by_id or r['closed'] == '1': continue
    ap = by_id[r['airport_ident']]
    length_nm = (num(r['length_ft'], 0) or 0) * 0.3048 / 1852
    la1, lo1, la2, lo2 = (num(r[k]) for k in ('le_latitude_deg', 'le_longitude_deg', 'he_latitude_deg', 'he_longitude_deg'))
    if None in (la1, lo1, la2, lo2):
        h = num(r['le_heading_degT'])
        if h is None:
            try: h = int(''.join(c for c in r['le_ident'] if c.isdigit())) * 10
            except ValueError: continue
        clat, clon = num(ap['latitude_deg']), num(ap['longitude_deg'])
        la1, lo1 = move(clat, clon, h + 180, length_nm / 2)
        la2, lo2 = move(clat, clon, h, length_nm / 2)
    hdg = bearing(la1, lo1, la2, lo2)
    if length_nm < 0.1: length_nm = dist_nm(la1, lo1, la2, lo2)
    runways.setdefault(r['airport_ident'], []).append({
        'le': r['le_ident'], 'he': r['he_ident'], 'surface': r['surface'],
        'lat': round((la1 + la2) / 2, 5), 'lon': round((lo1 + lo2) / 2, 5),
        'le_hdg': round(hdg, 1), 'len': round(length_nm, 2),
    })

def pick_active(rwys):
    """Default operations: longest runway, the end facing a northerly wind (the usual Greek pattern)."""
    best = max(rwys, key=lambda r: r['len'])
    out = []
    for r in rwys:
        le_into_north = math.cos(math.radians(r['le_hdg'])) >= 0
        rid, hdg = (r['le'], r['le_hdg']) if le_into_north else (r['he'], (r['le_hdg'] + 180) % 360)
        out.append({'id': rid, 'name': r['le'] + '/' + r['he'], 'lat': r['lat'], 'lon': r['lon'],
                    'hdg': round(hdg, 1), 'len': r['len'], 'surface': r['surface'], 'active': r is best})
    return out

KIND = {'CLD': 'DEL', 'GND': 'GND', 'TWR': 'TWR', 'AFIS': 'TWR', 'APP': 'APP', 'DEP': 'DEP', 'ARR': 'F_APP'}
WORD = {'DEL': 'Delivery', 'GND': 'Ground', 'TWR': 'Tower', 'APP': 'Approach', 'DEP': 'Departure', 'F_APP': 'Arrival'}
AREA = {  # radius nm, ceiling ft (above elevation for TWR/GND/DEL), rank (lower = more specific)
    'DEL': (3, 0, 0), 'GND': (3, 0, 0), 'TWR': (10, 4000, 1), 'F_APP': (25, 12000, 2), 'DEP': (35, 19500, 2), 'APP': (40, 19500, 3)}
freqs = {}
for r in rows('airport-frequencies.csv'):
    if r['airport_ident'] not in by_id: continue
    kind = KIND.get(r['type'])
    f = num(r['frequency_mhz'])
    if not kind or f is None or not (118 <= f < 137): continue
    freqs.setdefault(r['airport_ident'], []).append((kind, '%.3f' % f, r['description'], r['type']))

def title(s): return ' '.join(w.capitalize() for w in s.split())

airports, facilities = [], list(CTR)
for ident, r in sorted(by_id.items()):
    if ident not in runways: continue
    elev = int(num(r['elevation_ft'], 0) or 0)
    ap = {'icao': ident, 'name': r['name'], 'city': r['municipality'], 'iata': r['iata_code'],
          'type': r['type'].split('_')[0], 'scheduled': r['scheduled_service'] == 'yes',
          'lat': round(num(r['latitude_deg']), 5), 'lon': round(num(r['longitude_deg']), 5), 'elev': elev,
          'runways': pick_active(runways[ident]), 'procedures': []}
    airports.append(ap)
    seen = set()
    def place_of(desc):
        words = [w for w in desc.upper().replace('CLNC', '').split() if w not in ('APP', 'TWR', 'GND', 'DEP', 'ARR', 'DEL', 'AFIS', 'CLD', 'CONTROL')]
        return title(' '.join(words)) if words else None
    # Use the approach unit's place name (e.g. "Athinai") for every position at the airport when there is one.
    named = [place_of(d) for k, _, d, _ in freqs.get(ident, []) if k in ('APP', 'DEP', 'F_APP') and place_of(d)]
    default_place = named[0] if named else title(r['municipality'] or ident)
    for kind, f, desc, raw in freqs.get(ident, []):
        fid = ident + '_' + kind
        if fid in seen: continue
        seen.add(fid)
        place = default_place if named else (place_of(desc) or default_place)
        radius, ceiling, rank = AREA[kind]
        facilities.append({'id': fid, 'name': place + ' ' + ('Information' if raw == 'AFIS' else WORD[kind]), 'freq': f,
                           'kind': kind, 'airport': ident, 'rank': rank,
                           'area': {'lat': ap['lat'], 'lon': ap['lon'], 'radius': radius, 'ceiling': (elev + ceiling) if kind in ('TWR', 'GND', 'DEL') else ceiling},
                           'only': 'arr' if kind == 'F_APP' else 'dep' if kind == 'DEP' else None})

navaids, seen_nav = [], {}
for r in rows('navaids.csv'):
    if r['iso_country'] != 'GR': continue
    t = r['type']
    kind = 'ndb' if t == 'NDB' else 'tacan' if t == 'TACAN' else 'vor'
    ident = r['ident'].upper()
    if ident in seen_nav:
        if seen_nav[ident]['kind'] != 'ndb' or kind == 'ndb': continue  # prefer VOR over NDB on a shared ident
        navaids.remove(seen_nav[ident])
    f = num(r['frequency_khz'])
    n = {'id': ident, 'name': title(r['name']), 'kind': kind, 'type': t,
         'freq': ('%.2f' % (f / 1000)) if f and kind != 'ndb' else (str(int(f)) if f else ''),
         'lat': round(num(r['latitude_deg']), 5), 'lon': round(num(r['longitude_deg']), 5)}
    navaids.append(n); seen_nav[ident] = n

# ------------------------------------------------------------------ AIP en-route data (tools/aip/build_lgav.py)
AIRWAYS = []
ENR = os.path.join(ROOT, 'data', 'aip', 'enroute.json')
if os.path.exists(ENR):
    with open(ENR, encoding='utf-8') as f:
        enr = json.load(f)
    by_id = {n['id']: n for n in navaids}
    for n in enr['navaids']:                      # official positions replace community ones
        if n['id'] in by_id:
            by_id[n['id']].update(lat=n['lat'], lon=n['lon'], name=n['name'])
        else:
            navaids.append(dict(n)); by_id[n['id']] = navaids[-1]
    for w in enr['waypoints']:
        if w['id'] not in by_id:
            navaids.append({'id': w['id'], 'kind': 'wpt', 'lat': w['lat'], 'lon': w['lon']}); by_id[w['id']] = navaids[-1]
    for pid, (lat, lon) in enr.get('routePoints', {}).items():
        if pid not in by_id:
            navaids.append({'id': pid, 'kind': 'wpt', 'lat': lat, 'lon': lon}); by_id[pid] = navaids[-1]
    for name, pts in enr['airways'].items():
        for a, b in zip(pts, pts[1:]):
            if a in by_id and b in by_id: AIRWAYS.append([a, b, name])
    nav_ids = {n['id'] for n in navaids}
    print('AIP en-route: %d airway segments, %d fixes total' % (len(AIRWAYS), len(navaids)))

# ------------------------------------------------------------------ procedures (from the AIP, see data/procedures)
PROC_DIR = os.path.join(ROOT, 'data', 'procedures')
TYPES = {'SID', 'STAR', 'APP'}
APPROACHES = {'ILS', 'LOC', 'LPV', 'RNAV', 'RNP', 'VOR', 'VORDME', 'NDB', 'NDBDME', 'DME', 'VISUAL'}
problems, proc_count = [], 0
nav_ids = {n['id'] for n in navaids}
ap_by_icao = {a['icao']: a for a in airports}
if os.path.isdir(PROC_DIR):
    for name in sorted(os.listdir(PROC_DIR)):
        if not name.endswith('.json'): continue
        with open(os.path.join(PROC_DIR, name), encoding='utf-8') as f:
            data = json.load(f)
        icao = data.get('icao', name[:4]).upper()
        ap = ap_by_icao.get(icao)
        if not ap: problems.append('%s: unknown airport %s' % (name, icao)); continue
        wps = data.get('waypoints', [])
        ids = nav_ids | {w['id'] for w in wps}
        rwy_ids = {r['id'] for r in ap['runways']} | {e for r in ap['runways'] for e in r['name'].split('/')}
        for w in wps:
            if not (-90 <= w.get('lat', 999) <= 90 and -180 <= w.get('lon', 999) <= 180): problems.append('%s: waypoint %s has bad coordinates' % (name, w.get('id')))
            elif dist_nm(w['lat'], w['lon'], ap['lat'], ap['lon']) > 250: problems.append('%s: waypoint %s is over 250 NM from %s, check it' % (name, w['id'], icao))
        good = []
        for p in data.get('procedures', []):
            label = '%s %s %s' % (icao, p.get('type'), p.get('name'))
            errs = []
            if p.get('type') not in TYPES: errs.append('type must be SID, STAR or APP')
            if p.get('type') == 'APP' and str(p.get('approach', '')).upper() not in APPROACHES: errs.append('approach must be one of ' + ', '.join(sorted(APPROACHES)))
            if p.get('runway') not in rwy_ids | {'ALL'}: errs.append('runway %s is not at %s' % (p.get('runway'), icao))
            if not p.get('legs'): errs.append('has no legs')
            segs = [p.get('legs', []), p.get('missed', [])] + list((p.get('transitions') or {}).values())
            for l in [l for seg in segs for l in seg]:
                if l.get('fix') and l['fix'] not in ids and not l['fix'].startswith('RW'): errs.append('unknown fix ' + l['fix'])
                if l.get('altType') and l['altType'] not in ('at', 'above', 'below'): errs.append('altType must be at, above or below')
            if errs: problems.append(label + ': ' + '; '.join(errs))
            else: good.append(p)
        ap['waypoints'] = wps
        ap['procedures'] = good
        proc_count += len(good)
for msg in problems: print('WARNING ' + msg, file=sys.stderr)

# ------------------------------------------------------------------ coastline (Natural Earth 1:10m, public domain)
def build_coast():
    files = [os.path.join(SRC, f) for f in ('ne_10m_land.geojson', 'ne_10m_minor_islands.geojson')]
    if not all(os.path.exists(f) for f in files):
        print('Coastline skipped: put ne_10m_land.geojson and ne_10m_minor_islands.geojson from '
              'https://github.com/nvkelso/natural-earth-vector/tree/master/geojson in data/src', file=sys.stderr)
        return []
    try:
        from shapely.geometry import shape, box, Polygon, MultiPolygon
    except ImportError:
        print('Coastline skipped: pip install shapely', file=sys.stderr); return []
    area = box(18.5, 33.3, 30.8, 42.3)   # lon/lat box around the FIR
    rings = []
    for f in files:
        with open(f, encoding='utf-8') as fh:
            for feat in json.load(fh)['features']:
                g = shape(feat['geometry'])
                if not g.intersects(area): continue
                g = g.intersection(area).simplify(0.004, preserve_topology=True)   # ~0.25 NM
                polys = [g] if isinstance(g, Polygon) else list(getattr(g, 'geoms', []))
                for pg in polys:
                    if not isinstance(pg, Polygon) or pg.is_empty or pg.area < 2e-6: continue
                    rings.append([[round(y, 4), round(x, 4)] for x, y in pg.exterior.coords])
    return rings
COAST = build_coast()

# ------------------------------------------------------------------ magnetic variation (World Magnetic Model)
def build_magvar():
    try:
        from pygeomag import GeoMag
    except ImportError:
        print('Magnetic variation: pygeomag missing, using 5.0 E everywhere', file=sys.stderr)
        return {'epoch': 2026.8, 'lat0': 34, 'lon0': 19, 'step': 1, 'rows': [[5.0] * 12 for _ in range(9)]}
    import datetime
    t = datetime.date.today(); epoch = round(t.year + (t.timetuple().tm_yday - 1) / 365.25, 2)
    g = GeoMag()
    rows = [[round(g.calculate(glat=lat, glon=lon, alt=0, time=epoch).d, 2) for lon in range(19, 31)] for lat in range(34, 43)]
    return {'epoch': epoch, 'model': 'WMM', 'lat0': 34, 'lon0': 19, 'step': 1, 'rows': rows}
MAGVAR = build_magvar()

out = {
    'id': 'GREECE', 'name': 'Greece (Athens FIR)',
    'note': 'Waypoints, airways, navaid positions and LGAV procedures from the AIP Greece (AIRAC 2611). Airports and runways from OurAirports. FIR outline, sector split and area-control frequencies are still approximate. Not for real-world navigation.',
    'center': {'lat': 38.3, 'lon': 24.0}, 'transitionAlt': 6000, 'unicom': '122.800',
    'sectors': SECTORS, 'facilities': facilities, 'airports': airports,
    'fixes': navaids, 'airways': AIRWAYS, 'coast': COAST, 'magvar': MAGVAR,
    'source': 'OurAirports (public domain), https://ourairports.com/data/; coastline: Natural Earth (public domain); magnetic variation: World Magnetic Model'
}
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
print('Wrote %s: %d airports, %d runways, %d navaids, %d ATC positions, %d sectors, %d procedures, %d coastline shapes, %d KB' % (
    os.path.normpath(OUT), len(airports), sum(len(a['runways']) for a in airports), len(navaids), len(facilities), len(SECTORS), proc_count, len(COAST), os.path.getsize(OUT) // 1024))
