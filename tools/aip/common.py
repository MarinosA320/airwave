"""Shared helpers for reading text extracted from the Greek AIP (see tools/aip/README.md)."""
import json, os, re

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
SRC = os.path.join(ROOT, 'data', 'src', 'aip')

def load(name='airwave-aip-lgav.json'):
    with open(os.path.join(SRC, name), encoding='utf-8') as f:
        return json.load(f)

def doc(d, suffix):
    for k, v in d['docs'].items():
        if k.endswith(suffix):
            return v
    raise KeyError(suffix)

# 375432N 0235640E  or  375432.12N 0235640.50E
COORD = re.compile(r'(\d{2})(\d{2})(\d{2}(?:\.\d+)?)\s*([NS])\s+(\d{3})(\d{2})(\d{2}(?:\.\d+)?)\s*([EW])')

def dms(m):
    lat = int(m.group(1)) + int(m.group(2)) / 60 + float(m.group(3)) / 3600
    lon = int(m.group(5)) + int(m.group(6)) / 60 + float(m.group(7)) / 3600
    if m.group(4) == 'S': lat = -lat
    if m.group(8) == 'W': lon = -lon
    return round(lat, 6), round(lon, 6)
