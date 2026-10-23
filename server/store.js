'use strict';
/*
 * Airwave member store: members, sign-in sessions, connection keys, the flight/ATC logbook and an audit trail.
 * PgStore uses Postgres (DATABASE_URL, e.g. a free Neon database). MemoryStore keeps the same data in memory
 * for local testing (everything is lost on restart).
 *
 * Secrets (web session tokens and connection keys) are stored only as SHA-256 hashes.
 */
const crypto = require('crypto');

const ATC_RATINGS = ['OBS', 'S1', 'S2', 'S3', 'C1', 'I1'];            // 0..5
const ROLES = ['member', 'mentor', 'supervisor', 'admin'];
// Rating needed for each position type.
const NEEDS = { DEL: 1, GND: 1, TWR: 2, F_APP: 3, DEP: 3, APP: 3, CTR: 4 };
const hash = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = (n = 32) => crypto.randomBytes(n).toString('base64url');
const SESSION_DAYS = 30;

function publicMember(m) {
  if (!m) return null;
  return { id: m.id, name: m.name, avatar: m.avatar || null, atcRating: m.atc_rating, rating: ATC_RATINGS[m.atc_rating] || 'OBS', role: m.role,
    bannedUntil: m.banned_until || null, banReason: m.ban_reason || null, created: m.created, lastSeen: m.last_seen || null, discordId: m.discord_id };
}
const isBanned = m => !!(m && m.banned_until && new Date(m.banned_until) > new Date());

// ------------------------------------------------------------------ memory (local testing)
class MemoryStore {
  constructor() { this.members = []; this.sessions = new Map(); this.log = []; this.audits = []; this.nextId = 100001; this.kind = 'memory'; }
  async init() {}
  async close() {}
  async memberCount() { return this.members.length; }
  async memberByDiscord(id) { return this.members.find(m => m.discord_id === String(id)) || null; }
  async memberById(id) { return this.members.find(m => m.id === Number(id)) || null; }
  async createMember({ discordId, name, avatar, role = 'member', atcRating = 0 }) {
    const m = { id: this.nextId++, discord_id: String(discordId), name, avatar: avatar || null, atc_rating: atcRating, role, key_hash: null, banned_until: null, ban_reason: null, created: new Date().toISOString(), last_seen: null };
    this.members.push(m); return m;
  }
  async updateMember(id, f) { const m = await this.memberById(id); if (m) Object.assign(m, f); return m; }
  async listMembers({ q = '', limit = 50, offset = 0 } = {}) {
    const s = q.toLowerCase();
    const list = this.members.filter(m => !s || m.name.toLowerCase().includes(s) || String(m.id) === s).sort((a, b) => a.id - b.id);
    return { total: list.length, members: list.slice(offset, offset + limit) };
  }
  async createWebSession(memberId) { const t = token(); this.sessions.set(hash(t), { memberId, expires: Date.now() + SESSION_DAYS * 864e5 }); return t; }
  async memberBySession(t) { const s = this.sessions.get(hash(t)); if (!s || s.expires < Date.now()) return null; return this.memberById(s.memberId); }
  async deleteWebSession(t) { this.sessions.delete(hash(t)); }
  async newKey(memberId) { const k = 'aw_' + token(24); await this.updateMember(memberId, { key_hash: hash(k) }); return k; }
  async memberByKey(k) { const h = hash(k); return this.members.find(m => m.key_hash === h) || null; }
  async logSession(e) { this.log.push(Object.assign({ id: this.log.length + 1 }, e)); }
  async sessionsFor(memberId, limit = 30) { return this.log.filter(e => e.member_id === memberId).sort((a, b) => b.started - a.started).slice(0, limit); }
  async statsFor(memberId) {
    const mine = this.log.filter(e => e.member_id === memberId);
    const sum = k => mine.filter(e => e.kind === k).reduce((s, e) => s + e.minutes, 0);
    return { pilotMinutes: sum('pilot'), atcMinutes: sum('atc'), flights: mine.filter(e => e.kind === 'pilot').length, atcSessions: mine.filter(e => e.kind === 'atc').length };
  }
  async audit(actor, action, target, details) { this.audits.push({ at: new Date().toISOString(), actor, action, target, details }); }
  async recentAudits(limit = 50) { return this.audits.slice(-limit).reverse(); }
}

// ------------------------------------------------------------------ Postgres
const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  id SERIAL PRIMARY KEY, discord_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, avatar TEXT,
  atc_rating INT NOT NULL DEFAULT 0, role TEXT NOT NULL DEFAULT 'member', key_hash TEXT UNIQUE,
  banned_until TIMESTAMPTZ, ban_reason TEXT, created TIMESTAMPTZ NOT NULL DEFAULT now(), last_seen TIMESTAMPTZ);
DO $$ BEGIN IF (SELECT last_value FROM members_id_seq) < 100001 AND NOT EXISTS (SELECT 1 FROM members) THEN PERFORM setval('members_id_seq', 100001, false); END IF; END $$;
CREATE TABLE IF NOT EXISTS web_sessions (token_hash TEXT PRIMARY KEY, member_id INT NOT NULL REFERENCES members(id) ON DELETE CASCADE, expires TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS logbook (
  id SERIAL PRIMARY KEY, member_id INT NOT NULL REFERENCES members(id) ON DELETE CASCADE, kind TEXT NOT NULL, callsign TEXT, position TEXT,
  aircraft TEXT, dep TEXT, arr TEXT, started TIMESTAMPTZ NOT NULL, ended TIMESTAMPTZ NOT NULL, minutes INT NOT NULL);
CREATE INDEX IF NOT EXISTS logbook_member ON logbook(member_id, started DESC);
CREATE TABLE IF NOT EXISTS audit (id SERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), actor INT, action TEXT NOT NULL, target INT, details TEXT);
`;
class PgStore {
  constructor(url) {
    const { Pool } = require('pg');
    // Neon and most hosted Postgres need TLS; local test databases don't.
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || /host=\/|%2F/.test(url);
    this.pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: true }, max: 5, idleTimeoutMillis: 30000 });
    this.kind = 'postgres';
  }
  q(text, params) { return this.pool.query(text, params); }
  async one(text, params) { return (await this.q(text, params)).rows[0] || null; }
  async init() { await this.q(SCHEMA); await this.q('DELETE FROM web_sessions WHERE expires < now()'); }
  async close() { await this.pool.end(); }
  async memberCount() { return Number((await this.one('SELECT count(*) AS n FROM members')).n); }
  memberByDiscord(id) { return this.one('SELECT * FROM members WHERE discord_id = $1', [String(id)]); }
  memberById(id) { return this.one('SELECT * FROM members WHERE id = $1', [Number(id)]); }
  createMember({ discordId, name, avatar, role = 'member', atcRating = 0 }) {
    return this.one('INSERT INTO members (discord_id, name, avatar, role, atc_rating) VALUES ($1, $2, $3, $4, $5) RETURNING *', [String(discordId), name, avatar || null, role, atcRating]);
  }
  async updateMember(id, f) {
    const cols = Object.keys(f).filter(k => ['name', 'avatar', 'atc_rating', 'role', 'key_hash', 'banned_until', 'ban_reason', 'last_seen'].includes(k));
    if (!cols.length) return this.memberById(id);
    return this.one('UPDATE members SET ' + cols.map((c, i) => c + ' = $' + (i + 2)).join(', ') + ' WHERE id = $1 RETURNING *', [Number(id)].concat(cols.map(c => f[c])));
  }
  async listMembers({ q = '', limit = 50, offset = 0 } = {}) {
    const where = q ? 'WHERE name ILIKE $3 OR id::text = $4' : '';
    const params = [limit, offset].concat(q ? ['%' + q + '%', q] : []);
    const rows = (await this.q('SELECT * FROM members ' + where + ' ORDER BY id LIMIT $1 OFFSET $2', params)).rows;
    const total = Number((await this.one('SELECT count(*) AS n FROM members ' + where.replace('$3', '$1').replace('$4', '$2'), q ? ['%' + q + '%', q] : [])).n);
    return { total, members: rows };
  }
  async createWebSession(memberId) { const t = token(); await this.q("INSERT INTO web_sessions VALUES ($1, $2, now() + interval '" + SESSION_DAYS + " days')", [hash(t), memberId]); return t; }
  memberBySession(t) { return this.one('SELECT m.* FROM web_sessions s JOIN members m ON m.id = s.member_id WHERE s.token_hash = $1 AND s.expires > now()', [hash(t)]); }
  async deleteWebSession(t) { await this.q('DELETE FROM web_sessions WHERE token_hash = $1', [hash(t)]); }
  async newKey(memberId) { const k = 'aw_' + token(24); await this.updateMember(memberId, { key_hash: hash(k) }); return k; }
  memberByKey(k) { return this.one('SELECT * FROM members WHERE key_hash = $1', [hash(k)]); }
  async logSession(e) {
    await this.q('INSERT INTO logbook (member_id, kind, callsign, position, aircraft, dep, arr, started, ended, minutes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [e.member_id, e.kind, e.callsign, e.position || null, e.aircraft || null, e.dep || null, e.arr || null, new Date(e.started), new Date(e.ended), e.minutes]);
  }
  async sessionsFor(memberId, limit = 30) { return (await this.q('SELECT * FROM logbook WHERE member_id = $1 ORDER BY started DESC LIMIT $2', [memberId, limit])).rows; }
  async statsFor(memberId) {
    const r = await this.one(`SELECT coalesce(sum(minutes) FILTER (WHERE kind = 'pilot'), 0) AS p, coalesce(sum(minutes) FILTER (WHERE kind = 'atc'), 0) AS a,
      count(*) FILTER (WHERE kind = 'pilot') AS f, count(*) FILTER (WHERE kind = 'atc') AS s FROM logbook WHERE member_id = $1`, [memberId]);
    return { pilotMinutes: Number(r.p), atcMinutes: Number(r.a), flights: Number(r.f), atcSessions: Number(r.s) };
  }
  async audit(actor, action, target, details) { await this.q('INSERT INTO audit (actor, action, target, details) VALUES ($1, $2, $3, $4)', [actor, action, target, details]); }
  async recentAudits(limit = 50) { return (await this.q('SELECT * FROM audit ORDER BY id DESC LIMIT $1', [limit])).rows; }
}

module.exports = { MemoryStore, PgStore, ATC_RATINGS, ROLES, NEEDS, publicMember, isBanned, hash, token };
