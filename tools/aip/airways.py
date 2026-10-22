"""Airways from AIP ENR 3.1 (conventional) and ENR 3.2 (RNAV): ordered points per route."""
import re
from common import COORD, dms, doc

ROUTE = re.compile(r'^(?:[A-Z]{1,2}\d{1,4}|[A-Z]/[A-Z]{1,2}\d{1,4})(?:/[A-Z]{1,2}\d{1,4})?$')
NAVAID = re.compile(r'\(([A-Z]{2,3})\)')
NAME5 = re.compile(r'^([A-Z]{5})\b')

def parse(d):
    routes = {}
    for suffix in ('ENR_3_1_en.pdf', 'ENR_3_2_en.pdf'):
        current = None
        for page in doc(d, suffix):
            lines = [l.strip() for l in page.split('\n')]
            for i, line in enumerate(lines):
                first = line.split(' ')[0]
                if ROUTE.match(first) and (line == first or line.startswith(first + ' ')) and not COORD.search(line):
                    m = re.match(r'^[A-Z]/U?([A-Z]{1,2}\d+)', first)    # "A/UA14" means A14 and UA14
                    current = m.group(1) if m else first.split('/')[0]
                    routes.setdefault(current, [])
                    continue
                c = COORD.search(line)
                if not c or current is None or c.start() > 3:
                    continue
                ident = None
                for back in range(1, 5):
                    if i - back < 0: break
                    prev = lines[i - back]
                    m = NAVAID.search(prev)
                    if m: ident = m.group(1); break
                    m = NAME5.match(prev)
                    if m and m.group(1) not in ('CLASS', 'ABOVE', 'BELOW', 'TOTAL'): ident = m.group(1); break
                if not ident: continue
                lat, lon = dms(c)
                pts = routes[current]
                if not pts or pts[-1][0] != ident:
                    pts.append((ident, lat, lon))
    return {k: v for k, v in routes.items() if len(v) >= 2}
