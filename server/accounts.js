'use strict';
/*
 * Airwave member accounts: "Sign in with Discord", member and admin pages, who may log on to what, and the logbook.
 *
 * Settings (environment):
 *   DATABASE_URL            Postgres connection string (Neon). Without it members are kept in memory (testing only).
 *   DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET   the Discord application used for sign-in
 *   PUBLIC_URL              this server's address, e.g. https://airwave-lwhv.onrender.com (for the Discord redirect)
 *   AIRWAVE_REQUIRE_LOGIN=1 pilots must sign in too (controllers always must, once accounts are on)
 *   AIRWAVE_DEV_LOGIN=1     enables /auth/dev for local testing without Discord. Never set this on a public server.
 *
 * Ratings: OBS, S1 (delivery, ground), S2 (+tower), S3 (+approach, departure), C1 (+area control), I1 (instructor).
 * Roles: member, mentor (can raise ratings up to S3), supervisor (kick, ban), admin (everything).
 * The first account created becomes admin.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MemoryStore, PgStore, ATC_RATINGS, ROLES, NEEDS, publicMember, isBanned, token } = require('./store');

const COOKIE = 'aw_sess';
const LOG_MIN_MINUTES = Number(process.env.AIRWAVE_LOG_MIN_MINUTES || 2);

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
const send = (res, code, body, headers) => { res.writeHead(code, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers || {})); res.end(JSON.stringify(body)); };
const redirect = (res, to, headers) => { res.writeHead(302, Object.assign({ location: to, 'cache-control': 'no-store' }, headers || {})); res.end(); };
function readJson(req, limit = 20000) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

class Accounts {
  constructor({ env = process.env, log = () => {}, hub = null } = {}) {
    this.log = log; this.hub = hub;
    this.discordId = env.DISCORD_CLIENT_ID || ''; this.discordSecret = env.DISCORD_CLIENT_SECRET || '';
    this.publicUrl = String(env.PUBLIC_URL || (env.RENDER_EXTERNAL_URL || '')).replace(/\/+$/, '');
    this.devLogin = env.AIRWAVE_DEV_LOGIN === '1';
    this.requireLogin = env.AIRWAVE_REQUIRE_LOGIN === '1';
    this.store = env.DATABASE_URL ? new PgStore(env.DATABASE_URL) : new MemoryStore();
    // Accounts are on when people can actually sign in.
    this.enabled = !!((this.discordId && this.discordSecret) || this.devLogin);
    this.states = new Map();   // OAuth state -> { next, port, exp }
    this.pages = path.join(__dirname, '..', 'web');
  }
  async init() {
    try { await this.store.init(); }
    catch (e) { this.log('Accounts: database unavailable (' + e.message + '); using memory until it is fixed'); this.store = new MemoryStore(); }
    this.log('Accounts: ' + (this.enabled ? 'on' : 'off (set DISCORD_CLIENT_ID and DISCORD_CLIENT_SECRET)') + ', members stored in ' + this.store.kind + (this.store.kind === 'memory' && this.enabled ? ' (lost on restart: set DATABASE_URL)' : ''));
  }
  secure() { return /^https:/.test(this.publicUrl); }
  cookie(tok, maxAge) { return COOKIE + '=' + encodeURIComponent(tok) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + (this.secure() ? '; Secure' : ''); }
  async memberFromReq(req) {
    const t = parseCookies(req.headers.cookie)[COOKIE];
    if (!t) return null;
    try { return await this.store.memberBySession(t); } catch (e) { return null; }
  }
  // The member shape sessions carry (also what the hub sees).
  sessionMember(m) { const p = publicMember(m); return p && { id: p.id, name: p.name, rating: p.rating, atcRating: p.atcRating, role: p.role, bannedUntil: p.bannedUntil, banReason: p.banReason }; }

  // ---------------------------------------------------------------- log-on rules (called by the hub, synchronously)
  policy(s, role, hello, fac) {
    const m = s.member;
    if (m && isBanned({ banned_until: m.bannedUntil })) return 'You are banned from Airwave until ' + new Date(m.bannedUntil).toISOString().slice(0, 16).replace('T', ' ') + 'Z' + (m.banReason ? ': ' + m.banReason : '') + '.';
    if (!this.enabled) return null;
    if (s.keyRejected) return 'Your Airwave sign-in is no longer valid. Sign in again (Airwave Pilot: Sign in with Discord).';
    if (role === 'atc') {
      if (!m) return 'Sign in to control: open the scope from the Airwave server and choose "Sign in with Discord".';
      const need = NEEDS[fac.kind] || 4;
      if (m.atcRating < need) return fac.id + ' needs the ' + ATC_RATINGS[need] + ' rating; you have ' + m.rating + '. Ask a mentor about training, or log on as observer.';
    }
    if (role === 'pilot' && this.requireLogin && !m) return 'Sign in to fly on this network: in Airwave Pilot choose "Sign in with Discord".';
    return null;
  }
  // Logbook: a pilot or controller session of two minutes or more.
  onEvent(type, s, extra) {
    if (type === 'join' && s.member) this.store.updateMember(s.member.id, { last_seen: new Date() }).catch(() => {});
    if (type === 'leave' && s.member && s.joinedAt) {
      const minutes = Math.round((Date.now() - s.joinedAt) / 60000);
      if (minutes >= LOG_MIN_MINUTES && (minutes > 0 || LOG_MIN_MINUTES === 0)) {
        this.store.logSession({ member_id: s.member.id, kind: s.role === 'atc' ? 'atc' : 'pilot', callsign: s.callsign, position: s.facility ? s.facility.id : null,
          aircraft: s.type || null, dep: s.fp && s.fp.dep, arr: s.fp && s.fp.arr, started: s.joinedAt, ended: Date.now(), minutes }).catch(e => this.log('Logbook: ' + e.message));
      }
      this.store.updateMember(s.member.id, { last_seen: new Date() }).catch(() => {});
    }
    if (type === 'kick' && extra && extra.by.member) this.store.audit(extra.by.member.id, 'kick', s.member ? s.member.id : null, s.callsign + ': ' + extra.reason).catch(() => {});
  }
  // Called before a connection's hello is handled: who is this? (browser cookie, or the key Airwave Pilot sends)
  async identify(session, req, hello) {
    let row = null;
    if (hello && typeof hello.key === 'string' && hello.key) {
      try { row = await this.store.memberByKey(hello.key); } catch (e) { row = null; }
      if (!row) session.keyRejected = true;
    } else row = await this.memberFromReq(req);
    session.member = this.sessionMember(row);
  }

  // ---------------------------------------------------------------- HTTP
  // Returns true when it handled the request.
  handle(req, res, url) {
    const p = url.pathname;
    const routes = {
      '/auth/discord': () => this.startDiscord(req, res, url),
      '/auth/discord/callback': () => this.discordCallback(req, res, url),
      '/auth/dev': () => this.devSignIn(req, res, url),
      '/auth/logout': () => this.logout(req, res),
      '/api/me': () => this.apiMe(req, res),
      '/api/me/key': () => this.apiKey(req, res),
      '/api/admin/members': () => this.apiMembers(req, res, url),
      '/api/admin/member': () => this.apiEditMember(req, res),
      '/api/admin/audit': () => this.apiAudit(req, res),
      '/me': () => this.page(res, 'me.html'),
      '/admin': () => this.page(res, 'admin.html')
    };
    const r = routes[p];
    if (!r) return false;
    Promise.resolve(r()).catch(e => { this.log('Accounts error on ' + p + ': ' + e.message); if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' }); });
    return true;
  }
  page(res, file) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    fs.createReadStream(path.join(this.pages, file)).pipe(res);
  }
  sameOrigin(req) {
    const o = req.headers.origin; if (!o) return true; // non-browser clients
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    try { return new URL(o).host === host; } catch (e) { return false; }
  }
  // next: where to go after signing in. "pilot" hands a connection key to Airwave Pilot on this computer (localhost:port).
  nextOf(url) {
    const next = url.searchParams.get('next') || '/me';
    const port = Number(url.searchParams.get('port')) || 8090;
    return { next: next === 'pilot' ? 'pilot' : /^\/[a-z]*$/.test(next) ? next : '/me', port: port >= 1024 && port <= 65535 ? port : 8090 };
  }
  startDiscord(req, res, url) {
    if (!this.discordId) return send(res, 503, { error: 'Discord sign-in is not set up on this server.' });
    const state = token(16);
    this.states.set(state, Object.assign(this.nextOf(url), { exp: Date.now() + 10 * 60000 }));
    for (const [k, v] of this.states) if (v.exp < Date.now()) this.states.delete(k);
    const q = new URLSearchParams({ client_id: this.discordId, redirect_uri: this.publicUrl + '/auth/discord/callback', response_type: 'code', scope: 'identify', state, prompt: 'none' });
    redirect(res, 'https://discord.com/oauth2/authorize?' + q);
  }
  async discordCallback(req, res, url) {
    const st = this.states.get(url.searchParams.get('state') || '');
    this.states.delete(url.searchParams.get('state') || '');
    if (!st || st.exp < Date.now()) return this.failPage(res, 'The sign-in took too long or came from somewhere else. Please try again.');
    if (url.searchParams.get('error')) return this.failPage(res, 'Discord sign-in was cancelled.');
    const tokRes = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.discordId, client_secret: this.discordSecret, grant_type: 'authorization_code', code: url.searchParams.get('code') || '', redirect_uri: this.publicUrl + '/auth/discord/callback' }) });
    if (!tokRes.ok) return this.failPage(res, 'Discord did not accept the sign-in (' + tokRes.status + '). Check DISCORD_CLIENT_SECRET and the redirect address.');
    const tok = await tokRes.json();
    const meRes = await fetch('https://discord.com/api/users/@me', { headers: { authorization: 'Bearer ' + tok.access_token } });
    if (!meRes.ok) return this.failPage(res, 'Could not read your Discord profile.');
    const u = await meRes.json();
    const avatar = u.avatar ? 'https://cdn.discordapp.com/avatars/' + u.id + '/' + u.avatar + '.png?size=64' : null;
    return this.signedIn(res, { discordId: u.id, name: u.global_name || u.username || 'Pilot', avatar }, st);
  }
  async devSignIn(req, res, url) {
    if (!this.devLogin) return send(res, 404, { error: 'Not found' });
    return this.signedIn(res, { discordId: 'dev-' + (url.searchParams.get('id') || '1'), name: url.searchParams.get('name') || 'Dev user', avatar: null }, this.nextOf(url));
  }
  async signedIn(res, who, st) {
    let m = await this.store.memberByDiscord(who.discordId);
    if (!m) {
      const first = (await this.store.memberCount()) === 0;
      m = await this.store.createMember({ discordId: who.discordId, name: who.name.slice(0, 40), avatar: who.avatar, role: first ? 'admin' : 'member', atcRating: first ? 5 : 0 });
      this.log('Accounts: new member ' + m.id + ' ' + m.name + (first ? ' (first account: admin)' : ''));
      await this.store.audit(m.id, 'joined', m.id, first ? 'first account, made admin' : '');
    } else if (m.name !== who.name || m.avatar !== who.avatar) m = await this.store.updateMember(m.id, { name: who.name.slice(0, 40), avatar: who.avatar });
    if (isBanned(m)) return this.failPage(res, 'Your account is banned until ' + new Date(m.banned_until).toISOString().slice(0, 16).replace('T', ' ') + 'Z' + (m.ban_reason ? ': ' + m.ban_reason : '') + '.');
    const sess = await this.store.createWebSession(m.id);
    const cookie = this.cookie(sess, 30 * 86400);
    if (st.next === 'pilot') {
      // Hand a fresh connection key to Airwave Pilot running on this computer. The fragment never reaches a server.
      const key = await this.store.newKey(m.id);
      return redirect(res, 'http://localhost:' + st.port + '/linked#' + new URLSearchParams({ key, id: String(m.id), name: m.name, rating: ATC_RATINGS[m.atc_rating] }), { 'set-cookie': cookie });
    }
    redirect(res, st.next || '/me', { 'set-cookie': cookie });
  }
  failPage(res, text) {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Airwave sign-in</title>' +
      '<body style="background:#0b1215;color:#d6e2e5;font-family:system-ui,sans-serif;padding:40px;max-width:560px;margin:auto"><h1 style="font-size:20px;letter-spacing:.14em">AIRWAVE</h1><p>' +
      text.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) + '</p><p><a style="color:#7fd4f0" href="/me">Try again</a></p></body>');
  }
  async logout(req, res) {
    const t = parseCookies(req.headers.cookie)[COOKIE];
    if (t) await this.store.deleteWebSession(t).catch(() => {});
    redirect(res, '/', { 'set-cookie': this.cookie('', 0) });
  }
  async apiMe(req, res) {
    const m = await this.memberFromReq(req);
    const base = { accounts: this.enabled, discord: !!this.discordId, dev: this.devLogin, storage: this.store.kind };
    if (!m) return send(res, 200, Object.assign(base, { member: null }));
    const [stats, log] = await Promise.all([this.store.statsFor(m.id), this.store.sessionsFor(m.id, 30)]);
    send(res, 200, Object.assign(base, { member: publicMember(m), stats, logbook: log, ratings: ATC_RATINGS, needs: NEEDS }));
  }
  async apiKey(req, res) {
    if (req.method !== 'POST' || !this.sameOrigin(req)) return send(res, 405, { error: 'Use POST from the Airwave site.' });
    const m = await this.memberFromReq(req); if (!m) return send(res, 401, { error: 'Sign in first.' });
    send(res, 200, { key: await this.store.newKey(m.id) });
  }
  // ---------------------------------------------------------------- admin
  async staff(req, res) {
    const m = await this.memberFromReq(req);
    if (!m || !['mentor', 'supervisor', 'admin'].includes(m.role)) { send(res, 403, { error: 'Staff only.' }); return null; }
    return m;
  }
  async apiMembers(req, res, url) {
    const me = await this.staff(req, res); if (!me) return;
    const r = await this.store.listMembers({ q: (url.searchParams.get('q') || '').slice(0, 40), limit: 50, offset: Math.max(0, Number(url.searchParams.get('offset')) || 0) });
    const online = new Map((this.hub ? [...this.hub.sessions.values()] : []).filter(s => s.member).map(s => [s.member.id, s.callsign]));
    send(res, 200, { total: r.total, members: r.members.map(m => Object.assign(publicMember(m), { online: online.get(m.id) || null })), me: publicMember(me), ratings: ATC_RATINGS, roles: ROLES });
  }
  async apiEditMember(req, res) {
    if (req.method !== 'POST' || !this.sameOrigin(req)) return send(res, 405, { error: 'Use POST from the Airwave site.' });
    const me = await this.staff(req, res); if (!me) return;
    let b; try { b = await readJson(req); } catch (e) { return send(res, 400, { error: 'Bad request.' }); }
    const t = await this.store.memberById(b.id); if (!t) return send(res, 404, { error: 'No such member.' });
    const isAdmin = me.role === 'admin', isSup = isAdmin || me.role === 'supervisor';
    const f = {}, notes = [];
    if (b.atcRating != null) {
      const r = Math.round(Number(b.atcRating));
      if (!(r >= 0 && r < ATC_RATINGS.length)) return send(res, 400, { error: 'Unknown rating.' });
      if (!isAdmin && (me.role !== 'mentor' || r > 3 || t.atc_rating > 3)) return send(res, 403, { error: 'Mentors can set ratings up to S3; higher needs an admin.' });
      f.atc_rating = r; notes.push('rating ' + ATC_RATINGS[t.atc_rating] + ' -> ' + ATC_RATINGS[r]);
    }
    if (b.role != null) {
      if (!isAdmin) return send(res, 403, { error: 'Only admins change roles.' });
      if (!ROLES.includes(b.role)) return send(res, 400, { error: 'Unknown role.' });
      if (t.id === me.id && b.role !== 'admin') return send(res, 400, { error: 'You cannot remove your own admin role.' });
      f.role = b.role; notes.push('role ' + t.role + ' -> ' + b.role);
    }
    if (b.ban) {
      if (!isSup) return send(res, 403, { error: 'Only supervisors and admins can ban.' });
      if (t.id === me.id) return send(res, 400, { error: 'You cannot ban yourself.' });
      if (t.role === 'admin' && !isAdmin) return send(res, 403, { error: 'Supervisors cannot ban admins.' });
      const days = Math.min(3650, Math.max(0.04, Number(b.ban.days) || 1));
      f.banned_until = new Date(Date.now() + days * 864e5); f.ban_reason = String(b.ban.reason || '').slice(0, 200);
      notes.push('banned ' + days + ' days: ' + f.ban_reason);
      if (this.hub) for (const s of this.hub.sessions.values()) if (s.member && s.member.id === t.id) { s.send({ t: 'error', text: 'You have been banned: ' + f.ban_reason, kicked: true }); s.close(); }
    }
    if (b.unban) { if (!isSup) return send(res, 403, { error: 'Only supervisors and admins can unban.' }); f.banned_until = null; f.ban_reason = null; notes.push('unbanned'); }
    if (!notes.length) return send(res, 400, { error: 'Nothing to change.' });
    const updated = await this.store.updateMember(t.id, f);
    await this.store.audit(me.id, 'edit', t.id, notes.join('; '));
    // Live sessions get the new rating/role straight away.
    if (this.hub) for (const s of this.hub.sessions.values()) if (s.member && s.member.id === t.id) s.member = this.sessionMember(updated);
    this.log('Accounts: ' + me.name + ' (' + me.id + ') changed ' + t.id + ': ' + notes.join('; '));
    send(res, 200, { member: publicMember(updated) });
  }
  async apiAudit(req, res) {
    const me = await this.staff(req, res); if (!me) return;
    send(res, 200, { audit: await this.store.recentAudits(100) });
  }
}

module.exports = { Accounts, parseCookies };
