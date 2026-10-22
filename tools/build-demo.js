#!/usr/bin/env node
// Builds a single self-contained scope page (core and the Greek map inlined) for sharing as a demo.
'use strict';
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'atc-client', 'scope.html'), 'utf8');
const core = fs.readFileSync(path.join(root, 'shared', 'airwave-core.js'), 'utf8');
const greece = fs.readFileSync(path.join(root, 'data', 'greece.json'), 'utf8').replace(/<\//g, '<\\/');
const tag = '<script src="/shared/airwave-core.js"></script>';
if (!page.includes(tag)) throw new Error('Core script tag not found in scope.html');
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'airwave-scope-demo.html');
// AIRWAVE_DEFAULT_SERVER (e.g. wss://airwave.onrender.com/ws) pre-fills the server address in the hosted copy.
const def = process.env.AIRWAVE_DEFAULT_SERVER ? 'window.AIRWAVE_DEFAULT_SERVER = ' + JSON.stringify(process.env.AIRWAVE_DEFAULT_SERVER) + ';\n' : '';
const voiceTag = '<script src="/shared/airwave-voice.js"></script>';
const voice = fs.readFileSync(path.join(root, 'shared', 'airwave-voice.js'), 'utf8');
fs.writeFileSync(out, page.replace(tag, () => '<script>\n' + def + core + '\nAirwave.registerMap(' + greece + ');\n</script>').replace(voiceTag, () => '<script>\n' + voice + '\n</script>'));
console.log('Wrote ' + out + ' (' + Math.round(fs.statSync(out).size / 1024) + ' KB)');

// A complete page for static hosting (GitHub Pages): dist/site/index.html
const site = path.join(root, 'dist', 'site');
fs.mkdirSync(site, { recursive: true });
fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + fs.readFileSync(out, 'utf8') + '</body></html>');
fs.writeFileSync(path.join(site, '.nojekyll'), '');
console.log('Wrote ' + path.join(site, 'index.html'));
