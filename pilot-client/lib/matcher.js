'use strict';
/*
 * Model matching: picks an installed aircraft and livery for each network aircraft,
 * using its ICAO type (A20N, B738...) and airline (AEE, RYR...).
 *
 * Order of preference:
 *   1. your own rules in matching-rules.json
 *   2. same type and same airline
 *   3. same type, any livery
 *   4. similar aircraft (same family/size) with the airline's livery
 *   5. similar aircraft, any livery
 *   6. anything installed in the fallback list
 */
const fs = require('fs');
const path = require('path');

// How to recognise a type from an aircraft title or livery name.
const TYPE_PATTERNS = {
  A19N: /a ?319 ?neo/i, A319: /a ?319(?! ?neo)/i, A20N: /a ?320 ?neo/i, A320: /a ?320(?! ?neo)(?!.*neo)/i,
  A21N: /a ?321 ?(neo|lr|xlr)/i, A321: /a ?321(?! ?(neo|lr|xlr))/i, BCS3: /a ?220|cs ?300/i, BCS1: /cs ?100|a220-100/i,
  B736: /737-?600/i, B737: /737-?700|737ng(?!.*800)/i, B738: /737-?800|737ng|737-800/i, B739: /737-?900/i,
  B38M: /737 ?max ?8|737-8(?!00)|b38m/i, B39M: /737 ?max ?9/i,
  B752: /757-?200|\b757\b/i, B763: /767-?300|\b767\b/i, B772: /777-?200(?!lr)/i, B77L: /777-?200lr|777f/i, B77W: /777-?300(er)?/i,
  B788: /787-?8/i, B789: /787-?9/i, B78X: /787-?10/i, B748: /747-?8/i, B744: /747-?400/i,
  A332: /a ?330-?200/i, A333: /a ?330-?300|a ?330(?!-?[29]00)(?!neo)/i, A339: /a ?330 ?neo|a330-900/i,
  A359: /a ?350-?900|a ?350(?!-?1000)/i, A35K: /a ?350-?1000/i, A388: /a ?380/i,
  E170: /e ?170/i, E175: /e ?175/i, E190: /e ?190|e-?jet/i, E195: /e ?195/i, E290: /e ?190-?e2/i,
  CRJ7: /crj ?700/i, CRJ9: /crj ?900/i, AT76: /atr ?72/i, AT45: /atr ?42/i, DH8D: /q400|dash ?8/i,
  C172: /\b172\b|skyhawk/i, C208: /caravan|\b208\b/i, PC12: /pc-?12/i, TBM9: /tbm ?9/i, BE58: /baron/i, DA62: /da ?62/i, SR22: /sr ?22/i
};

// Similar aircraft, best substitute first.
const FAMILIES = [
  ['A20N', 'A320', 'A21N', 'A321', 'A19N', 'A319', 'B38M', 'B738', 'B737', 'B739', 'B39M', 'B736', 'BCS3', 'E195', 'E190'],
  ['BCS3', 'BCS1', 'E195', 'E190', 'E290', 'E175', 'E170', 'CRJ9', 'CRJ7', 'A319', 'A320'],
  ['AT76', 'AT45', 'DH8D', 'E175', 'CRJ7'],
  ['B77W', 'B77L', 'B772', 'A35K', 'A359', 'B789', 'B78X', 'B788', 'A339', 'A333', 'A332', 'B763', 'B744', 'B748', 'A388'],
  ['A388', 'B748', 'B744', 'B77W'],
  ['B752', 'A321', 'A21N', 'B739'],
  ['C172', 'DA40', 'SR22', 'PA28', 'C208', 'DA62', 'BE58', 'TBM9', 'PC12']
];

const AIRLINES = {
  AEE: ['aegean'], OAL: ['olympic'], SEH: ['sky express', 'skyexpress'], RYR: ['ryanair'], EZY: ['easyjet'], EJU: ['easyjet'],
  WZZ: ['wizz'], DLH: ['lufthansa'], BAW: ['british airways', 'british'], AFR: ['air france'], KLM: ['klm'], UAE: ['emirates'],
  QTR: ['qatar'], TRA: ['transavia'], TOM: ['tui'], EXS: ['jet2'], CFG: ['condor'], VIR: ['virgin'], SWR: ['swiss'], AUA: ['austrian'],
  ITY: ['ita airways', 'ita'], THY: ['turkish'], PGT: ['pegasus'], VLG: ['vueling'], IBE: ['iberia'], TAP: ['tap'], SAS: ['scandinavian', 'sas'],
  FIN: ['finnair'], LOT: ['lot polish', 'lot'], ELY: ['el al'], ETD: ['etihad'], AAL: ['american'], DAL: ['delta'], UAL: ['united'],
  EWG: ['eurowings'], NAX: ['norwegian'], CFE: ['ba cityflyer', 'cityflyer'], KLC: ['klm cityhopper', 'cityhopper'], BEE: ['flybe'],
  EIN: ['aer lingus'], SXS: ['sunexpress'], CYP: ['cyprus airways'], MSR: ['egyptair'], RJA: ['royal jordanian'], MEA: ['middle east']
};

function typesFromText(text) {
  const out = [];
  for (const [t, re] of Object.entries(TYPE_PATTERNS)) if (re.test(text)) out.push(t);
  // Prefer the more specific variants when several match (A320neo also matches A320).
  if (out.includes('A20N')) return out.filter(t => t !== 'A320');
  if (out.includes('A21N')) return out.filter(t => t !== 'A321');
  if (out.includes('B38M')) return out.filter(t => t !== 'B738');
  return out;
}
function airlineFromText(text) {
  const low = ' ' + text.toLowerCase() + ' ';
  for (const [code, names] of Object.entries(AIRLINES)) {
    if (names.some(n => low.includes(n.length <= 3 ? ' ' + n + ' ' : n))) return code;
    if (new RegExp('\\b' + code.toLowerCase() + '\\b').test(low)) return code;
  }
  return '';
}
function hash(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

class ModelMatcher {
  constructor({ rulesFile, log = () => {} } = {}) {
    this.models = [];
    this.rules = [];
    this.fallback = [];
    this.log = log;
    if (rulesFile && fs.existsSync(rulesFile)) {
      try {
        const r = JSON.parse(fs.readFileSync(rulesFile, 'utf8'));
        this.rules = r.rules || [];
        this.fallback = r.fallback || [];
      } catch (e) { log('Could not read ' + path.basename(rulesFile) + ': ' + e.message); }
    }
  }

  // models: [{ title, livery?, type?, airline? }]. type/airline are filled in from the names when missing.
  setModels(models) {
    this.models = models.map(m => {
      const text = (m.title || '') + ' ' + (m.livery || '');
      const types = m.type ? [m.type.toUpperCase()] : typesFromText(text);
      return Object.assign({}, m, { types, airline: (m.airline || airlineFromText(text) || '').toUpperCase() });
    }).filter(m => m.title);
    const typed = this.models.filter(m => m.types.length).length;
    this.log(`Model matching: ${this.models.length} liveries installed, ${typed} with a recognised aircraft type.`);
  }

  match(type, airline, callsign = '') {
    type = (type || '').toUpperCase(); airline = (airline || '').toUpperCase();
    const pickOne = list => list[hash(callsign || type + airline) % list.length];
    // 1. Your rules
    for (const r of this.rules) {
      if (r.type && r.type.toUpperCase() !== type) continue;
      if (r.airline && r.airline.toUpperCase() !== airline) continue;
      if (r.callsign && !new RegExp(r.callsign, 'i').test(callsign)) continue;
      return { title: r.title, livery: r.livery || '', quality: 'rule', why: 'your rule' };
    }
    if (!this.models.length) return null;
    const family = FAMILIES.find(f => f.includes(type)) || [];
    const ofType = t => this.models.filter(m => m.types.includes(t));
    const steps = [
      ['exact', () => ofType(type).filter(m => airline && m.airline === airline)],
      ['type', () => { const l = ofType(type); const generic = l.filter(m => !m.airline); return generic.length ? generic : l; }],
      ['similar+airline', () => { for (const t of family) { const l = ofType(t).filter(m => airline && m.airline === airline); if (l.length) return l; } return []; }],
      ['similar', () => { for (const t of family) { const l = ofType(t); if (l.length) return l; } return []; }],
      ['fallback', () => { for (const t of this.fallback.concat(['A320', 'A20N', 'B738', 'C172'])) { const l = ofType(t); if (l.length) return l; } return this.models.filter(m => m.types.length); }]
    ];
    for (const [quality, fn] of steps) {
      const list = fn();
      if (list.length) { const m = pickOne(list); return { title: m.title, livery: m.livery || '', quality, why: quality === 'exact' ? type + ' ' + airline : quality }; }
    }
    return null;
  }
}

// ---------------------------------------------------------------- MSFS 2020 package scan
function parseCfg(text) {
  const out = {}; let sec = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*$/, '').trim();
    if (!line) continue;
    const s = line.match(/^\[(.+)\]$/); if (s) { sec = s[1].toUpperCase(); out[sec] = out[sec] || {}; continue; }
    const kv = line.match(/^([^=]+)=(.*)$/); if (kv && sec) out[sec][kv[1].trim().toLowerCase()] = kv[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}
function findPackagesPath() {
  const env = process.env;
  const candidates = [
    env.APPDATA && path.join(env.APPDATA, 'Microsoft Flight Simulator', 'UserCfg.opt'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Packages', 'Microsoft.FlightSimulator_8wekyb3d8bbwe', 'LocalCache', 'UserCfg.opt'),
    env.APPDATA && path.join(env.APPDATA, 'Microsoft Flight Simulator 2024', 'UserCfg.opt'),
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe', 'LocalCache', 'UserCfg.opt')
  ].filter(Boolean);
  for (const f of candidates) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(/InstalledPackagesPath\s+"([^"]+)"/);
      if (m) return m[1];
    } catch (e) { /* not this install */ }
  }
  return null;
}
function scanPackages(root, log = () => {}) {
  const models = [];
  const roots = [path.join(root, 'Community'), path.join(root, 'Official', 'OneStore'), path.join(root, 'Official', 'Steam')];
  const walkAirplanes = dir => {
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const cfgFile = path.join(dir, e.name, 'aircraft.cfg');
      if (!fs.existsSync(cfgFile)) continue;
      try {
        const cfg = parseCfg(fs.readFileSync(cfgFile, 'utf8'));
        const gen = cfg.GENERAL || {};
        for (const [sec, v] of Object.entries(cfg)) {
          if (!sec.startsWith('FLTSIM.') || !v.title) continue;
          models.push({ title: v.title, livery: '', type: (gen.icao_type_designator || v.icao_type_designator || '').toUpperCase() || undefined, airline: (v.icao_airline || '').toUpperCase() || undefined });
        }
      } catch (err) { /* skip unreadable aircraft */ }
    }
  };
  for (const r of roots) {
    let pkgs; try { pkgs = fs.readdirSync(r, { withFileTypes: true }); } catch (e) { continue; }
    for (const p of pkgs) if (p.isDirectory()) walkAirplanes(path.join(r, p.name, 'SimObjects', 'Airplanes'));
  }
  log(`Scanned ${root}: found ${models.length} aircraft liveries.`);
  return models;
}

module.exports = { ModelMatcher, typesFromText, airlineFromText, parseCfg, findPackagesPath, scanPackages, AIRLINES, FAMILIES };
