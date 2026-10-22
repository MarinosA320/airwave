# AIP Greece import

Airwave reads procedures, waypoints, airways and navaids from the official AIP Greece published by
HASP AIS at https://aisgr.hasp.gov.gr. The site asks for a "not a robot" check, so the AIP text is
extracted in a browser and saved as JSON, then turned into Airwave data here.

## Files

| File | What it is |
| --- | --- |
| `data/src/aip/airwave-aip-lgav.json` | Text of ENR 2.1, 3.1, 3.2, 4.1, 4.4 and the LGAV AD 2 section and charts (not in git) |
| `data/src/aip/airwave-aip-lgav-charts.json` | Word positions on the LGAV coded-table charts, plus scanned charts (not in git) |
| `tools/aip/build_lgav.py` | Builds `data/aip/enroute.json` (266 waypoints, 36 navaids, 101 airways) and `data/procedures/LGAV.json` |
| `tools/aip/coded_tables.py` | Reads PANS-OPS coded tables (sequence, waypoint, path terminator, altitude, speed, coordinates) |
| `tools/aip/airways.py` | Reads ENR 3.1 / 3.2 route tables |

After running `build_lgav.py`, run `python3 tools/build-greece.py` to rebuild the map.

## What is imported for LGAV (AIRAC 2611, AMDT 09/26, effective 29 OCT 2026)

- 24 RNAV SIDs (charts SID-15 to SID-18, all four runways)
- 33 RNAV STARs (STAR-4 for runways 03L/R, STAR-5 for 21L/R)
- 9 approaches with their initial-approach transitions and missed approaches:
  ILS X (03L, 03R, 21L, 21R), RNP 03L, RNP Z 03R, RNP Y 03R, RNP 21L, RNP 21R

Coordinates were checked against ENR 4.4 (identical) and against navaid positions (within 0.5 NM).

## Not yet imported

- Conventional SIDs based on SAT/SPA VOR (SID-1, 4, 6, 8, 9, 11, 13, 14): described in words, need converting radials and DME distances into points.
- Scanned charts with no text: ILS Y/Z and LOC (IAC-8 to 13), VOR approaches (IAC-15 to 21), conventional STARs (STAR-1, STAR-3).
- Other airports and the real ACC sectorisation in ENR 2.1.

Not for real-world navigation. The AIP remains the authoritative source.
