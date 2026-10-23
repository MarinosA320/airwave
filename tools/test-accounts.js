#!/usr/bin/env node
// Member accounts end to end: sign-in (test login instead of Discord), first member is admin, Airwave Pilot keys,
// rating checks for ATC positions, admin changes, kick, ban, logbook, live map data, and request checks.
// Uses Postgres when TEST_DATABASE_URL is set, otherwise the in-memory store.
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

let failed = 0;
const check = (ok, label) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); if (!ok) failed++; };
const PORT = 19000 + Math.floor(Math.random() * 900);
const BASE = 'http://127.0.0.1:' + PORT;
const env = Object.assign({}, process.env, { PORT: String(PORT), AIRWAVE_MAP: 'greece', AIRWAVE_BOTS: '3', AIRWAVE_DEV_LOGIN: '1', AIRWAVE_METAR: 'off',
  AIRWAVE_LOG_MIN_MINUTES: '0', DATABASE_URL: process.env.TEST_DATABASE_URL || '', DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: '', AIRWAVE_ATC_PASSWORD: 'old-atc-pw' });
const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; srv.stdout.on('data', d => { out += d; }); srv.stderr.on('data', d => { out += d; });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function signIn(name, id, extra) {
  const r = await fetch(BASE + '/auth/dev?' + new URLSearchParams(Object.assign({ name, id }, extra || {})), { redirect: 'manual' });
  return { cookie: (r.headers.get('set-cookie') || '').split(';')[0], location: r.headers.get('location') || '' };
}
const api = (p, cookie, opts) => fetch(BASE + p, Object.assign({ headers: Object.assign({ cookie: cookie || '' }, (opts && opts.headers) || {}) }, opts || {}, { headers: Object.assign({ cookie: cookie || '', 'content-type': 'application/json' }, (opts && opts.headers) || {}) })).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
function connect(hello, cookie) {
  return new Promise(resolve => {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws', { headers: cookie ? { cookie } : {} });
    const msgs = [];
    ws.on('message', d => { const m = JSON.parse(d); msgs.push(m); if (m.t === 'welcome' || m.t === 'error') resolve({ ws, msgs, first: m }); });
    ws.on('open', () => ws.send(JSON.stringify(hello)));
    ws.on('error', () => resolve({ ws, msgs, first: { t: 'error', text: 'socket error' } }));
  });
}

(async () => {
  for (let i = 0; i < 80 && !/running/.test(out); i++) await sleep(100);
  await sleep(300);
  const me0 = await api('/api/me');
  check(me0.body.accounts === true && me0.body.member === null, 'accounts are on, not signed in (' + me0.body.storage + ' store)');

  const admin = await signIn('Marinos', '1');
  check(/^aw_sess=/.test(admin.cookie) && admin.location === '/me', 'test sign-in sets a session cookie');
  const meA = await api('/api/me', admin.cookie);
  check(meA.body.member && meA.body.member.role === 'admin' && meA.body.member.rating === 'I1', 'first member becomes admin with instructor rating (ID ' + (meA.body.member && meA.body.member.id) + ')');

  const bobLink = await signIn('Bob', '2', { next: 'pilot', port: '8090' });
  const key = new URLSearchParams(bobLink.location.split('#')[1] || '').get('key');
  check(/^http:\/\/localhost:8090\/linked#/.test(bobLink.location) && /^aw_/.test(key || ''), 'signing in from Airwave Pilot hands a key back to localhost');
  const bobId = Number(new URLSearchParams(bobLink.location.split('#')[1]).get('id'));
  const meB = await api('/api/me', bobLink.cookie);
  check(meB.body.member.role === 'member' && meB.body.member.rating === 'OBS', 'second member is a plain member with OBS');

  // Controllers need a rating; the old ATC password no longer applies.
  const guestAtc = await connect({ t: 'hello', role: 'atc', callsign: 'LGAV_TWR', facility: 'LGAV_TWR', password: 'old-atc-pw' });
  check(guestAtc.first.t === 'error' && /Sign in to control/.test(guestAtc.first.text), 'guests cannot control: ' + guestAtc.first.text);
  guestAtc.ws.close();
  const bobAtc = await connect({ t: 'hello', role: 'atc', callsign: 'LGAV_TWR', facility: 'LGAV_TWR', key });
  check(bobAtc.first.t === 'error' && /needs the S2 rating; you have OBS/.test(bobAtc.first.text), 'rating too low is refused: ' + bobAtc.first.text);
  bobAtc.ws.close();
  const badKey = await connect({ t: 'hello', role: 'pilot', callsign: 'XXX1', aircraft: 'A20N', key: 'aw_notavalidkeyatallxxxxxxxx' });
  check(badKey.first.t === 'error' && /no longer valid/.test(badKey.first.text), 'an unknown key is refused');
  badKey.ws.close();

  // Admin gives Bob S2, then Bob can staff tower.
  const notStaff = await api('/api/admin/member', bobLink.cookie, { method: 'POST', body: JSON.stringify({ id: bobId, atcRating: 5 }) });
  check(notStaff.status === 403, 'members cannot use admin tools');
  const evil = await api('/api/admin/member', admin.cookie, { method: 'POST', body: JSON.stringify({ id: bobId, atcRating: 5 }), headers: { origin: 'https://evil.example' } });
  check(evil.status === 405, 'admin changes from another website are refused');
  const give = await api('/api/admin/member', admin.cookie, { method: 'POST', body: JSON.stringify({ id: bobId, atcRating: 2 }) });
  check(give.status === 200 && give.body.member.rating === 'S2', 'admin gives S2');
  const bobTwr = await connect({ t: 'hello', role: 'atc', callsign: 'LGAV_TWR', facility: 'LGAV_TWR', key });
  check(bobTwr.first.t === 'welcome', 'with S2 Bob can log on as LGAV_TWR');
  const bobApp = await connect({ t: 'hello', role: 'atc', callsign: 'LGAV_APP', facility: 'LGAV_APP', key });
  check(bobApp.first.t === 'error' && /needs the S3/.test(bobApp.first.text), 'but not approach (S3)');
  bobApp.ws.close();
  const online = await api('/api/online');
  check(online.body.atc.some(c => c.cs === 'LGAV_TWR' && c.member && c.member.name === 'Bob' && c.member.rating === 'S2'), 'live map data shows the controller and rating');
  check(online.body.counts.simulated === 3, 'live map data counts simulated traffic');
  await sleep(200);
  bobTwr.ws.close();
  await sleep(400);
  const log = await api('/api/me', bobLink.cookie);
  check(log.body.logbook.some(e => e.kind === 'atc' && e.position === 'LGAV_TWR'), 'the ATC session is in Bob\'s logbook');

  // Pilot with a key, supervisor tools.
  const bobPilot = await connect({ t: 'hello', role: 'pilot', callsign: 'AEE602', aircraft: 'A20N', key });
  check(bobPilot.first.t === 'welcome', 'Bob flies with his key');
  bobPilot.ws.send(JSON.stringify({ t: 'fp', dep: 'LGAV', arr: 'LGTS', route: 'KEA', cruise: 24000 }));
  const sup = await connect({ t: 'hello', role: 'atc', callsign: 'LGGG_CTR', facility: 'LGGG_CTR' }, admin.cookie);
  check(sup.first.t === 'welcome', 'the admin logs on as LGGG_CTR from the scope (browser cookie)');
  const kicked = new Promise(r => bobPilot.ws.on('message', d => { const m = JSON.parse(d); if (m.kicked) r(m); }));
  sup.ws.send(JSON.stringify({ t: 'kick', callsign: 'AEE602', reason: 'testing' }));
  const k = await Promise.race([kicked, sleep(2000).then(() => null)]);
  check(k && /disconnected by a supervisor \(LGGG_CTR\): testing/.test(k.text), 'a supervisor can disconnect a pilot');
  const plainKick = await connect({ t: 'hello', role: 'pilot', callsign: 'GUEST1', aircraft: 'A20N' });
  check(plainKick.first.t === 'welcome', 'guests can still fly (login not required for pilots)');
  const kickErr = new Promise(r => plainKick.ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'error') r(m); }));
  plainKick.ws.send(JSON.stringify({ t: 'kick', callsign: 'LGGG_CTR', reason: 'x' }));
  check(/Only supervisors/.test(((await Promise.race([kickErr, sleep(1500)])) || {}).text || ''), 'only supervisors can disconnect people');
  plainKick.ws.close();

  // Ban
  const ban = await api('/api/admin/member', admin.cookie, { method: 'POST', body: JSON.stringify({ id: bobId, ban: { days: 1, reason: 'test ban' } }) });
  check(ban.status === 200 && ban.body.member.bannedUntil, 'admin bans Bob for a day');
  const banned = await connect({ t: 'hello', role: 'pilot', callsign: 'AEE603', aircraft: 'A20N', key });
  check(banned.first.t === 'error' && /banned .*test ban/.test(banned.first.text), 'a banned member cannot connect: ' + banned.first.text);
  banned.ws.close();
  const selfBan = await api('/api/admin/member', admin.cookie, { method: 'POST', body: JSON.stringify({ id: meA.body.member.id, ban: { days: 1, reason: 'x' } }) });
  check(selfBan.status === 400, 'admins cannot ban themselves');
  const unban = await api('/api/admin/member', admin.cookie, { method: 'POST', body: JSON.stringify({ id: bobId, unban: true }) });
  check(unban.status === 200 && !unban.body.member.bannedUntil, 'unban');
  const audit = await api('/api/admin/audit', admin.cookie);
  check(audit.body.audit.some(a => a.action === 'kick') && audit.body.audit.some(a => /banned 1 days/.test(a.details || '')), 'kicks and bans are in the audit trail');
  const list = await api('/api/admin/members?q=bob', admin.cookie);
  check(list.body.members.length === 1 && list.body.members[0].name === 'Bob', 'member search');
  const pages = await Promise.all(['/me', '/admin', '/map'].map(p => fetch(BASE + p).then(r => r.status)));
  check(pages.every(s => s === 200), 'member, admin and live map pages are served');

  sup.ws.close(); srv.kill();
  console.log(failed ? failed + ' check(s) failed' : 'All checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); console.error(out); srv.kill(); process.exit(1); });
