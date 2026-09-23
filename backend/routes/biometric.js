/**
 * Biometric / IoT gateway.
 *
 * WHAT THE FINGERPRINT ACTUALLY DOES
 *   It identifies a registered ACCOUNT. It is not, and is never treated as,
 *   evidence of a biological relationship. Family relationships come only from
 *   the family graph and the verification workflow.
 *
 * LOGIN HANDSHAKE (browser-initiated, so a scanner alone cannot mint a session
 * for somebody else's browser):
 *
 *   1. Browser  POST /api/biometric/challenge  { deviceId }
 *               -> { challengeId, code, expiresIn }      code shown on screen
 *   2. ESP32    GET  /api/biometric/device/poll          (signed)
 *               -> { challenge: { code, purpose } }      code shown on the LCD
 *   3. User compares the two codes, then places a finger.
 *   4. ESP32    POST /api/biometric/device/scan          (signed)
 *               { sensorSlotId, confidence, challengeCode }
 *               -> { outcome: 'success' | ... , displayName }
 *   5. Browser  GET  /api/biometric/challenge/:id
 *               -> { status: 'fulfilled', session: { token } }   picked up once
 *
 * REQUEST SIGNING
 *   Every device request carries:
 *       X-Device-Id, X-Device-Timestamp, X-Device-Nonce, X-Device-Signature
 *   where the signature is
 *       HMAC-SHA256(deviceKey, "<deviceId>|<timestamp>|<nonce>|<payload>")
 *   The payload is a short canonical string per endpoint (see SIGN_PAYLOAD
 *   below) rather than the raw JSON, so the firmware does not need a JSON
 *   serialiser to reproduce it byte-for-byte.
 *
 *   Timestamps outside DEVICE_CLOCK_SKEW_SECONDS are rejected, and each nonce
 *   is accepted once per device -- together these stop replay attacks.
 *
 * WHAT IS STORED
 *   Only the sensor's template SLOT NUMBER. The fingerprint image and template
 *   never leave the sensor module. See docs/hardware-wiring.md.
 */
import crypto from 'node:crypto';
import { Router, setCookie } from '../lib/http.js';
import { validate } from '../lib/validate.js';
import { all, get, run, newPublicId, transaction } from '../db/index.js';
import {
  sha256, hmac, randomToken, friendlyCode, safeEquals, createSession, SESSION_COOKIE,
} from '../lib/auth.js';
import { recordChange, logSecurity, notify } from '../lib/audit.js';
import { badRequest, unauthorized, notFound, conflict, forbidden } from '../lib/errors.js';
import config from '../config.js';

const router = new Router();

// ============================== device auth =================================

/**
 * Verifies a signed device request.
 * @param {object} ctx
 * @param {string} payload  canonical payload string for this endpoint
 * @returns {object} the device row
 */
function authenticateDevice(ctx, payload) {
  const deviceId = String(ctx.req.headers['x-device-id'] ?? '').trim();
  const timestamp = String(ctx.req.headers['x-device-timestamp'] ?? '').trim();
  const nonce = String(ctx.req.headers['x-device-nonce'] ?? '').trim();
  const signature = String(ctx.req.headers['x-device-signature'] ?? '').trim();

  if (!deviceId || !timestamp || !nonce || !signature) {
    throw unauthorized('Missing device authentication headers.');
  }

  const device = get(`SELECT * FROM devices WHERE device_id = ?`, deviceId);
  if (!device) {
    logSecurity({ event: 'device_unknown', severity: 'warning', ip: ctx.ip, detail: deviceId });
    throw unauthorized('Unknown device.');
  }
  if (device.status !== 'active') {
    logBiometric({ deviceId: device.id, outcome: 'device_disabled', ip: ctx.ip, detail: device.status });
    throw forbidden(`This device is ${device.status}.`);
  }
  if (device.is_simulated === 1 && !config.biometric.allowSimulatedDevice) {
    throw forbidden('Simulated devices are disabled on this server.');
  }

  // Clock skew window.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) throw unauthorized('Invalid device timestamp.');
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > config.biometric.clockSkewSeconds) {
    logBiometric({ deviceId: device.id, outcome: 'replay', ip: ctx.ip, detail: `clock skew ${skew}s` });
    throw unauthorized(
      `Device clock is ${skew}s out of step (limit ${config.biometric.clockSkewSeconds}s). Check the ESP32 time sync.`
    );
  }

  if (nonce.length < 8 || nonce.length > 64) throw unauthorized('Invalid device nonce.');

  const expected = crypto
    .createHmac('sha256', deviceKeyFor(device))
    .update(`${deviceId}|${timestamp}|${nonce}|${payload}`)
    .digest('hex');

  if (!safeEquals(expected, signature.toLowerCase())) {
    logBiometric({ deviceId: device.id, outcome: 'bad_signature', ip: ctx.ip });
    logSecurity({ event: 'device_bad_signature', severity: 'critical', ip: ctx.ip, detail: deviceId });
    throw unauthorized('Device signature did not verify.');
  }

  // Replay protection: a nonce is good exactly once per device.
  try {
    run(`INSERT INTO device_nonces (device_id, nonce) VALUES (?, ?)`, device.id, nonce);
  } catch {
    logBiometric({ deviceId: device.id, outcome: 'replay', ip: ctx.ip, detail: 'nonce reused' });
    logSecurity({ event: 'device_nonce_replay', severity: 'critical', ip: ctx.ip, detail: deviceId });
    throw unauthorized('This request was already used (nonce replay).');
  }

  run(
    `UPDATE devices SET last_seen_at = datetime('now'), ip_address = ? WHERE id = ?`,
    ctx.ip, device.id
  );

  return device;
}

/**
 * The device's signing key.
 *
 * At registration the server generates a random secret, stores only
 * `api_key_hash = SHA-256(secret)`, discards the secret, and hands the device
 * `HMAC(APP_SECRET, api_key_hash)`. Both sides can then produce the same key:
 * the device from what it was given, the server from the stored hash.
 *
 * HMAC is symmetric, so the server necessarily holds key-equivalent material.
 * What this arrangement buys is that the database alone is not enough -- an
 * attacker also needs APP_SECRET, which lives outside the database in the
 * environment. Keep the two in separate places.
 */
function deviceKeyFor(device) {
  return hmac(device.api_key_hash, config.security.appSecret);
}

/** The signing key a device must be given at registration time. */
function derivedKeyForClient(plaintextKey) {
  return hmac(sha256(plaintextKey), config.security.appSecret);
}

function logBiometric({ deviceId = null, userId = null, slot = null, outcome, confidence = null, ip = null, detail = null }) {
  run(
    `INSERT INTO biometric_auth_log (device_id, user_id, sensor_slot_id, outcome, confidence, ip, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    deviceId, userId, slot, outcome, confidence, ip, detail
  );
}

// ========================== browser: challenges =============================

/**
 * Step 1 -- the browser asks for a challenge. No session is required: this is
 * how a signed-out user logs in with a fingerprint.
 */
router.post('/challenge', async (ctx) => {
  const input = validate(ctx.body, {
    deviceId: { type: 'string', required: true, maxLength: 64, label: 'Device' },
    purpose: { type: 'enum', values: ['login', 'verify'], default: 'login' },
  });

  const device = get(`SELECT * FROM devices WHERE device_id = ?`, input.deviceId);
  if (!device) throw notFound('That scanner is not registered.');
  if (device.status !== 'active') throw forbidden(`That scanner is ${device.status}.`);

  // One pending challenge per device at a time -- the LCD can only show one.
  run(
    `UPDATE biometric_challenges SET status = 'expired'
     WHERE device_id = ? AND status IN ('pending','claimed') AND expires_at < datetime('now')`,
    device.id
  );

  const code = friendlyCode(6);
  const publicId = newPublicId();
  const expiresAt = new Date(Date.now() + config.biometric.challengeTtlSeconds * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);

  run(
    `INSERT INTO biometric_challenges (public_id, code, device_id, purpose, browser_ip, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    publicId, code, device.id, input.purpose, ctx.ip, expiresAt
  );

  return {
    __status: 201,
    challengeId: publicId,
    code,
    device: { id: device.device_id, name: device.name, simulated: device.is_simulated === 1 },
    expiresInSeconds: config.biometric.challengeTtlSeconds,
    instructions: [
      'Check that the code on the LCD matches the code on this screen.',
      'Place your enrolled finger on the sensor.',
      'Hold still until the LCD reports the result.',
    ],
  };
});

/**
 * Step 5 -- the browser polls. When the device has authenticated someone, the
 * session token is handed over exactly once and the challenge is consumed.
 */
router.get('/challenge/:id', async (ctx) => {
  const challenge = get(`SELECT * FROM biometric_challenges WHERE public_id = ?`, ctx.params.id);
  if (!challenge) throw notFound('That sign-in request was not found.');

  if (challenge.expires_at < new Date().toISOString().replace('T', ' ').slice(0, 19)
      && !['fulfilled', 'consumed'].includes(challenge.status)) {
    run(`UPDATE biometric_challenges SET status = 'expired' WHERE id = ?`, challenge.id);
    return { status: 'expired', message: 'This sign-in request timed out. Start again.' };
  }

  if (challenge.status === 'pending') {
    return { status: 'pending', code: challenge.code, message: 'Waiting for the scanner to pick up the request.' };
  }
  if (challenge.status === 'claimed') {
    return { status: 'claimed', code: challenge.code, message: 'Scanner is ready. Place your finger.' };
  }
  if (challenge.status === 'failed') {
    return { status: 'failed', message: challenge.detail ?? 'The fingerprint was not recognised.' };
  }
  if (challenge.status === 'consumed') {
    return { status: 'consumed', message: 'This sign-in request was already used.' };
  }
  if (challenge.status !== 'fulfilled') {
    return { status: challenge.status, message: 'This sign-in request is no longer valid.' };
  }

  // Fulfilled: hand the token over once, then burn the challenge.
  const user = get(`SELECT * FROM users WHERE id = ?`, challenge.user_id);
  if (!user) throw notFound('The matched account no longer exists.');

  const { token, expiresAt, ttlMinutes } = createSession(user.id, {
    authMethod: 'biometric',
    deviceId: challenge.device_id,
    ip: ctx.ip,
    userAgent: ctx.req.headers['user-agent'],
  });

  run(
    `UPDATE biometric_challenges SET status = 'consumed', session_token_hash = ? WHERE id = ?`,
    sha256(token), challenge.id
  );
  run(`UPDATE users SET last_login_at = datetime('now'), failed_logins = 0 WHERE id = ?`, user.id);

  setCookie(ctx.res, SESSION_COOKIE, token, { maxAge: ttlMinutes * 60, sameSite: 'Lax' });

  const selfPerson = user.self_person_id
    ? get(`SELECT public_id, display_name FROM persons WHERE id = ?`, user.self_person_id)
    : null;

  logSecurity({ event: 'biometric_login_success', userId: user.id, ip: ctx.ip, detail: `challenge ${challenge.public_id}` });

  return {
    status: 'fulfilled',
    session: { token, expiresAt, authMethod: 'biometric' },
    user: {
      id: user.public_id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      selfPerson: selfPerson ? { id: selfPerson.public_id, name: selfPerson.display_name } : null,
    },
    note: 'Signed in by fingerprint. This confirms who you are -- it says nothing about family relationships.',
  };
});

// ============================ device endpoints ==============================

/**
 * Step 2 -- the ESP32 asks whether anyone is waiting to sign in.
 * Signed payload: "poll"
 */
router.get('/device/poll', async (ctx) => {
  const device = authenticateDevice(ctx, 'poll');

  const challenge = get(
    `SELECT * FROM biometric_challenges
     WHERE device_id = ? AND status = 'pending' AND expires_at > datetime('now')
     ORDER BY created_at ASC LIMIT 1`,
    device.id
  );

  if (!challenge) {
    return { challenge: null, serverTime: Math.floor(Date.now() / 1000) };
  }

  run(`UPDATE biometric_challenges SET status = 'claimed', claimed_at = datetime('now') WHERE id = ?`, challenge.id);

  return {
    challenge: {
      code: challenge.code,
      purpose: challenge.purpose,
      expiresInSeconds: Math.max(
        0,
        Math.floor((new Date(`${challenge.expires_at}Z`).getTime() - Date.now()) / 1000)
      ),
    },
    serverTime: Math.floor(Date.now() / 1000),
  };
});

/**
 * Step 4 -- the ESP32 reports a fingerprint match.
 * Signed payload: "scan|<sensorSlotId>|<confidence>|<challengeCode>"
 */
router.post('/device/scan', async (ctx) => {
  const slot = Number(ctx.body.sensorSlotId);
  const confidence = Number(ctx.body.confidence ?? 0);
  const challengeCode = String(ctx.body.challengeCode ?? '').toUpperCase();

  if (!Number.isInteger(slot) || slot < 0) throw badRequest('sensorSlotId must be a non-negative integer.');

  const device = authenticateDevice(ctx, `scan|${slot}|${confidence}|${challengeCode}`);

  const challenge = get(
    `SELECT * FROM biometric_challenges
     WHERE device_id = ? AND code = ? AND status IN ('pending','claimed') AND expires_at > datetime('now')`,
    device.id, challengeCode
  );

  if (!challenge) {
    logBiometric({ deviceId: device.id, slot, outcome: 'no_challenge', confidence, ip: ctx.ip });
    return {
      outcome: 'no_challenge',
      lcd: 'No Request',
      message: 'No sign-in request is waiting for this scanner, or it has expired.',
    };
  }

  const fail = (outcome, lcd, message, detail = null) => {
    logBiometric({ deviceId: device.id, slot, outcome, confidence, ip: ctx.ip, detail });
    run(`UPDATE biometric_challenges SET status = 'failed', detail = ? WHERE id = ?`, message, challenge.id);
    return { outcome, lcd, message };
  };

  // The sensor's own confidence score must clear the configured floor.
  if (confidence > 0 && confidence < config.biometric.minConfidence) {
    return fail(
      'low_confidence', 'Try Again',
      `The fingerprint match was too weak (${confidence} < ${config.biometric.minConfidence}). Clean the sensor and try again.`
    );
  }

  const mapping = get(
    `SELECT bm.*, u.display_name, u.status AS user_status
     FROM biometric_mappings bm
     JOIN users u ON u.id = bm.user_id
     WHERE bm.device_id = ? AND bm.sensor_slot_id = ?`,
    device.id, slot
  );

  if (!mapping) {
    return fail('unknown_slot', 'User Not Found',
      `Fingerprint slot #${slot} is not linked to any account on this scanner.`);
  }
  if (mapping.status !== 'active') {
    return fail('locked', 'Access Denied', `That fingerprint is ${mapping.status}.`);
  }
  if (mapping.user_status !== 'active') {
    return fail('locked', 'Access Denied', 'That account is not active.');
  }

  // Success: bind the account to the challenge. The browser collects the
  // session -- the device never receives one.
  transaction(() => {
    run(
      `UPDATE biometric_challenges
       SET status = 'fulfilled', user_id = ?, fulfilled_at = datetime('now'), detail = NULL
       WHERE id = ?`,
      mapping.user_id, challenge.id
    );
    run(
      `UPDATE biometric_mappings SET last_used_at = datetime('now'), failed_attempts = 0 WHERE id = ?`,
      mapping.id
    );
    logBiometric({
      deviceId: device.id, userId: mapping.user_id, slot,
      outcome: 'success', confidence, ip: ctx.ip,
    });
  });

  recordChange({
    actorUserId: mapping.user_id, actorLabel: mapping.display_name,
    entityType: 'biometric', entityId: mapping.id, entityLabel: mapping.label,
    action: 'Biometric Authentication', detail: `Device ${device.device_id}, slot ${slot}, confidence ${confidence}.`,
    ip: ctx.ip,
  });

  return {
    outcome: 'success',
    lcd: 'User Verified',
    displayName: mapping.display_name,
    message: `${mapping.display_name} identified. The browser can now complete sign-in.`,
    note: 'Identity confirmed. This does not establish any family relationship.',
  };
});

/**
 * Keep-alive and status report.
 * Signed payload: "heartbeat"
 */
router.post('/device/heartbeat', async (ctx) => {
  const device = authenticateDevice(ctx, 'heartbeat');

  const firmware = String(ctx.body.firmwareVersion ?? '').slice(0, 40) || null;
  const error = String(ctx.body.lastError ?? '').slice(0, 200) || null;

  run(
    `UPDATE devices SET firmware_version = COALESCE(?, firmware_version), last_error = ?,
     last_seen_at = datetime('now') WHERE id = ?`,
    firmware, error, device.id
  );

  const pending = get(
    `SELECT COUNT(*) AS n FROM biometric_challenges
     WHERE device_id = ? AND status = 'pending' AND expires_at > datetime('now')`,
    device.id
  )?.n ?? 0;

  return {
    ok: true,
    serverTime: Math.floor(Date.now() / 1000),
    pendingChallenges: pending,
    enrolledSlots: get(
      `SELECT COUNT(*) AS n FROM biometric_mappings WHERE device_id = ? AND status = 'active'`,
      device.id
    )?.n ?? 0,
    lcd: pending > 0 ? 'Place Finger' : 'Ready',
  };
});

/**
 * Guided enrolment: the device reports a slot it has just enrolled.
 * Signed payload: "enroll|<sensorSlotId>|<challengeCode>"
 */
router.post('/device/enroll-result', async (ctx) => {
  const slot = Number(ctx.body.sensorSlotId);
  const challengeCode = String(ctx.body.challengeCode ?? '').toUpperCase();
  if (!Number.isInteger(slot) || slot < 0) throw badRequest('sensorSlotId must be a non-negative integer.');

  const device = authenticateDevice(ctx, `enroll|${slot}|${challengeCode}`);

  const challenge = get(
    `SELECT * FROM biometric_challenges
     WHERE device_id = ? AND code = ? AND purpose = 'enroll'
       AND status IN ('pending','claimed') AND expires_at > datetime('now')`,
    device.id, challengeCode
  );
  if (!challenge) {
    return { outcome: 'no_challenge', lcd: 'No Request', message: 'No enrolment request is waiting.' };
  }
  if (!challenge.user_id) {
    return { outcome: 'error', lcd: 'Error', message: 'That enrolment request has no account attached.' };
  }

  const taken = get(
    `SELECT id FROM biometric_mappings WHERE device_id = ? AND sensor_slot_id = ?`,
    device.id, slot
  );
  if (taken) {
    run(`UPDATE biometric_challenges SET status = 'failed', detail = ? WHERE id = ?`,
      `Slot ${slot} is already linked to an account.`, challenge.id);
    return { outcome: 'duplicate', lcd: 'Slot In Use', message: `Slot ${slot} is already linked to an account.` };
  }

  transaction(() => {
    run(
      `INSERT INTO biometric_mappings
         (public_id, user_id, device_id, sensor_slot_id, credential_hash, label, enrolled_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newPublicId(), challenge.user_id, device.id, slot,
      hmac(`${device.device_id}:${slot}:${challenge.user_id}`),
      'Enrolled at the scanner', challenge.user_id
    );
    run(`UPDATE biometric_challenges SET status = 'consumed', fulfilled_at = datetime('now') WHERE id = ?`, challenge.id);
  });

  notify({
    userId: challenge.user_id, type: 'biometric', severity: 'success',
    title: 'A fingerprint was enrolled',
    body: `Slot #${slot} on ${device.name} is now linked to your account.`,
    link: '#/hardware',
  });

  return { outcome: 'success', lcd: 'Enrolled', message: `Slot ${slot} linked to the account.` };
});

// ======================= user-facing device management ======================

router.get('/status', async (ctx) => {
  // Scanners the user can act on: their own, unclaimed ones, and shared
  // devices they already have a finger enrolled on.
  const devices = all(
    `SELECT d.*,
            (SELECT COUNT(*) FROM biometric_mappings bm WHERE bm.device_id = d.id AND bm.status = 'active') AS enrolled
     FROM devices d
     WHERE d.status <> 'revoked'
       AND (d.owner_user_id = ? OR d.owner_user_id IS NULL
            OR d.id IN (SELECT device_id FROM biometric_mappings WHERE user_id = ?))
     ORDER BY d.created_at DESC`,
    ctx.user.id, ctx.user.id
  );

  const mappings = all(
    `SELECT bm.*, d.device_id AS device_code, d.name AS device_name
     FROM biometric_mappings bm
     JOIN devices d ON d.id = bm.device_id
     WHERE bm.user_id = ?
     ORDER BY bm.enrolled_at DESC`,
    ctx.user.id
  );

  const recent = all(
    `SELECT l.*, d.device_id AS device_code
     FROM biometric_auth_log l
     LEFT JOIN devices d ON d.id = l.device_id
     WHERE l.user_id = ? OR l.device_id IN (SELECT id FROM devices WHERE owner_user_id = ?)
     ORDER BY l.created_at DESC LIMIT 25`,
    ctx.user.id, ctx.user.id
  );

  const ONLINE_WINDOW_SECONDS = 120;

  return {
    devices: devices.map((d) => {
      const lastSeen = d.last_seen_at ? new Date(`${d.last_seen_at}Z`).getTime() : null;
      const secondsAgo = lastSeen ? Math.floor((Date.now() - lastSeen) / 1000) : null;
      return {
        id: d.device_id,
        name: d.name,
        location: d.location,
        status: d.status,
        online: secondsAgo !== null && secondsAgo <= ONLINE_WINDOW_SECONDS,
        lastSeenAt: d.last_seen_at,
        lastSeenSecondsAgo: secondsAgo,
        firmwareVersion: d.firmware_version,
        ipAddress: d.ip_address,
        lastError: d.last_error,
        enrolledFingerprints: d.enrolled,
        simulated: d.is_simulated === 1,
        isMine: d.owner_user_id === ctx.user.id,
      };
    }),
    enrollments: mappings.map((m) => ({
      id: m.public_id,
      device: m.device_code,
      deviceName: m.device_name,
      slot: m.sensor_slot_id,
      label: m.label,
      status: m.status,
      enrolledAt: m.enrolled_at,
      lastUsedAt: m.last_used_at,
      failedAttempts: m.failed_attempts,
    })),
    recentActivity: recent.map((r) => ({
      outcome: r.outcome,
      device: r.device_code,
      slot: r.sensor_slot_id,
      confidence: r.confidence,
      at: r.created_at,
      detail: r.detail,
    })),
    policy: {
      minConfidence: config.biometric.minConfidence,
      challengeTtlSeconds: config.biometric.challengeTtlSeconds,
      simulatedDevicesAllowed: config.biometric.allowSimulatedDevice,
      storedData: 'Only the sensor template slot number. No fingerprint image or template is stored by this application.',
      meaning: 'A fingerprint identifies a registered account. It is never used as evidence of a biological relationship.',
    },
  };
});

/** Registers a scanner. The plaintext signing key is shown exactly once. */
router.post('/devices', async (ctx) => {
  const input = validate(ctx.body, {
    deviceId: {
      type: 'string', required: true, maxLength: 64, minLength: 3, label: 'Device ID',
      pattern: /^[A-Za-z0-9_-]+$/,
      patternMessage: 'Use letters, numbers, hyphens and underscores only.',
    },
    name: { type: 'string', required: true, maxLength: 100, label: 'Name' },
    location: { type: 'string', maxLength: 120 },
    simulated: { type: 'bool', default: false },
  });

  if (get(`SELECT id FROM devices WHERE device_id = ?`, input.deviceId)) {
    throw conflict('A device with that ID is already registered.');
  }
  if (input.simulated && !config.biometric.allowSimulatedDevice) {
    throw forbidden('Simulated devices are disabled on this server.');
  }

  const plaintextKey = randomToken(32);

  run(
    `INSERT INTO devices (device_id, name, api_key_hash, location, owner_user_id, is_simulated)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.deviceId, input.name, sha256(plaintextKey), input.location ?? null,
    ctx.user.id, input.simulated ? 1 : 0
  );

  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'device', entityId: null, entityLabel: input.deviceId,
    action: 'Device Registered', newValue: input.name, ip: ctx.ip,
  });
  logSecurity({ event: 'device_registered', severity: 'warning', userId: ctx.user.id, ip: ctx.ip, detail: input.deviceId });

  return {
    __status: 201,
    device: { id: input.deviceId, name: input.name, simulated: input.simulated },
    /** Copy this into the firmware's secrets.h. It is not shown again. */
    signingKey: derivedKeyForClient(plaintextKey),
    warning:
      'Copy the signing key now -- it is shown only once. Put it in esp32-firmware/.../secrets.h, which is git-ignored.',
  };
});

router.delete('/devices/:id', async (ctx) => {
  const device = get(`SELECT * FROM devices WHERE device_id = ?`, ctx.params.id);
  if (!device) throw notFound('Device not found.');
  if (device.owner_user_id !== ctx.user.id && ctx.user.role !== 'admin') {
    throw forbidden('Only the device owner can remove it.');
  }
  run(`UPDATE devices SET status = 'revoked' WHERE id = ?`, device.id);
  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'device', entityId: device.id, entityLabel: device.device_id,
    action: 'Device Revoked', ip: ctx.ip,
  });
  return { ok: true, status: 'revoked' };
});

/** Manual enrolment: the user types in a slot number from the enrol sketch. */
router.post('/enroll', async (ctx) => {
  const input = validate(ctx.body, {
    deviceId: { type: 'string', required: true, maxLength: 64, label: 'Device' },
    sensorSlotId: { type: 'int', required: true, min: 0, max: 4095, label: 'Fingerprint slot' },
    label: { type: 'string', maxLength: 60, default: 'Right index finger' },
  });

  const device = get(`SELECT * FROM devices WHERE device_id = ?`, input.deviceId);
  if (!device) throw notFound('That scanner is not registered.');
  if (device.status !== 'active') throw forbidden(`That scanner is ${device.status}.`);

  const taken = get(
    `SELECT bm.*, u.display_name FROM biometric_mappings bm
     JOIN users u ON u.id = bm.user_id
     WHERE bm.device_id = ? AND bm.sensor_slot_id = ?`,
    device.id, input.sensorSlotId
  );
  if (taken) {
    throw conflict(
      taken.user_id === ctx.user.id
        ? `Slot #${input.sensorSlotId} is already linked to your account.`
        : `Slot #${input.sensorSlotId} on this scanner is already linked to another account.`
    );
  }

  const publicId = newPublicId();
  run(
    `INSERT INTO biometric_mappings
       (public_id, user_id, device_id, sensor_slot_id, credential_hash, label, enrolled_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    publicId, ctx.user.id, device.id, input.sensorSlotId,
    hmac(`${device.device_id}:${input.sensorSlotId}:${ctx.user.id}`),
    input.label, ctx.user.id
  );

  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'biometric', entityId: null, entityLabel: input.label,
    action: 'Fingerprint Enrolled',
    newValue: `${device.device_id} slot ${input.sensorSlotId}`, ip: ctx.ip,
  });
  logSecurity({ event: 'biometric_enrolled', severity: 'warning', userId: ctx.user.id, ip: ctx.ip });

  return {
    __status: 201,
    enrollment: { id: publicId, device: device.device_id, slot: input.sensorSlotId, label: input.label },
    note: 'Only the slot number is stored. The fingerprint template stays on the sensor module.',
  };
});

/** Guided enrolment: creates a challenge the scanner will pick up. */
router.post('/enroll/start', async (ctx) => {
  const input = validate(ctx.body, {
    deviceId: { type: 'string', required: true, maxLength: 64, label: 'Device' },
  });
  const device = get(`SELECT * FROM devices WHERE device_id = ?`, input.deviceId);
  if (!device) throw notFound('That scanner is not registered.');

  const code = friendlyCode(6);
  const publicId = newPublicId();
  run(
    `INSERT INTO biometric_challenges (public_id, code, device_id, purpose, status, user_id, browser_ip, expires_at)
     VALUES (?, ?, ?, 'enroll', 'pending', ?, ?, ?)`,
    publicId, code, device.id, ctx.user.id, ctx.ip,
    new Date(Date.now() + 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
  );

  return {
    __status: 201,
    challengeId: publicId,
    code,
    expiresInSeconds: 300,
    instructions: [
      'The scanner will show this code and ask for your finger.',
      'Place the same finger twice when prompted.',
      'The slot number is linked to your account automatically.',
    ],
  };
});

router.delete('/enroll/:id', async (ctx) => {
  const mapping = get(`SELECT * FROM biometric_mappings WHERE public_id = ?`, ctx.params.id);
  if (!mapping) throw notFound('Enrolment not found.');
  if (mapping.user_id !== ctx.user.id && ctx.user.role !== 'admin') {
    throw forbidden('You can only remove your own fingerprint enrolments.');
  }

  run(`DELETE FROM biometric_mappings WHERE id = ?`, mapping.id);
  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'biometric', entityId: mapping.id, entityLabel: mapping.label,
    action: 'Fingerprint Removed', oldValue: `slot ${mapping.sensor_slot_id}`, ip: ctx.ip,
  });
  logSecurity({ event: 'biometric_removed', severity: 'warning', userId: ctx.user.id, ip: ctx.ip });

  return {
    ok: true,
    note: `The link to slot #${mapping.sensor_slot_id} was removed. Delete the template from the sensor itself with the enrolment sketch if you also want it erased from the hardware.`,
  };
});

/** Devices a signed-out login page may offer. Public by necessity. */
router.get('/devices/available', async () => {
  const rows = all(
    `SELECT device_id, name, location, is_simulated, last_seen_at, status
     FROM devices WHERE status = 'active' ORDER BY name`
  );
  return {
    devices: rows.map((d) => {
      const lastSeen = d.last_seen_at ? new Date(`${d.last_seen_at}Z`).getTime() : null;
      return {
        id: d.device_id,
        name: d.name,
        location: d.location,
        simulated: d.is_simulated === 1,
        online: lastSeen !== null && Date.now() - lastSeen < 120_000,
      };
    }),
  };
}, { public: true });

router.get('/log', async (ctx) => {
  const rows = all(
    `SELECT l.*, d.device_id AS device_code, u.display_name
     FROM biometric_auth_log l
     LEFT JOIN devices d ON d.id = l.device_id
     LEFT JOIN users u ON u.id = l.user_id
     WHERE l.user_id = ? OR d.owner_user_id = ?
     ORDER BY l.created_at DESC LIMIT 200`,
    ctx.user.id, ctx.user.id
  );
  return {
    log: rows.map((r) => ({
      outcome: r.outcome,
      device: r.device_code,
      user: r.display_name,
      slot: r.sensor_slot_id,
      confidence: r.confidence,
      ip: r.ip,
      detail: r.detail,
      at: r.created_at,
    })),
  };
});

export default router;
