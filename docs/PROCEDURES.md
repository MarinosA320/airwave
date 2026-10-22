# Adding procedures

Procedures live in `data/procedures/<ICAO>.json`, one file per airport. After adding or changing one, run
`python3 tools/build-greece.py`. It checks every procedure and prints a warning for anything it can't use
(unknown fix, wrong runway, missing legs). Then restart the server.

Transcribe from the current HCAA AIP charts (AD 2 section of each airport). Always note the AIRAC cycle
you copied from, because procedures change.

## File format

```json
{
  "icao": "LGAV",
  "airac": "2610",
  "waypoints": [
    { "id": "ABCDE", "lat": 38.1234, "lon": 23.9876 }
  ],
  "procedures": [
    {
      "type": "STAR",
      "name": "ABCDE1A",
      "runway": "03R",
      "legs": [
        { "fix": "ABCDE", "alt": 13000, "altType": "above" },
        { "fix": "FGHIJ", "alt": 7000, "altType": "at", "spd": 220 }
      ]
    },
    {
      "type": "APP",
      "name": "ILS Z RWY 03R",
      "approach": "ILS",
      "runway": "03R",
      "legs": [
        { "fix": "IFxxx", "alt": 4000 },
        { "fix": "FAFxx", "alt": 3000, "faf": true }
      ]
    },
    {
      "type": "SID",
      "name": "KLMNO1B",
      "runway": "03R",
      "legs": [
        { "fix": "PQRST", "alt": 5000, "altType": "above" },
        { "fix": "KLMNO", "alt": 9000 }
      ]
    }
  ]
}
```

The names above are placeholders showing the shape of the file, not real procedures.

| Field | Meaning |
| --- | --- |
| `waypoints` | Fixes used by this airport's procedures that aren't VOR/NDB stations. Coordinates in decimal degrees. |
| `type` | `SID`, `STAR` or `APP` |
| `approach` | For `APP`: `ILS`, `LOC`, `LPV`, `RNAV`, `RNP`, `VOR`, `VORDME`, `NDB`, `NDBDME`, `DME` or `VISUAL` |
| `runway` | Runway the procedure serves, e.g. `03R`, or `ALL` |
| `legs` | Fixes in order. `fix` is a waypoint id or a navaid ident (e.g. `ATH`) |
| `alt`, `altType` | Altitude constraint in feet; `altType` is `at` (default), `above` or `below` |
| `spd` | Speed constraint in knots |
| `faf` | Marks the final approach fix. From there, aircraft fly the final segment to the runway. |

## What Airwave does with them

- **Scope:** STARs (green), SIDs (amber, dashed) and approaches (blue) can be switched on in the Map panel.
- **Simulated pilots:** arrivals fly the STAR that starts nearest to them, then the best approach for the
  active runway (ILS first, then LPV, RNAV, LOC, VOR, NDB). Departures fly a SID toward their destination and
  climb to its last altitude.
- **Controllers:** `STAR <name>` clears a STAR, `APP` clears the approach ("cleared ILS approach runway 03R").

## Limits for now

Legs are fix-to-fix. Arcs (DME arcs), holds, course-to-altitude legs and missed approaches aren't modelled yet.
Transcribe the fixes along the path; for an arc, a few points along it work well.
