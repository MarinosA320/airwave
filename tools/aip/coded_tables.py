"""Reads the PANS-OPS coded tables (RNAV SIDs, STARs and approaches) from AIP chart pages,
using each word's position on the page (extracted in the browser with pdf.js)."""
import re

SEQ = re.compile(r'^\d{3}$')
LAT = re.compile(r"^N\s*(\d{2})°\s*(\d{2})'\s*([\d.]+)\"?$")
LON = re.compile(r"^E\s*(\d{3})°\s*(\d{2})'\s*([\d.]+)\"?$")
NAME = re.compile(r'^([A-Z]{3,5})\s?(\d)\s?([A-Z])$')
APP_TITLE = re.compile(r'\b(RNP|RNAV \(GNSS\)|ILS|LOC|VOR|NDB)\b.*\bRWY\s?(\d{2}[LRC]?)')
SECTION = re.compile(r'(INITIAL APCH FROM [A-Z0-9]+|INTERMEDIATE APCH|FINAL APCH|MISSED APCH|HOLDING)')
LEGS = {'IF', 'TF', 'CF', 'DF', 'RF', 'FA', 'CA', 'VA', 'VM', 'FM', 'HM', 'HA', 'HF', 'VI', 'CI', 'FC', 'FD', 'CD', 'VD', 'AF', 'PI'}

def dm(m): return int(m.group(1)) + int(m.group(2)) / 60 + float(m.group(3)) / 3600

def parse_alt(tokens):
    """'+9000' at/above, '-FL240' at/below, '9000' at, '+5000 -FL110' window -> (alt, type, top)."""
    vals = []
    for t in tokens:
        for m in re.finditer(r'([+-]?)(FL\s?\d{2,3}|\d{3,5})', t):
            sign, v = m.group(1), m.group(2).replace(' ', '')
            ft = int(v[2:]) * 100 if v.startswith('FL') else int(v)
            if ft < 500: continue
            vals.append((sign, ft))
    if not vals: return None, None
    if len(vals) >= 2:
        lo = [v for s, v in vals if s == '+']; hi = [v for s, v in vals if s == '-']
        if lo: return lo[0], 'above'
        if hi: return hi[0], 'below'
    s, v = vals[0]
    return v, {'+': 'above', '-': 'below'}.get(s, 'at')

def joined(items):
    """Items plus versions joined with the next word on the same line (within 12 pt)."""
    out = list(items)
    by_line = sorted(items, key=lambda it: (round(it[1]), it[0]))
    near = lambda a, b: abs(a[1] - b[1]) < 1 and -2 <= b[0] - (a[0] + a[3]) < 12
    for i in range(len(by_line) - 1):
        a, b = by_line[i], by_line[i + 1]
        if near(a, b):
            out.append([a[0], a[1], a[2] + ' ' + b[2], b[0] + b[3] - a[0]])
            if i + 2 < len(by_line) and near(b, by_line[i + 2]):
                c = by_line[i + 2]
                out.append([a[0], a[1], a[2] + ' ' + b[2] + ' ' + c[2], c[0] + c[3] - a[0]])
    return out

def tables_on_page(page):
    items = page['items']
    allj = joined(items)
    headers = [it for it in items if it[2] == 'Sequence']
    out = []
    for h in headers:
        hx, hy = h[0], h[1]
        # The header block spans ~490 pt; take the header words on this table's line to locate columns.
        cols = {}
        for it in items:
            if abs(it[1] - hy) < 3 and hx - 5 <= it[0] <= hx + 500:
                cols.setdefault(it[2], it[0])
        right = hx + 500
        # rows: sequence numbers below the header, in this table's left column, until a gap or another header
        rows = sorted([it for it in items if SEQ.match(it[2]) and abs(it[0] - hx) < 15 and it[1] < hy - 5], key=lambda r: -r[1])
        tbl_rows, last_y = [], hy
        for r in rows:
            if last_y - r[1] > 45: break
            if any(o[2] == 'Sequence' and abs(o[0] - hx) < 15 and r[1] < o[1] < last_y for o in headers): break
            tbl_rows.append(r); last_y = r[1]
        if not tbl_rows: continue
        # name above the header (names are often split into two words, e.g. "ASTOV" + "1Q")
        cands = [it for it in joined(items) if hy < it[1] < hy + 60 and hx - 20 <= it[0] <= right and (NAME.match(it[2]) or APP_TITLE.search(it[2]))]
        cands.sort(key=lambda it: it[1] - hy)
        name = None
        if cands:
            m = NAME.match(cands[0][2])
            name = (m.group(1) + m.group(2) + m.group(3)) if m else cands[0][2]
        legs = []
        for r in tbl_rows:
            ry = r[1]
            line = sorted([it for it in items if abs(it[1] - ry) < 1.6 and hx - 5 <= it[0] <= right], key=lambda it: it[0])
            toks = [it[2] for it in line]
            ident = toks[1] if len(toks) > 1 else None
            path = next((t for t in toks if t in LEGS), None)
            # coordinates: the N line just above, the E line just below, in the coordinates column
            cx = cols.get('Coordinates', hx + 90)
            lat = next((LAT.match(it[2]) for it in allj if 0 < it[1] - ry < 9 and abs(it[0] - cx) < 45 and LAT.match(it[2])), None)
            lon = next((LON.match(it[2]) for it in allj if 0 < ry - it[1] < 9 and abs(it[0] - cx) < 45 and LON.match(it[2])), None)
            ax = cols.get('Altitude', None); sx = cols.get('Speed', cols.get('Limit'))
            alt_toks = [it[2] for it in line if ax and abs(it[0] - ax) < 30]
            alt, alt_type = parse_alt(alt_toks)
            spd = next((int(re.match(r'(\d{3})', it[2]).group(1)) for it in line if sx and abs(it[0] - sx) < 20 and re.match(r'^\d{3}-?$', it[2])), None)
            leg = {'seq': r[2], 'fix': ident, 'path': path}
            if lat and lon: leg['lat'] = round(dm(lat), 6); leg['lon'] = round(dm(lon), 6)
            if alt: leg['alt'] = alt; leg['altType'] = alt_type
            if spd: leg['spd'] = spd
            if 'Y' in toks[2:5]: leg['flyover'] = True
            legs.append(leg)
        lab = [it for it in joined(items) if hy < it[1] < hy + 60 and hx - 20 <= it[0] <= right and SECTION.search(it[2])]
        lab.sort(key=lambda it: (it[1] - hy, -len(it[2])))
        label = lab[0][2] if lab else None
        out.append({'name': name, 'label': label, 'x': hx, 'y': hy, 'legs': legs})
    return out

def parse_doc(pages):
    res = []
    for p in pages:
        res.extend(tables_on_page(p))
    return res
