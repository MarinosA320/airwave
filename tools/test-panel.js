#!/usr/bin/env node
// In-sim panels: the X-Plane panel link, the MSFS panel package, and the add-on installer (with pretend MSFS and X-Plane folders).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');
const { XPlaneAdapter, panelLines } = require('../pilot-client/lib/xplane');
const { installAddons } = require('../pilot-client/install-addons');

let failed = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failed++; };
const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'sim-addons', 'msfs', 'airwave-pilot-panel');

// --- MSFS package
{
  const spb = fs.readFileSync(path.join(PKG, 'InGamePanels', 'airwave-pilot-panel.spb'));
  check(spb.readUInt16LE(0) === 0xEBAC && spb.readInt32LE(2 + 6 * 4) === 18, 'panel SPB has the SPB signature and 17 property tags');
  const bodyAt = 2 + 48 + 17 * 20;
  check(spb.readInt32LE(bodyAt) === 1 && bodyAt + 8 + spb.readInt32LE(bodyAt + 4) === spb.length, 'panel SPB document size matches the file');
  const layout = JSON.parse(fs.readFileSync(path.join(PKG, 'layout.json'), 'utf8'));
  const wrong = layout.content.filter(c => !fs.existsSync(path.join(PKG, c.path)) || fs.statSync(path.join(PKG, c.path)).size !== c.size);
  check(!wrong.length, 'layout.json lists every package file with its size' + (wrong.length ? ' (run node tools/msfs/package.js): ' + wrong.map(w => w.path) : ''));
  const html = fs.readFileSync(path.join(PKG, 'html_ui', 'InGamePanels', 'AirwavePilot', 'AirwavePilot.html'), 'utf8');
  check(html.includes('panel-id="PANEL_AIRWAVE_PILOT"') && fs.existsSync(path.join(PKG, 'html_ui', 'Textures', 'Menu', 'toolbar', 'ICON_TOOLBAR_AIRWAVE.svg')), 'panel page and toolbar icon match the SPB names');
}

// --- X-Plane panel packet
{
  const lines = panelLines({ net: 'online', callsign: 'AEE602', netText: 'ok', freq: '126.575', station: 'Athinai Approach', squawk: '4521',
    instr: { id: 3, readBack: false, from: 'LGAV_APP', text: 'AEE602, contact | tower', kind: 'contact', freq: '118.675' },
    atc: [{ id: 'LGAV_TWR', freq: '118.675', name: 'Tower' }], msgs: [{ from: 'X', text: 'line\nbreak', mine: true }] });
  check(lines[2] === 'I|3|0|LGAV_APP|AEE602, contact   tower|118.675', 'instruction line, with separators removed from the text');
  check(lines.every(l => !/[\r\n]/.test(l)) && lines.includes('M|X|line break|1'), 'no line breaks inside fields');
}

(async () => {
  // Round trip between Airwave Pilot's X-Plane adapter and a stand-in for the plugin.
  const plugin = dgram.createSocket('udp4');
  await new Promise(r => plugin.bind(0, '127.0.0.1', r));
  const xp = new XPlaneAdapter({ port: 1, pluginPort: plugin.address().port });
  const got = new Promise(resolve => plugin.once('message', (msg, rinfo) => resolve({ msg: msg.toString(), rinfo })));
  xp.start();
  await new Promise(r => setTimeout(r, 200));
  xp.panel({ net: 'online', callsign: 'AEE602', freq: '126.575', station: 'Athinai Approach', atc: [], msgs: [] });
  let first = await got;
  for (let i = 0; i < 5 && !first.msg.startsWith('AWPN'); i++) first = await new Promise(resolve => plugin.once('message', (msg, rinfo) => resolve({ msg: msg.toString(), rinfo })));
  check(first.msg.startsWith('AWPN\nN|online|AEE602'), 'panel contents reach the plugin');
  const cmds = [];
  xp.on('command', c => cmds.push(c));
  for (const c of ['AWCM readback', 'AWCM tune 118.675', 'AWCM tune 999', 'AWCM format c:']) plugin.send(c, first.rinfo.port, '127.0.0.1');
  await new Promise(r => setTimeout(r, 300));
  check(JSON.stringify(cmds) === JSON.stringify([{ t: 'readback' }, { t: 'tune', freq: '118.675' }]), 'panel buttons come back as commands, bad ones ignored');
  xp.stop(); plugin.close();

  // --- add-on installer with pretend simulator folders
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'airwave-addons-'));
  const env = { APPDATA: path.join(tmp, 'Roaming'), LOCALAPPDATA: path.join(tmp, 'Local'), HOME: path.join(tmp, 'home') };
  const msfs20 = path.join(tmp, 'MSFS2020'), msfs24 = path.join(tmp, 'MSFS2024'), xp12 = path.join(tmp, 'X-Plane 12');
  for (const d of [path.join(msfs20, 'Community'), path.join(msfs24, 'Community'), path.join(xp12, 'Resources', 'plugins'), path.join(env.APPDATA, 'Microsoft Flight Simulator'),
    path.join(env.LOCALAPPDATA, 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe', 'LocalCache')]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(env.APPDATA, 'Microsoft Flight Simulator', 'UserCfg.opt'), 'Version 1\r\nInstalledPackagesPath "' + msfs20 + '"\r\n');
  fs.writeFileSync(path.join(env.LOCALAPPDATA, 'Packages', 'Microsoft.Limitless_8wekyb3d8bbwe', 'LocalCache', 'UserCfg.opt'), 'InstalledPackagesPath "' + msfs24 + '"\n');
  fs.writeFileSync(path.join(env.LOCALAPPDATA, 'x-plane_install_12.txt'), xp12 + '\r\n/does/not/exist\r\n');
  const fakePlugin = path.join(tmp, 'plugin', 'Airwave');
  fs.mkdirSync(path.join(fakePlugin, 'win_x64'), { recursive: true }); fs.writeFileSync(path.join(fakePlugin, 'win_x64', 'Airwave.xpl'), 'xpl');
  fs.mkdirSync(path.join(fakePlugin, 'Resources'), { recursive: true }); fs.writeFileSync(path.join(fakePlugin, 'Resources', 'Doc8643.txt'), 'doc');

  const rep = installAddons({ env, xpPlugin: fakePlugin });
  check(rep.filter(r => r.ok).length === 3, 'installs into MSFS 2020 (Steam), MSFS 2024 (Store) and X-Plane 12: ' + rep.map(r => r.sim + (r.ok ? ' ok' : ' ' + r.text)).join(', '));
  check(fs.existsSync(path.join(msfs24, 'Community', 'airwave-pilot-panel', 'InGamePanels', 'airwave-pilot-panel.spb')), 'MSFS 2024 Community folder has the panel');
  const csl = path.join(xp12, 'Resources', 'plugins', 'Airwave', 'Resources', 'CSL', 'Bluebell');
  fs.mkdirSync(csl, { recursive: true }); fs.writeFileSync(path.join(csl, 'xsb_aircraft.txt'), 'models');
  installAddons({ env, xpPlugin: fakePlugin });
  check(fs.existsSync(path.join(csl, 'xsb_aircraft.txt')), 'updating keeps CSL models');
  installAddons({ env, uninstall: true, xpPlugin: fakePlugin });
  check(!fs.existsSync(path.join(msfs20, 'Community', 'airwave-pilot-panel')) && !fs.existsSync(path.join(xp12, 'Resources', 'plugins', 'Airwave', 'win_x64')), 'uninstall removes the panel and plugin');
  check(fs.existsSync(path.join(csl, 'xsb_aircraft.txt')), 'uninstall keeps CSL models');
  const none = installAddons({ env: { APPDATA: '/nope', LOCALAPPDATA: '/nope', HOME: '/nope' } });
  check(none.every(r => r.ok === null), 'nothing found is reported, not treated as an error');
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(failed ? failed + ' check(s) failed' : 'All checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
