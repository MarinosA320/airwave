'use strict';
// What a pilot can ask for or say, grouped for the Airwave Pilot window and the in-sim panel.
// The server turns each into proper phraseology (see REQUESTS in shared/airwave-core.js).
// arg: what the extra value is (shown as a box to fill in); options: suggested values.
const REQUEST_GROUPS = [
  { group: 'Clearance and ground', items: [
    { kind: 'ifr', label: 'IFR clearance', arg: 'dest', hint: 'destination', fromPlan: 'arr' },
    { kind: 'vfr', label: 'VFR clearance', arg: 'dest', hint: 'destination or route (optional)' },
    { kind: 'startup', label: 'Start-up and pushback' },
    { kind: 'taxi', label: 'Taxi' },
    { kind: 'twy', label: 'Taxi via another taxiway', arg: 'twy', hint: 'taxiway, e.g. B' },
    { kind: 'intersection', label: 'Intersection departure', arg: 'twy', hint: 'intersection, e.g. A3' },
    { kind: 'ready', label: 'Ready for departure', arg: 'rwy', hint: 'runway (optional)' },
    { kind: 'vacated', label: 'Runway vacated', arg: 'rwy', hint: 'runway (optional)' }
  ] },
  { group: 'Runway and procedures', items: [
    { kind: 'rwy', label: 'Another runway', arg: 'rwy', hint: 'runway, e.g. 03L' },
    { kind: 'sid', label: 'Another SID', arg: 'sid', hint: 'SID name' },
    { kind: 'star', label: 'Another STAR', arg: 'star', hint: 'STAR name' },
    { kind: 'app', label: 'Another approach', arg: 'app', hint: 'e.g. RNP Z RWY 03R' },
    { kind: 'visual', label: 'Visual approach', arg: 'rwy', hint: 'runway (optional)' }
  ] },
  { group: 'En route', items: [
    { kind: 'higher', label: 'Climb', arg: 'alt', hint: 'FL360 or 9000' },
    { kind: 'lower', label: 'Descent', arg: 'alt', hint: 'FL120 or 6000' },
    { kind: 'direct', label: 'Direct to', arg: 'fix', hint: 'waypoint, e.g. KEA' },
    { kind: 'weather', label: 'Heading for weather', arg: 'hdg', hint: 'heading, e.g. 090' },
    { kind: 'speed', label: 'No speed restriction' },
    { kind: 'confirmspeed', label: 'Confirm no speed restriction?' }
  ] },
  { group: 'Calls', items: [
    { kind: 'checkin', label: 'Check in' },
    { kind: 'established', label: 'Established on final', arg: 'app', hint: 'approach (optional)' },
    { kind: 'goaround', label: 'Going around' },
    { kind: 'cancelifr', label: 'Cancel IFR' }
  ] },
  { group: 'Replies', items: [
    { kind: 'wilco', label: 'Wilco' },
    { kind: 'unable', label: 'Unable', arg: 'reason', hint: 'reason', options: ['due to performance', 'due to weather', 'due to traffic', 'due to aircraft limits', 'to comply with altitude restriction'] },
    { kind: 'sayagain', label: 'Say again' },
    { kind: 'standby', label: 'Standby' }
  ] },
  { group: 'Emergency', items: [
    { kind: 'pan', label: 'PAN PAN', arg: 'reason', hint: 'what is wrong' },
    { kind: 'mayday', label: 'MAYDAY', arg: 'reason', hint: 'what is wrong' }
  ] }
];
module.exports = { REQUEST_GROUPS };
