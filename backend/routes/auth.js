/**
 * Authentication routes: registration, login, logout, password reset,
 * profile management and session listing.
 */
import { Router, setCookie, clearCookie } from '../lib/http.js';
import { validate, checkPasswordStrength } from '../lib/validate.js';
import {
  hashPassword, verifyPassword, dummyPasswordWork, createSession, revokeSession,
  revokeAllSessionsForUser, createPasswordReset, consumePasswordReset,
  SESSION_COOKIE,
} from '../lib/auth.js';
import { get, run, all, transaction, newPublicId } from '../db/index.js';
import { createPerson } from '../lib/person-service.js';
import { recordChange, logSecurity, notify } from '../lib/audit.js';
import { badRequest, unauthorized, conflict, notFound, forbidden } from '../lib/errors.js';
import { reset as resetRateLimit } from '../lib/ratelimit.js';
import config from '../config.js';
import { viewPerson } from '../lib/privacy.js';

const router = new Router();

/** Sets the session cookie and returns the client-facing session payload. */
function issueSession(ctx, user, { authMethod = 'password', deviceId = null } = {}) {
  const { token, expiresAt, ttlMinutes } = createSession(user.id, {
    authMethod,
    deviceId,
    ip: ctx.ip,
    userAgent: ctx.req.headers['user-agent'],
  });

  setCookie(ctx.res, SESSION_COOKIE, token, { maxAge: ttlMinutes * 60, sameSite: 'Lax' });
  run(`UPDATE users SET last_login_at = datetime('now'), failed_logins = 0, locked_until = NULL WHERE id = ?`, user.id);

  return { token, expiresAt, authMethod };
}

function publicUser(user, selfPerson = null) {
  return {
    id: user.public_id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    selfPerson: selfPerson ? { id: selfPerson.public_id, name: selfPerson.display_name } : null,
    createdAt: user.created_at,
    isSynthetic: user.is_synthetic === 1,
  };
}

// ------------------------------------------------------------- register ----

router.post('/register', async (ctx) => {
  const input = validate(ctx.body, {
    email: { type: 'email', required: true, label: 'Email' },
    password: { type: 'password', required: true, label: 'Password' },
    displayName: { type: 'string', required: true, maxLength: 100, minLength: 2, label: 'Name' },
    givenName: { type: 'string', maxLength: 80 },
    familyName: { type: 'string', maxLength: 80 },
    gender: { type: 'enum', values: ['male', 'female', 'other', 'unknown'], default: 'unknown' },
    birthDate: { type: 'date', notFuture: true },
    birthPlace: { type: 'string', maxLength: 200 },
  });

  const existing = get(`SELECT id FROM users WHERE email = ?`, input.email);
  if (existing) {
    logSecurity({ event: 'register_duplicate_email', ip: ctx.ip, detail: input.email });
    throw conflict('An account with that email already exists.');
  }

  const result = transaction(() => {
    const insert = run(
      `INSERT INTO users (public_id, email, password_hash, display_name)
       VALUES (?, ?, ?, ?)`,
      newPublicId(),
      input.email,
      hashPassword(input.password),
      input.displayName
    );
    const user = get(`SELECT * FROM users WHERE id = ?`, insert.lastInsertRowid);

    run(`INSERT INTO privacy_settings (user_id) VALUES (?)`, user.id);

    // A user account and the person they are in the graph are separate records.
    // The account owns the person; the person is a node other trees can link to.
    const nameParts = input.displayName.trim().split(/\s+/);
    const person = createPerson(
      {
        given_name: input.givenName || nameParts[0],
        family_name: input.familyName || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : null),
        gender: input.gender,
        birth_date: input.birthDate ?? null,
        birth_place: input.birthPlace ?? null,
        visibility: 'family',
      },
      { ownerUserId: user.id, actor: { id: user.id, displayName: user.display_name }, ip: ctx.ip,
        detail: 'Created automatically as the account holder’s own person record.' }
    );

    run(`UPDATE users SET self_person_id = ? WHERE id = ?`, person.id, user.id);

    recordChange({
      actorUserId: user.id,
      actorLabel: user.display_name,
      entityType: 'user',
      entityId: user.id,
      entityLabel: user.display_name,
      action: 'Account Created',
      ip: ctx.ip,
    });

    notify({
      userId: user.id,
      type: 'system',
      severity: 'success',
      title: 'Welcome to your family tree',
      body: 'Start by adding your parents, then expand outwards. Every relationship you add improves relationship discovery.',
      link: '#/people',
    });

    return { user: get(`SELECT * FROM users WHERE id = ?`, user.id), person };
  });

  logSecurity({ event: 'user_registered', ip: ctx.ip, userId: result.user.id });
  const session = issueSession(ctx, result.user);

  return { __status: 201, user: publicUser(result.user, result.person), session };
});

// ---------------------------------------------------------------- login ----

router.post('/login', async (ctx) => {
  const input = validate(ctx.body, {
    email: { type: 'email', required: true, label: 'Email' },
    // Deliberately NOT type 'password': policy is checked at registration, and
    // applying it here would reject valid legacy passwords with a hint.
    password: { type: 'string', required: true, maxLength: 200, label: 'Password' },
  });

  const user = get(`SELECT * FROM users WHERE email = ?`, input.email);

  if (!user) {
    dummyPasswordWork();                        // equalise response timing
    logSecurity({ event: 'login_unknown_email', ip: ctx.ip, detail: input.email });
    throw unauthorized('Email or password is incorrect.');
  }

  if (user.locked_until && user.locked_until > new Date().toISOString().replace('T', ' ').slice(0, 19)) {
    logSecurity({ event: 'login_locked_account', severity: 'warning', ip: ctx.ip, userId: user.id });
    throw unauthorized(`Too many failed attempts. This account is locked until ${user.locked_until} UTC.`);
  }

  if (user.status !== 'active') throw forbidden('This account is not active.');

  if (!verifyPassword(input.password, user.password_hash)) {
    const failures = user.failed_logins + 1;
    const lockout = failures >= config.security.maxFailedLogins;
    run(
      `UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?`,
      failures,
      lockout
        ? new Date(Date.now() + config.security.lockoutMinutes * 60_000).toISOString().replace('T', ' ').slice(0, 19)
        : null,
      user.id
    );
    logSecurity({
      event: lockout ? 'login_lockout_triggered' : 'login_bad_password',
      severity: lockout ? 'critical' : 'warning',
      ip: ctx.ip, userId: user.id, detail: `attempt ${failures}`,
    });
    if (lockout) {
      notify({
        userId: user.id, type: 'security', severity: 'critical',
        title: 'Your account was locked',
        body: `There were ${failures} failed sign-in attempts. The account unlocks automatically in ${config.security.lockoutMinutes} minutes.`,
      });
    }
    throw unauthorized('Email or password is incorrect.');
  }

  resetRateLimit(`auth:${ctx.ip}`);
  logSecurity({ event: 'login_success', ip: ctx.ip, userId: user.id });

  const session = issueSession(ctx, user);
  const selfPerson = user.self_person_id
    ? get(`SELECT * FROM persons WHERE id = ?`, user.self_person_id)
    : null;

  return { user: publicUser(user, selfPerson), session };
});

// --------------------------------------------------------------- logout ----

router.post('/logout', async (ctx) => {
  if (ctx.token) revokeSession(ctx.token);
  clearCookie(ctx.res, SESSION_COOKIE);
  if (ctx.user) logSecurity({ event: 'logout', ip: ctx.ip, userId: ctx.user.id });
  return { ok: true };
});

router.post('/logout-all', async (ctx) => {
  revokeAllSessionsForUser(ctx.user.id);
  clearCookie(ctx.res, SESSION_COOKIE);
  logSecurity({ event: 'logout_all_sessions', severity: 'warning', ip: ctx.ip, userId: ctx.user.id });
  return { ok: true };
});

// ------------------------------------------------------------------ me -----

router.get('/me', async (ctx) => {
  const user = get(`SELECT * FROM users WHERE id = ?`, ctx.user.id);
  const selfPerson = user.self_person_id
    ? get(`SELECT * FROM persons WHERE id = ?`, user.self_person_id)
    : null;
  const privacy = get(`SELECT * FROM privacy_settings WHERE user_id = ?`, user.id);

  return {
    user: publicUser(user, selfPerson),
    person: selfPerson ? viewPerson(ctx.user, selfPerson, { includeAudit: true }) : null,
    session: ctx.session,
    privacy: privacy
      ? {
          defaultPersonVisibility: privacy.default_person_visibility,
          profileVisibility: privacy.profile_visibility,
          hideLivingDetails: privacy.hide_living_details === 1,
          allowMatchDiscovery: privacy.allow_match_discovery === 1,
          allowRelationshipSearch: privacy.allow_relationship_search === 1,
          allowAiSuggestions: privacy.allow_ai_suggestions === 1,
          showInDirectory: privacy.show_in_directory === 1,
        }
      : null,
  };
});

router.patch('/profile', async (ctx) => {
  const input = validate(ctx.body, {
    displayName: { type: 'string', maxLength: 100, minLength: 2 },
    email: { type: 'email' },
  });

  const user = get(`SELECT * FROM users WHERE id = ?`, ctx.user.id);

  if (input.email && input.email !== user.email) {
    const taken = get(`SELECT id FROM users WHERE email = ? AND id <> ?`, input.email, user.id);
    if (taken) throw conflict('That email is already in use.');
    run(`UPDATE users SET email = ?, email_verified_at = NULL, updated_at = datetime('now') WHERE id = ?`, input.email, user.id);
    recordChange({
      actorUserId: user.id, actorLabel: user.display_name, entityType: 'user', entityId: user.id,
      entityLabel: user.display_name, action: 'Account Updated', field: 'email',
      oldValue: user.email, newValue: input.email, ip: ctx.ip,
    });
    logSecurity({ event: 'email_changed', severity: 'warning', userId: user.id, ip: ctx.ip });
  }

  if (input.displayName && input.displayName !== user.display_name) {
    run(`UPDATE users SET display_name = ?, updated_at = datetime('now') WHERE id = ?`, input.displayName, user.id);
    recordChange({
      actorUserId: user.id, actorLabel: user.display_name, entityType: 'user', entityId: user.id,
      entityLabel: input.displayName, action: 'Account Updated', field: 'display_name',
      oldValue: user.display_name, newValue: input.displayName, ip: ctx.ip,
    });
  }

  const updated = get(`SELECT * FROM users WHERE id = ?`, user.id);
  return { user: publicUser(updated) };
});

// ------------------------------------------------------- password change ----

router.post('/change-password', async (ctx) => {
  const input = validate(ctx.body, {
    currentPassword: { type: 'string', required: true, maxLength: 200 },
    newPassword: { type: 'password', required: true, label: 'New password' },
  });

  const user = get(`SELECT * FROM users WHERE id = ?`, ctx.user.id);
  if (!verifyPassword(input.currentPassword, user.password_hash)) {
    logSecurity({ event: 'password_change_bad_current', severity: 'warning', userId: user.id, ip: ctx.ip });
    throw unauthorized('Your current password is not correct.');
  }
  if (input.currentPassword === input.newPassword) {
    throw badRequest('The new password must be different from the current one.');
  }

  run(`UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`,
    hashPassword(input.newPassword), user.id);

  // Every other session is dropped: a password change should evict anyone else.
  revokeAllSessionsForUser(user.id, ctx.token);

  recordChange({
    actorUserId: user.id, actorLabel: user.display_name, entityType: 'user', entityId: user.id,
    entityLabel: user.display_name, action: 'Password Changed', ip: ctx.ip,
  });
  logSecurity({ event: 'password_changed', severity: 'warning', userId: user.id, ip: ctx.ip });
  notify({
    userId: user.id, type: 'security', severity: 'warning',
    title: 'Your password was changed',
    body: 'All other signed-in devices were signed out. If this was not you, reset your password immediately.',
  });

  return { ok: true, otherSessionsRevoked: true };
});

// -------------------------------------------------------- password reset ----

router.post('/forgot-password', async (ctx) => {
  const input = validate(ctx.body, { email: { type: 'email', required: true, label: 'Email' } });
  const user = get(`SELECT * FROM users WHERE email = ? AND status = 'active'`, input.email);

  // Always the same response, whether or not the address is registered.
  const response = {
    ok: true,
    message: 'If that email is registered, a reset link has been sent.',
  };

  if (!user) {
    logSecurity({ event: 'reset_requested_unknown_email', ip: ctx.ip, detail: input.email });
    return response;
  }

  const token = createPasswordReset(user.id, ctx.ip);
  const link = `${config.server.publicBaseUrl}/#/reset-password?token=${token}`;

  if (config.mail.transport === 'console') {
    console.log('\n' + '-'.repeat(70));
    console.log('  PASSWORD RESET LINK (MAIL_TRANSPORT=console)');
    console.log(`  Account : ${user.email}`);
    console.log(`  Expires : ${config.security.resetTtlMinutes} minutes`);
    console.log(`  Link    : ${link}`);
    console.log('-'.repeat(70) + '\n');
  }

  logSecurity({ event: 'reset_requested', severity: 'warning', userId: user.id, ip: ctx.ip });
  notify({
    userId: user.id, type: 'security', severity: 'warning',
    title: 'Password reset requested',
    body: `A reset link was requested from ${ctx.ip}. If this was not you, no action is needed -- the link expires in ${config.security.resetTtlMinutes} minutes.`,
  });

  // The link is echoed only for local demos, never in production.
  return config.isProd ? response : { ...response, devResetLink: link };
});

router.post('/reset-password', async (ctx) => {
  const input = validate(ctx.body, {
    token: { type: 'string', required: true, maxLength: 200, label: 'Reset token' },
    newPassword: { type: 'password', required: true, label: 'New password' },
  });

  const userId = consumePasswordReset(input.token);
  if (!userId) {
    logSecurity({ event: 'reset_invalid_token', severity: 'warning', ip: ctx.ip });
    throw badRequest('That reset link is invalid or has expired. Please request a new one.');
  }

  const user = get(`SELECT * FROM users WHERE id = ?`, userId);
  if (!user) throw notFound('Account not found.');

  run(
    `UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = datetime('now')
     WHERE id = ?`,
    hashPassword(input.newPassword), userId
  );
  revokeAllSessionsForUser(userId);

  recordChange({
    actorUserId: userId, actorLabel: user.display_name, entityType: 'user', entityId: userId,
    entityLabel: user.display_name, action: 'Password Reset', ip: ctx.ip,
  });
  logSecurity({ event: 'password_reset_completed', severity: 'warning', userId, ip: ctx.ip });

  return { ok: true, message: 'Your password has been reset. Please sign in.' };
});

router.post('/check-password', async (ctx) => {
  const password = String(ctx.body.password ?? '');
  return checkPasswordStrength(password);
}, { public: true });

// ------------------------------------------------------------- sessions ----

router.get('/sessions', async (ctx) => {
  const rows = all(
    `SELECT s.id, s.auth_method, s.ip, s.user_agent, s.created_at, s.last_seen_at, s.expires_at,
            d.device_id AS device_label
     FROM sessions s
     LEFT JOIN devices d ON d.id = s.device_id
     WHERE s.user_id = ? AND s.revoked_at IS NULL AND s.expires_at > datetime('now')
     ORDER BY s.last_seen_at DESC`,
    ctx.user.id
  );
  return {
    sessions: rows.map((r) => ({
      id: r.id,
      authMethod: r.auth_method,
      ip: r.ip,
      userAgent: r.user_agent,
      device: r.device_label,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      current: r.id === ctx.session.id,
    })),
  };
});

router.delete('/sessions/:id', async (ctx) => {
  const row = get(`SELECT * FROM sessions WHERE id = ? AND user_id = ?`, Number(ctx.params.id), ctx.user.id);
  if (!row) throw notFound('Session not found.');
  run(`UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?`, row.id);
  logSecurity({ event: 'session_revoked', userId: ctx.user.id, ip: ctx.ip, detail: `session ${row.id}` });
  return { ok: true };
});

export default router;
