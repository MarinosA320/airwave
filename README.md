# Airwave

A flight sim network: a server, a browser-based ATC radar scope, and Airwave Pilot, the client for MSFS 2024/2020 and X-Plane 12.
Version 0.5.0. Default map: Greece (Athens FIR).

## What's here

| Path | What it is |
| --- | --- |
| `server/` | The Airwave server. Tracks pilots and controllers, relays radio and ATC instructions, serves the scope, the map and airport layouts. |
| `shared/airwave-core.js` | Network logic, procedures, top-down coverage and simulated pilots. Used by both the server and the scope's demo mode. |
| `atc-client/scope.html` | The ATC radar scope. |
| `pilot-client/` | Airwave Pilot: connects MSFS or X-Plane to the network and shows other pilots in your sim. |
| `xplane-plugin/` | Source of the X-Plane plugin that draws traffic (built on XPMP2). |
| `data/greece.json` | The Greek map: 53 airports, their runways, 110 navaids, 87 ATC positions, 5 area sectors. Built by `tools/build-greece.py`. |
| `data/procedures/` | SIDs, STARs and approaches, one file per airport. See `docs/PROCEDURES.md`. Empty for now. |
| `data/layouts/` | Airport ground layouts. Fill it with `node tools/fetch-layouts.js`. |
| `tools/` | Build scripts, the layout downloader and tests. |

## The Airwave network

| | Address |
| --- | --- |
| ATC scope (server) | https://airwave-lwhv.onrender.com |
| ATC scope (GitHub Pages) | https://marinosa320.github.io/airwave/ |
| Server for Airwave Pilot | `wss://airwave-lwhv.onrender.com/ws` (the default) |
| Server status | https://airwave-lwhv.onrender.com/status |

Controllers log on with the ATC password, pilots with the network password. The first connection after a quiet spell wakes the server, which takes about a minute.

## Running it online

The server runs for free on [Render](https://render.com), deployed straight from this GitHub repo:

1. Sign in to Render with your GitHub account.
2. Choose **New > Blueprint**, pick this repository, and confirm. Render reads `render.yaml`.
3. When asked, set `AIRWAVE_ATC_PASSWORD` (controllers need it to log on). Leave `AIRWAVE_PASSWORD` empty for an open network, or set it so pilots need a password too.
4. When the deploy finishes, your server is at `https://<name>.onrender.com`:
   - **ATC scope:** open that address in any browser.
   - **Pilots:** in Airwave Pilot, set Server to `wss://<name>.onrender.com/ws`.

Every push to `main` redeploys automatically. GitHub runs the tests on each push too; check the Actions tab before relying on a change.

**About the free plan:** the server sleeps after 15 minutes with nobody connected, and the first person to connect wakes it in about a minute.
While anyone is connected it stays awake. Free plans include 750 hours a month, enough to run one server all month.

**GitHub Pages (optional):** `.github/workflows/pages.yml` also publishes the scope at `https://<user>.github.io/<repo>/`.
Set the repository variable `AIRWAVE_SERVER_URL` to `wss://<name>.onrender.com/ws` so that page fills in your server. Pages needs a public repo on free GitHub accounts.

**Other hosts:** the `Dockerfile` runs the same server on Fly.io, Railway or any VPS. All settings come from environment variables:
`PORT`, `AIRWAVE_MAP`, `AIRWAVE_BOTS`, `AIRWAVE_PASSWORD`, `AIRWAVE_ATC_PASSWORD`, `AIRWAVE_MAX_CLIENTS`,
`AIRWAVE_EDITOR_PASSWORD`, `GITHUB_TOKEN`, `GITHUB_REPO` (see Sector editor below).

## Running it on your PC

1. Install [Node.js](https://nodejs.org) (version 18 or newer) and, for map rebuilds, Python 3.
2. Open a terminal in this folder and run:
   ```
   npm install
   npm start
   ```
3. Open http://localhost:8080, pick a position (for example `LGAV_APP`) and press **Connect**.

Options: `node server/server.js --port 8080 --bots 24 --map greece` (or `--map london`). `--bots 0` turns off simulated pilots.

On Windows you can also double-click `start-server.cmd`.

## Flying: Airwave Pilot

### Install (Windows)

Download **[AirwavePilotSetup.exe](https://github.com/MarinosA320/airwave/releases/latest/download/AirwavePilotSetup.exe)** and run it.
It installs for your Windows user only, so it doesn't ask for administrator rights, and Node.js is built in. It also:

- adds **Airwave Pilot** to the Start menu, plus a desktop shortcut if you tick that option;
- puts the **Airwave toolbar panel** into the Community folder of MSFS 2020 and 2024 (Steam and Microsoft Store);
- puts the **Airwave plugin** into every X-Plane 12 it finds.

The setup isn't code-signed yet, so Windows SmartScreen may say "Windows protected your PC". Click **More info**, then **Run anyway**.
Installed a simulator later, or moved it? Use **Install or update the panels in my simulators** in Airwave Pilot.
Uninstalling removes the panels again but keeps the CSL models you added to X-Plane.

From the source instead: run `npm install` once, then double-click `start-pilot.cmd` (or run `npm run pilot`).

### Use

1. Start **Airwave Pilot**. Its window opens in your browser at http://localhost:8090.
2. Pick your simulator, enter your callsign (e.g. `AEE602`), aircraft type (e.g. `A20N`) and flight plan, then press **Connect**.
3. Tune a controller by clicking it under **Online ATC**, or just set COM1 in your cockpit: Airwave follows your COM1 radio.
4. Instructions appear in the amber box. **Read back** sends the readback, and for "contact ..." it also changes frequency.

**Demo** mode flies a pretend aircraft near Athens, for trying everything without a simulator.

### In-sim panel

You don't need to leave the sim. The panel shows your frequency and station, the last ATC instruction with a **Read back** button,
radio messages and a reply box, and the controllers online (click one to tune).

- **MSFS 2020 / 2024:** click the **Airwave** button on the top toolbar. The panel is a window onto Airwave Pilot, which must be running.
- **X-Plane 12:** **Plugins > Airwave > Show / hide ATC panel**. It opens by itself when a new instruction arrives.
  In X-Plane's keyboard or joystick settings, search for "Airwave" to bind `airwave/toggle_panel` and `airwave/readback`.
  Read back from a joystick button is handy on final.

### MSFS 2024 and 2020

Airwave Pilot connects through SimConnect when MSFS is running.
Other pilots appear as AI aircraft, matched to what you have installed:

- **MSFS 2024:** Airwave asks the sim for every installed aircraft and livery.
- **MSFS 2020:** Airwave reads your Community and Official folders.

Matching tries, in order: your rules in `pilot-client/matching-rules.json`, the same type and airline, the same type in any livery,
a similar aircraft with the airline's livery, then a similar aircraft. The Airwave Pilot window shows what each aircraft is drawn as.

### X-Plane 12

1. The setup installs the plugin. Without the setup, copy the `Airwave` folder from the plugin download into `X-Plane 12/Resources/plugins/`.
2. Put CSL model packs into `plugins/Airwave/Resources/CSL/`. Bluebell CSL is a good free set; LiveTraffic or xPilot CSL folders work too.
3. Start X-Plane, then Airwave Pilot with **X-Plane 12** selected.

Your position is read over X-Plane's built-in network data (UDP 49000), so no X-Plane settings need changing.
The plugin listens on 127.0.0.1:49010 and reports which CSL model it picked for each aircraft. The same link carries the ATC panel.

Building the plugin yourself: run `xplane-plugin/get-xpmp2` and then CMake (see `xplane-plugin/CMakeLists.txt`), or push the
project to GitHub, where `.github/workflows/xplane-plugin.yml` builds it for Windows, Mac and Linux.

### Airport layouts (gates, stands, taxiways, aprons)

```
node tools/fetch-layouts.js LGAV LGTS LGIR     some airports
node tools/fetch-layouts.js                    every airport on the map (takes a few minutes)
```
This downloads from OpenStreetMap and saves `data/layouts/<ICAO>.json`. Restart the server, then zoom in on an
airport: aprons and taxiways appear first, then taxiway letters and holding points, then stand and gate numbers.
Layout data © OpenStreetMap contributors (ODbL). Quality varies by airport; big airports are usually well mapped.

## Positions

Every airport position with a published frequency: Delivery (`_DEL`), Ground (`_GND`), Tower (`_TWR`),
Approach (`_APP`), Departure (`_DEP`), Arrival (`_F_APP`). Area control: `LGMD_CTR` Makedonia Control,
`LGGG_CTR` Athinai Control (all of Athinai), and the split sectors `LGGG_W_CTR`, `LGGG_C_CTR`, `LGGG_E_CTR`, `LGGG_S_CTR`.

Coverage is top-down: an aircraft talks to the most specific online controller covering it. With only
`LGGG_CTR` online, it handles everything in Athinai; once `LGAV_APP` logs on, Athens traffic moves there.

## Using the scope

- **Select** an aircraft by clicking it on the radar or in the traffic list.
- **Assume** it to take control. Your aircraft turn blue, handoffs to you flash amber, conflicts turn red (STCA: under 5 NM and 1000 ft apart).
- **Map panel**: switch navaid names, STARs, SIDs, approaches and airport layouts on and off.
- **Command line**: start typing anywhere on the scope.

| Command | Meaning |
| --- | --- |
| `AEE123` | Select AEE123 (a unique part of the callsign also works) |
| `A` / `REL` | Assume / release |
| `L270` / `R090` / `H180` | Turn left / right / shortest way to a heading |
| `FL120` / `A60` | Climb or descend to FL120 / altitude 6000 ft |
| `S220` / `S0` | Speed 220 kt / cancel speed restriction |
| `D ATH` | Direct to a fix |
| `STAR <name>` | Clear a STAR |
| `APP` (or `ILS`) | Clear the best approach for the active runway (pick a specific one in the panel). From a heading, the aircraft intercepts the final course. |
| `RES` | Resume own navigation |
| `HO LGAV_APP` | Hand off to another controller |

| `SQ` / `SQ4521` | Assign a free squawk / a specific squawk |
| `SID KEA1A` | Clear a SID (departures) |
| `TAXI HP03R VIA A B2` | Taxi to a holding point (or `TAXI 204 VIA A` to a stand) |

Commands chain: `AEE123 A L270 FL80 S220`.

**Measuring and QDM/QDR:** click the ↔ button (or hold Shift) and drag between two points. Line ends snap to aircraft, navaids and airports.
A line between an aircraft and a navaid shows QDM, QDR, distance and time to go, and follows the aircraft. Bearings are magnetic
(World Magnetic Model, about 5°E over Greece). Right-click a line's label to remove it, or ✕ to clear all. The selected aircraft panel
also shows live QDM/QDR to any nearby navaid.

**Map layers:** coastline (Natural Earth) and terrain. Terrain comes from public elevation tiles that your browser downloads,
so it works on the server and GitHub Pages scope but not in offline copies.

**Runways in use:** in the **Runways** panel, pick an airport and tick arrival and departure runways (for example arrivals 03L and 03R,
departures 03R), then **Apply**. Every controller sees the change, STARs, approaches and SIDs on the scope follow it, and simulated traffic
uses those runways. A protocol message does the same: `{"t":"runways","icao":"LGAV","arr":["03L","03R"],"dep":["03R"]}`.

## Radio: clearances, requests, voice and ATIS

**Controllers** (selected aircraft panel, or the command line):

| Command | Meaning |
| --- | --- |
| `CLR [SID] [FL60]` / `VFR [A35]` | IFR clearance (destination from the flight plan, free squawk) / VFR clearance |
| `PUSH` | Push back and start-up approved |
| `LU [03R]` / `CTO [03R]` | Line up and wait / cleared for take-off (with the current wind) |
| `CTL [03R]` / `GA` | Cleared to land / go around |
| `HS 03R` / `CROSS 03R` / `RWY 03L` | Hold short / cross / expect runway |
| `VIS` | Cleared visual approach |
| `SAY text` | Free-text instruction (the pilot gets a read back button) |
| `OK` / `UNABLE` / `STBY` | Answer the aircraft's pending request: approve it, refuse it, or ask it to wait |

**Pilots** can request, from Airwave Pilot or the in-sim panel:
- IFR or VFR clearance, start-up, taxi, another taxiway, an intersection departure;
- another runway, SID, STAR or approach, or a visual approach;
- a climb, a descent, a direct, a heading for weather, no speed restriction, or "confirm no speed restriction";
- check in, established, going around, cancel IFR.

Replies are Wilco, Unable (with a reason), Say again and Standby, and there are PAN PAN and MAYDAY calls.
Each request is worded properly and sent on frequency. The controller sees it in **Requests**, on the radar tag (`REQ`), and in the
selected-aircraft panel, with a one-click answer.

**Simulated traffic** now uses the airport layouts. It pushes back from stands, taxis on real taxiways, holds short, lines up, takes off, lands,
rolls out, vacates (turning around on runways without a parallel taxiway) and taxis to a free stand.
When a controller covers an aircraft, it calls for clearance, start-up, taxi and take-off, reports established on final, and waits for each answer.
It goes around if it isn't cleared to land by short final.

**Voice:** hold **PTT** (a button, or a key you choose) in the scope or in Airwave Pilot. Everyone on the same frequency hears you through a radio filter.
In the sim, push-to-talk can be a joystick button: in MSFS, set it in Airwave Pilot (for example `joystick:0:button:3`);
in X-Plane, bind the `airwave/ptt` command. Voice uses the microphone of the Airwave Pilot browser window, so keep that window open.
**Read text aloud** speaks typed messages and the simulated pilots.

**ATIS** runs at airports with a published ATIS frequency (LGAV 136.125, LGTS and LGIR 127.550, LGRP and LGKR 126.350, LGKO 126.950).
Tune it to hear it, or read it in Airwave Pilot. It uses the real METAR from aviationweather.gov, the runways in use, and the remarks
controllers add, and it moves to the next letter whenever any of these change. Controllers' **Online** list shows every active frequency.

## Sector editor

Open `https://<your server>/editor` (or **Edit map** in the scope). It edits the live map:

- **Sectors:** drag corners, click an edge to add a corner, right-click a corner to remove it, draw new sectors (corners snap to neighbours), set floor and ceiling.
- **Positions:** callsigns, names, frequencies, which sectors each area controller covers, and the range of airport positions.
- **Waypoints and airways:** add, move, rename and delete waypoints; draw airways by clicking waypoints in order.
- **Procedures:** SIDs, STARs and approaches per airport, with altitude (at / at or above / at or below) and speed constraints, the FAF,
  approach transitions and the missed approach. Also the default runways the server starts with.
- **Ground:** taxiways, stands, gates, holding points and aprons. Turn on the OpenStreetMap background to trace them.

Undo with Ctrl+Z. **Save** asks for your name and the editor password (`AIRWAVE_EDITOR_PASSWORD`, or the ATC password if that is unset).
Saved changes apply at once for everyone connected; controllers' scopes reload the map.

The base map is never changed. Edits are stored as a small file, `data/overlay.json`, applied on top of it.
Render's free disk is wiped when the server sleeps, so to keep edits the server commits that file to this repo:

1. On GitHub: **Settings > Developer settings > Fine-grained tokens > Generate new token**. Repository access: only this repo.
   Permissions: **Contents: Read and write**. Copy the token.
2. On Render: your service > **Environment** > add `GITHUB_TOKEN` with that token. Save; Render restarts the server.

Commits from the editor say `[skip render]`, so saving does not restart the server. If two people edit at once, the second save
is refused and asks them to reload, so nobody overwrites someone else's work.

**Airport layouts on GitHub:** in the repository's Actions tab, run **Airport layouts** to download taxiways, stands and gates for every
airport (or a list of ICAO codes). It commits them to `data/layouts`, and Render redeploys with them. It also refreshes monthly.

## Tests

```
npm test                         network test (needs the server running)
node tools/test-pilot.js         Airwave Pilot: smoothing, model matching, X-Plane link, full loop in demo mode (needs the server)
node tools/test-procedures.js    simulated pilots fly STARs, approaches and SIDs
node tools/test-layouts.js       OpenStreetMap layout conversion
node tools/test-editor.js        sector editor saves, map reloads and runway changes (starts its own server)
node tools/test-panel.js         in-sim panels: X-Plane link, MSFS panel package, add-on installer
node tools/test-ground.js        ground traffic, controller exchanges, requests, ATIS and voice relay
```

## Protocol

JSON over WebSocket at `ws://<server>/ws`.

Pilot sends:
```
{"t":"hello","role":"pilot","callsign":"AEE123","aircraft":"A320"}
{"t":"fp","dep":"LGAV","arr":"LGTS","route":"...","cruise":36000}
{"t":"pos","lat":37.93,"lon":23.94,"alt":3000,"hdg":36,"gs":180,"vs":1500,"squawk":"4521","onGround":false}   (about once a second)
{"t":"tune","freq":"126.575"}
{"t":"msg","freq":"126.575","text":"Athinai Approach, AEE123, FL80"}
```
Server sends: `welcome`, `traffic` (nearby aircraft and online controllers, every second), `msg`, `instr` (ATC instructions), `error`.

Controller sends: `hello` with `role:"atc"` and a `facility`, then `instr`, `assume`, `release`, `handoff`, `msg`.

## Data sources and accuracy

- **AIP Greece** (HASP AIS, AIRAC 2611): all 266 named waypoints, 101 airways, official navaid positions, and Athens (LGAV) SIDs, STARs and approaches with transitions and missed approaches. See `tools/aip/README.md`.
- Airports, runways and airport frequencies: [OurAirports](https://ourairports.com/data/) (public domain). Community data; check against the AIP before relying on it.
- The FIR outline, the area sector split and area-control frequencies are approximate Airwave values.
- Default runway in use: the longest runway, landing into a northerly wind.
- Not for real-world navigation.

## Known limits

- Procedures are imported for LGAV so far; other airports and the conventional (VOR/NDB) charts are next (see `tools/aip/README.md`).
- Terrain isn't modelled; simulated pilots don't avoid mountains.
- No accounts yet. Use `AIRWAVE_ATC_PASSWORD` (and optionally `AIRWAVE_PASSWORD`) on an online server.
- No voice yet; radio is text.
- Airwave Pilot has been tested against a pretend simulator only. The first runs in MSFS and X-Plane will need checking, especially:
  attitude signs of AI aircraft in MSFS (`PITCH_SIGN` / `BANK_SIGN` in `pilot-client/lib/msfs.js`), and aircraft height on the ground.
- The Mac plugin isn't included yet; build it with the GitHub workflow.
