#!/usr/bin/env node
/*
 * Installs (or removes) the Airwave parts that live inside the simulators:
 *   - MSFS 2020 and 2024: the toolbar panel package, copied into every Community folder found
 *   - X-Plane 12: the Airwave plugin (traffic + ATC window), copied into Resources/plugins of every X-Plane 12 found
 *
 *   node pilot-client/install-addons.js               install / update
 *   node pilot-client/install-addons.js --uninstall   remove (X-Plane CSL models you added are kept)
 *   node pilot-client/install-addons.js --community "D:\MSFS\Community" --xplane "D:\X-Plane 12"   extra folders
 *
 * The setup program runs this after installing, and Airwave Pilot has a button for it.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..');
const MSFS_PACKAGE = path.join(APP, 'sim-addons', 'msfs', 'airwave-pilot-panel');
const XP_PLUGIN = path.join(APP, 'sim-addons', 'xplane', 'Airwave');
const PACKAGE_NAME = 'airwave-pilot-panel';

// Where each simulator writes UserCfg.opt, which names the folder holding Community.
function msfsConfigs(env) {
  const ad = env.APPDATA || '', lad = env.LOCALAPPDATA || '';
  return [
    ['MSFS 2020 (Steam)', path.join(ad, 'Microsoft Flight Simulator', 'UserCfg.opt')],
    ['MSFS 2020 (Microsoft Store)', path.join(lad, 'Packages', 'Microsoft.FlightSimulator_8wekyb3d8bbwe', 'LocalCache', 'UserCfg.opt')],
    ['MSFS 2024 (Steam)', path.join(ad, 'Microsoft Flight Simulator 2024', 'UserCfg.opt')],
    ['MSFS 2024 (Microsoft Store)', path.join(lad, 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe', 'LocalCache', 'UserCfg.opt')]
  ];
}
function findCommunityFolders(env) {
  const out = [];
  for (const [sim, cfg] of msfsConfigs(env)) {
    let text; try { text = fs.readFileSync(cfg, 'utf8'); } catch (e) { continue; }
    const m = /^\s*InstalledPackagesPath\s+"([^"]+)"/m.exec(text);
    if (!m) continue;
    const community = path.join(m[1], 'Community');
    if (fs.existsSync(community) && !out.some(o => o.dir.toLowerCase() === community.toLowerCase())) out.push({ sim, dir: community });
  }
  return out;
}
// X-Plane lists its installs in x-plane_install_12.txt (Windows: %LOCALAPPDATA%, Mac: ~/Library/Preferences, Linux: ~/.x-plane).
function findXPlaneFolders(env) {
  const home = env.USERPROFILE || env.HOME || '';
  const lists = [path.join(env.LOCALAPPDATA || '', 'x-plane_install_12.txt'), path.join(home, 'Library', 'Preferences', 'x-plane_install_12.txt'), path.join(home, '.x-plane', 'x-plane_install_12.txt')];
  const out = [];
  for (const f of lists) {
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    for (const line of text.split(/\r?\n/)) {
      const dir = line.trim().replace(/[\\/]+$/, '');
      if (dir && fs.existsSync(path.join(dir, 'Resources', 'plugins')) && !out.some(o => o.dir === dir)) out.push({ sim: 'X-Plane 12', dir });
    }
  }
  return out;
}

function copyDir(src, dst, skip) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (skip && skip(s)) continue;
    if (e.isDirectory()) copyDir(s, d, skip); else fs.copyFileSync(s, d);
  }
}
function removeExcept(dir, keep) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (keep(p)) continue;
    if (e.isDirectory() && fs.readdirSync(p).length && [...walk(p)].some(keep)) removeExcept(p, keep);
    else fs.rmSync(p, { recursive: true, force: true });
  }
  if (!fs.readdirSync(dir).length) fs.rmdirSync(dir);
}
function* walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); yield p; if (e.isDirectory()) yield* walk(p); } }

function installAddons({ uninstall = false, community = [], xplane = [], env = process.env, msfsPackage = MSFS_PACKAGE, xpPlugin = XP_PLUGIN } = {}) {
  const report = [];
  const msfs = findCommunityFolders(env).concat(community.map(dir => ({ sim: 'MSFS', dir })));
  const xp = findXPlaneFolders(env).concat(xplane.map(dir => ({ sim: 'X-Plane 12', dir })));
  for (const { sim, dir } of msfs) {
    const target = path.join(dir, PACKAGE_NAME);
    try {
      if (uninstall) { fs.rmSync(target, { recursive: true, force: true }); report.push({ sim, ok: true, text: 'removed the Airwave panel from ' + dir }); continue; }
      if (!fs.existsSync(msfsPackage)) throw new Error('panel files missing from this Airwave Pilot copy');
      fs.rmSync(target, { recursive: true, force: true });
      copyDir(msfsPackage, target);
      report.push({ sim, ok: true, text: 'Airwave panel installed in ' + dir });
    } catch (e) { report.push({ sim, ok: false, text: 'could not update ' + dir + ': ' + e.message }); }
  }
  for (const { sim, dir } of xp) {
    const target = path.join(dir, 'Resources', 'plugins', 'Airwave');
    const isCsl = p => p.startsWith(path.join(target, 'Resources', 'CSL'));
    try {
      if (uninstall) { removeExcept(target, isCsl); report.push({ sim, ok: true, text: 'removed the Airwave plugin from ' + dir + (fs.existsSync(target) ? ' (kept your CSL models)' : '') }); continue; }
      if (!fs.existsSync(xpPlugin)) throw new Error('the X-Plane plugin is not included in this copy (it comes with the Windows setup)');
      // Updating keeps any CSL model packs you put in Resources/CSL.
      copyDir(xpPlugin, target);
      report.push({ sim, ok: true, text: 'Airwave plugin installed in ' + dir });
    } catch (e) { report.push({ sim, ok: false, text: 'could not update ' + dir + ': ' + e.message + (/EBUSY|EPERM/.test(e.code || '') ? ' (close X-Plane first)' : '') }); }
  }
  if (!msfs.length) report.push({ sim: 'MSFS', ok: null, text: 'no MSFS 2020 or 2024 Community folder found' });
  if (!xp.length) report.push({ sim: 'X-Plane 12', ok: null, text: 'no X-Plane 12 installation found' });
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const list = flag => args.reduce((a, v, i) => (args[i - 1] === flag ? a.concat(v) : a), []);
  const report = installAddons({ uninstall: args.includes('--uninstall'), community: list('--community'), xplane: list('--xplane') });
  for (const r of report) console.log((r.ok === true ? 'OK    ' : r.ok === false ? 'FAIL  ' : '--    ') + r.sim + ': ' + r.text);
  process.exit(report.some(r => r.ok === false) ? 1 : 0);
}
module.exports = { installAddons, findCommunityFolders, findXPlaneFolders };
