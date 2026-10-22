#!/usr/bin/env python3
"""Builds data/procedures/LGAV.json and data/aip/enroute.json from the Greek AIP extract.

    python3 tools/aip/build_lgav.py

Inputs (made in the browser from the HCAA eAIP, see tools/aip/README.md):
  data/src/aip/airwave-aip-lgav.json         text of ENR 2.1, 3.1, 3.2, 4.1, 4.4 and LGAV AD 2 charts
  data/src/aip/airwave-aip-lgav-charts.json  word positions of the LGAV coded-table charts
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load, doc, COORD, dms, ROOT
import coded_tables as ct
import airways

text = load()
charts = json.load(open(os.path.join(ROOT, 'data', 'src', 'aip', 'airwave-aip-lgav-charts.json'), encoding='utf-8'))
AIRAC = '2611'

# ---------------------------------------------------------------- en-route: waypoints and airways
enr44 = '\n'.join(doc(text, 'ENR_4_4_en.pdf')).split('\n')
points = {}
for i, line in enumerate(enr44):
    m = re.match(r'^\s*([A-Z]{5})\b', line); c = COORD.search(line)
    if m and c and c.start() > 0: points[m.group(1)] = dms(c)
    elif re.fullmatch(r'\s*[A-Z]{5}\s*', line) and i + 1 < len(enr44):
        c2 = COORD.search(enr44[i + 1])
        if c2 and c2.start() < 3: points[line.strip()] = dms(c2)
routes = airways.parse(text)
# en-route navaids (ENR 4.1): name, type, ident, frequency; latitude on the first line, longitude on the next
navaids = {}
enr41 = '\n'.join(doc(text, 'ENR_4_1_en.pdf')).split('\n')
NAV = re.compile(r'^(.+?) (VOR/DME|VORTAC|DVOR/DME|VOR|DME|NDB|L|TACAN) ([A-Z]{2,3}) ([\d.]+) (MHz|kHz) .*?(\d{2})(\d{2})(\d{2}(?:\.\d+)?)([NS])')
for i, line in enumerate(enr41):
    m = NAV.match(line.strip())
    if not m: continue
    lon = None
    for nxt in enr41[i + 1:i + 3]:
        c = re.search(r'(\d{3})(\d{2})(\d{2}(?:\.\d+)?)([EW])', nxt)
        if c: lon = int(c.group(1)) + int(c.group(2)) / 60 + float(c.group(3)) / 3600; break
    if lon is None: continue
    lat = int(m.group(6)) + int(m.group(7)) / 60 + float(m.group(8)) / 3600
    kind = 'ndb' if m.group(2) in ('L', 'NDB') else 'vor'
    navaids[m.group(3)] = {'id': m.group(3), 'name': m.group(1).title(), 'kind': kind, 'type': m.group(2), 'freq': m.group(4), 'lat': round(lat, 6), 'lon': round(lon, 6)}
os.makedirs(os.path.join(ROOT, 'data', 'aip'), exist_ok=True)
with open(os.path.join(ROOT, 'data', 'aip', 'enroute.json'), 'w', encoding='utf-8') as f:
    json.dump({'airac': AIRAC, 'source': 'AIP Greece ENR 3.1, 3.2, 4.4',
               'waypoints': [{'id': k, 'lat': v[0], 'lon': v[1]} for k, v in sorted(points.items())],
               'navaids': sorted(navaids.values(), key=lambda n: n['id']),
               'airways': {k: [p[0] for p in v] for k, v in sorted(routes.items())},
               'routePoints': {p[0]: [p[1], p[2]] for v in routes.values() for p in v}}, f, separators=(',', ':'))
print('en-route: %d waypoints, %d navaids, %d airways' % (len(points), len(navaids), len(routes)))

# ---------------------------------------------------------------- LGAV procedures from coded tables
known = dict(points)                      # id -> (lat, lon), grows as tables give coordinates
def remember(legs):
    for l in legs:
        if 'lat' in l and l['fix']: known.setdefault(l['fix'], (l['lat'], l['lon']))

TITLES = {}   # chart -> title, from AD 2.24
ad = ' '.join('\n'.join(doc(text, 'LG_AD_2_LGAV_en.pdf')).split())
for m in re.finditer(r'ICAO: - (.{3,60}?) \d{2} [A-Z]{3} \d{2} AD 2-LGAV-((?:IAC|SID|STAR)-\d+)', ad):
    TITLES[m.group(2)] = m.group(1)
TITLES.setdefault('IAC-25', 'ILS X CAT I & II RWY 21R'); TITLES.setdefault('IAC-27', 'RNP Z RWY 03R')
TITLES.setdefault('IAC-29', 'RNP RWY 21L')

def chart_id(name): return re.search(r'LGAV_((?:IAC|SID|STAR)-\d+)_en', name).group(1)
def rwy_list(title):
    m = re.search(r'RWY\s?(\d{2})\s?([LR])?\s?(?:/\s?([LR]))?', title)
    if not m: return []
    if m.group(2) and m.group(3): return [m.group(1) + m.group(2), m.group(1) + m.group(3)]
    if m.group(2): return [m.group(1) + m.group(2)]
    return [m.group(1) + 'L', m.group(1) + 'R']

def clean_legs(legs, faf_before_rwy=False):
    out = []
    for l in legs:
        if not l['fix'] or l['path'] in ('HM', 'HA', 'HF'): continue
        leg = {'fix': l['fix']}
        for k in ('alt', 'altType', 'spd'):
            if k in l: leg[k] = l[k]
        if leg.get('altType') == 'at': del leg['altType']
        out.append(leg)
    if faf_before_rwy:
        rw = [i for i, l in enumerate(out) if l['fix'].startswith('RW')]
        if rw and rw[0] >= 1: out[rw[0] - 1]['faf'] = True
    return out

procs = []
for name, pages in sorted(charts['items'].items()):
    cid = chart_id(name); title = TITLES.get(cid, '')
    tables = ct.parse_doc(pages)
    for t in tables: remember(t['legs'])
    if cid.startswith(('SID', 'STAR')):
        if not tables: continue
        rwys = rwy_list(title)
        for t in tables:
            if not t['name'] or not t['legs']: continue
            kind = 'SID' if cid.startswith('SID') else 'STAR'
            for r in rwys:
                procs.append({'type': kind, 'name': t['name'], 'runway': r, 'legs': clean_legs(t['legs']), 'chart': 'AD 2-LGAV-' + cid})
    else:
        if not tables: continue
        final = next((t for t in tables if t['label'] and 'FINAL' in t['label']), None)
        if not final: print('WARNING no final approach table in', cid); continue
        rwy = rwy_list(title)[0]
        kind = 'ILS' if title.startswith('ILS') else 'RNP' if title.startswith('RNP') else title.split()[0]
        p = {'type': 'APP', 'name': title.replace(' CAT I & II', ''), 'approach': kind, 'runway': rwy,
             'legs': clean_legs(final['legs'], faf_before_rwy=True), 'chart': 'AD 2-LGAV-' + cid, 'transitions': {}}
        for t in tables:
            lab = t['label'] or ''
            m = re.match(r'INITIAL APCH FROM ([A-Z0-9]+)', lab)
            if m: p['transitions'][m.group(1)] = clean_legs(t['legs'])
            elif 'MISSED' in lab: p['missed'] = clean_legs(t['legs'])
        procs.append(p)

# waypoints used by the procedures that are not navaids
used = {l['fix'] for p in procs for seg in [p['legs'], p.get('missed', [])] + list(p.get('transitions', {}).values()) for l in seg}
NAVAIDS = {'ATV', 'KOR', 'KEA', 'EGN', 'DDM', 'KRO', 'SAT', 'SPA', 'TNG', 'MGR', 'ELF', 'DEK', 'KVR', 'SUN', 'SYR', 'TGR', 'KRN', 'PLH'}
wps, missing = [], []
for fid in sorted(used):
    if fid in known and fid not in NAVAIDS: wps.append({'id': fid, 'lat': round(known[fid][0], 6), 'lon': round(known[fid][1], 6)})
    elif fid not in known and fid not in NAVAIDS: missing.append(fid)
out = {'icao': 'LGAV', 'airac': AIRAC, 'source': 'AIP Greece AD 2 LGAV (AIRAC AMDT 09/26)', 'waypoints': wps, 'procedures': procs}
with open(os.path.join(ROOT, 'data', 'procedures', 'LGAV.json'), 'w', encoding='utf-8') as f:
    json.dump(out, f, indent=1)
from collections import Counter
print('LGAV: %d procedures %s, %d waypoints' % (len(procs), dict(Counter(p['type'] for p in procs)), len(wps)))
if missing: print('WARNING waypoints without coordinates:', missing)
