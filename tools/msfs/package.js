#!/usr/bin/env node
// Writes layout.json and the package size in manifest.json for the MSFS panel package (MSFS reads both).
// Run after changing any file in sim-addons/msfs/airwave-pilot-panel:  node tools/msfs/package.js
'use strict';
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', '..', 'sim-addons', 'msfs', 'airwave-pilot-panel');
const files = [];
(function walk(rel) {
  for (const e of fs.readdirSync(path.join(DIR, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) walk(r);
    else if (r !== 'layout.json' && r !== 'manifest.json') files.push(r);
  }
})('');
const FILETIME = BigInt(Date.UTC(2026, 9, 22)) * 10000n + 116444736000000000n; // fixed date keeps the output reproducible
const content = files.sort().map(r => ({ path: r, size: fs.statSync(path.join(DIR, r)).size, date: Number(FILETIME) }));
fs.writeFileSync(path.join(DIR, 'layout.json'), JSON.stringify({ content }, null, 2) + '\n');
const manifestFile = path.join(DIR, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
const total = content.reduce((s, c) => s + c.size, 0) + fs.statSync(path.join(DIR, 'layout.json')).size;
manifest.total_package_size = String(total).padStart(20, '0');
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');
console.log('layout.json: ' + content.length + ' files, ' + total + ' bytes');
