/**
 * Authentication: password hashing, session tokens, password-reset tokens.
 *
 * Passwords are hashed with scrypt (memory-hard, in Node core). The stored
 * format is self-describing so the cost parameters can be raised later without
 * invalidating existing hashes:
 *
 *     scrypt$N$r$p$<salt-base64url>$<hash-base64url>
 *
 * Session tokens are random 32-byte values. Only their SHA-256 hash is stored,
 * so a database leak does not hand an attacker usable sessions.
 */
import crypto from 'node:crypto';
import config from '../config.js';
import { get, run, nowIso } from '../db/index.js';
import { unauthorized, forbidden } from './errors.js';
import { parseCookies, clientIp } from './http.js';

const KEY_LENGTH = 64;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
export const SESSION_COOKIE = 'gft_session';

// ------------------------------------------------------------- passwords ---

export function hashPassword(password, cost = config.security.scryptCost) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH, {
    N: cost,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * 1024 * 1024,
  });
  return `scrypt$${cost}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * Burns roughly the same CPU as a real verification. Called when the email is
 * unknown so response timing does not reveal which addresses are registered.
 */
export function dummyPasswordWork() {
  const salt = Buffer.alloc(16, 7);
  crypto.scryptSync('timing-equaliser', salt, KEY_LENGTH, {
    N: config.security.scryptCost,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * 1024 * 1024,
  });
}

// ---------------------------------------------------------------- tokens ---

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/** Keyed hash used for device keys and biometric credential bindings. */
export const hmac = (value, key = config.security.appSecret) =>
  crypto.createHmac('sha256', key).update(String(value)).digest('hex');

export function safeEquals(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Human-friendly challenge code. Excludes 0/O/1/I to avoid misreads on an LCD. */
export function friendlyCode(length = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// -------------------------------------------------------------- sessions ---

function expiryIso(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Creates a session row and returns the raw bearer token (shown once).
 * `authMethod` distinguishes a password login from a biometric one -- biometric
 * sessions get a shorter lifetime because a shared kiosk is a weaker context.
 */
export function createSession(userId, { authMethod = 'password', deviceId = null, ip = null, userAgent = null } = {}) {
  const token = randomToken(32);
  const ttl =
    authMethod === 'biometric'
      ? config.security.biometricSessionTtlMinutes
      : config.security.sessionTtlMinutes;

  run(
    `INSERT INTO sessions (token_hash, user_id, auth_method, device_id, ip, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    sha256(token),
    userId,
    authMethod,
    deviceId,
    ip,
    userAgent ? String(userAgent).slice(0, 300) : null,
    expiryIso(ttl)
  );

  return { token, expiresAt: expiryIso(ttl), ttlMinutes: ttl };
}

export function revokeSession(token) {
  if (!token) return;
  run(
    `UPDATE sessions SET revoked_at = datetime('now') WHERE token_hash = ? AND revoked_at IS NULL`,
    sha256(token)
  );
}

export function revokeAllSessionsForUser(userId, exceptToken = null) {
  if (exceptToken) {
    run(
      `UPDATE sessions SET revoked_at = datetime('now')
       WHERE user_id = ? AND revoked_at IS NULL AND token_hash <> ?`,
      userId,
      sha256(exceptToken)
    );
  } else {
    run(
      `UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`,
      userId
    );
  }
}

/** Resolves a raw token to `{ user, session }`, or null when invalid/expired. */
export function resolveSession(token) {
  if (!token) return null;
  const row = get(
    `SELECT s.id AS session_id, s.auth_method, s.device_id, s.expires_at, s.created_at AS session_created,
            u.id, u.public_id, u.email, u.display_name, u.role, u.status, u.self_person_id
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?
       AND s.revoked_at IS NULL
       AND s.expires_at > datetime('now')`,
    sha256(token)
  );
  if (!row) return null;
  if (row.status !== 'active') return null;

  run(`UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?`, row.session_id);

  return {
    user: {
      id: row.id,
      publicId: row.public_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      selfPersonId: row.self_person_id,
    },
    session: {
      id: row.session_id,
      authMethod: row.auth_method,
      deviceId: row.device_id,
      expiresAt: row.expires_at,
      createdAt: row.session_created,
    },
  };
}

/** Pulls the bearer token from the Authorization header or the session cookie. */
export function tokenFromRequest(req) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7).trim();
  return parseCookies(req)[SESSION_COOKIE] ?? null;
}

/** Attaches `ctx.user`/`ctx.session`; throws 401 when no valid session exists. */
export function requireAuth(ctx) {
  if (ctx.user) return ctx.user;
  throw unauthorized('Please sign in to continue.');
}

export function requireRole(ctx, ...roles) {
  requireAuth(ctx);
  if (!roles.includes(ctx.user.role)) throw forbidden('This action needs a higher access level.');
  return ctx.user;
}

/** Populates auth context for a request. Never throws -- routes decide. */
export function buildAuthContext(req) {
  const token = tokenFromRequest(req);
  const resolved = resolveSession(token);
  return {
    token,
    user: resolved?.user ?? null,
    session: resolved?.session ?? null,
    ip: clientIp(req),
  };
}

// -------------------------------------------------------- password resets ---

export function createPasswordReset(userId, ip) {
  const token = randomToken(32);
  run(
    `INSERT INTO password_resets (token_hash, user_id, expires_at, requested_ip)
     VALUES (?, ?, ?, ?)`,
    sha256(token),
    userId,
    expiryIso(config.security.resetTtlMinutes),
    ip
  );
  return token;
}

export function consumePasswordReset(token) {
  const row = get(
    `SELECT id, user_id FROM password_resets
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`,
    sha256(token)
  );
  if (!row) return null;
  run(`UPDATE password_resets SET used_at = datetime('now') WHERE id = ?`, row.id);
  return row.user_id;
}

// ---------------------------------------------------------- housekeeping ---

/** Deletes expired sessions, used resets, stale challenges and old nonces. */
export function purgeExpired() {
  run(`DELETE FROM sessions WHERE expires_at < datetime('now', '-7 days')`);
  run(`DELETE FROM password_resets WHERE expires_at < datetime('now', '-1 day')`);
  run(
    `UPDATE biometric_challenges SET status = 'expired'
     WHERE status IN ('pending','claimed','fulfilled') AND expires_at < datetime('now')`
  );
  run(`DELETE FROM biometric_challenges WHERE expires_at < datetime('now', '-1 day')`);
  run(`DELETE FROM device_nonces WHERE seen_at < datetime('now', '-1 hour')`);
  return nowIso();
}
