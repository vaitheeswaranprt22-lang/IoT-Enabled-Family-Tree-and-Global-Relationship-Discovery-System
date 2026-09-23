/**
 * System routes: health, public info, and the dashboard aggregate.
 */
import { Router } from '../lib/http.js';
import { all, get, getDb } from '../db/index.js';
import { aiStatus } from '../ai/suggest.js';
import { unreadCount } from '../lib/audit.js';
import { loadGraph, currentGraphVersion, ancestorsOf, descendantsOf } from '../engine/graph.js';
import { viewPerson } from '../lib/privacy.js';
import config from '../config.js';

const router = new Router();

const STARTED_AT = Date.now();

router.get('/health', async () => {
  let dbOk = true;
  let dbError = null;
  try {
    getDb().prepare('SELECT 1 AS ok').get();
  } catch (err) {
    dbOk = false;
    dbError = err.message;
  }

  return {
    status: dbOk ? 'ok' : 'degraded',
    uptimeSeconds: Math.floor((Date.now() - STARTED_AT) / 1000),
    database: { ok: dbOk, error: dbError },
    version: '1.0.0',
    time: new Date().toISOString(),
  };
}, { public: true });

/** Public description of the deployment -- used by the landing page. */
router.get('/info', async () => {
  const users = get(`SELECT COUNT(*) AS n FROM users WHERE status = 'active'`)?.n ?? 0;
  const persons = get(`SELECT COUNT(*) AS n FROM persons WHERE merged_into_id IS NULL`)?.n ?? 0;
  const verified = get(`SELECT COUNT(*) AS n FROM relationships WHERE status = 'verified'`)?.n ?? 0;
  const synthetic = get(`SELECT COUNT(*) AS n FROM persons WHERE is_synthetic = 1`)?.n ?? 0;
  const devices = get(`SELECT COUNT(*) AS n FROM devices WHERE status = 'active'`)?.n ?? 0;

  return {
    name: 'Global Family Tree & Ancestry Mapping System',
    version: '1.0.0',
    environment: config.env,
    stats: {
      registeredUsers: users,
      people: persons,
      verifiedRelationships: verified,
      syntheticRecords: synthetic,
      registeredScanners: devices,
    },
    features: {
      biometricLogin: true,
      simulatedScanner: config.biometric.allowSimulatedDevice,
      aiAssistance: aiStatus().mode,
      gedcomExport: true,
    },
    principles: [
      'A fingerprint identifies a registered account. It is never treated as evidence of a biological relationship.',
      'Similar names and dates produce a Possible Match, never an automatic connection.',
      'Only human-verified relationships are used as confirmed graph edges.',
      'AI suggests. People decide.',
    ],
  };
}, { public: true });

/** Everything the dashboard needs, in one request. */
router.get('/dashboard', async (ctx) => {
  const self = ctx.user.selfPersonId
    ? get(`SELECT * FROM persons WHERE id = ?`, ctx.user.selfPersonId)
    : null;

  const personCount = get(
    `SELECT COUNT(*) AS n FROM persons WHERE created_by_user_id = ? AND merged_into_id IS NULL`,
    ctx.user.id
  )?.n ?? 0;

  const relStats = all(
    `SELECT r.status, COUNT(*) AS n FROM relationships r
     JOIN persons p ON p.id = r.from_person_id
     WHERE p.created_by_user_id = ?
     GROUP BY r.status`,
    ctx.user.id
  );
  const statusMap = Object.fromEntries(relStats.map((r) => [r.status, r.n]));

  let generations = { ancestors: 0, descendants: 0, total: personCount ? 1 : 0 };
  if (self) {
    const graph = loadGraph({ statuses: ['verified'] });
    const up = ancestorsOf(graph, self.id, 40);
    const down = descendantsOf(graph, self.id, 40);
    const maxUp = up.size ? Math.max(...[...up.values()].map((v) => v.gen)) : 0;
    const maxDown = down.size ? Math.max(...[...down.values()].map((v) => v.gen)) : 0;
    generations = { ancestors: maxUp, descendants: maxDown, total: maxUp + maxDown + 1 };
  }

  const matches = get(
    `SELECT COUNT(*) AS n FROM match_suggestions ms
     WHERE ms.status = 'possible'
       AND (ms.person_a_id IN (SELECT id FROM persons WHERE created_by_user_id = ?)
         OR ms.person_b_id IN (SELECT id FROM persons WHERE created_by_user_id = ?))`,
    ctx.user.id, ctx.user.id
  )?.n ?? 0;

  const verifications = get(
    `SELECT COUNT(*) AS n FROM verification_requests WHERE assigned_to = ? AND status = 'open'`,
    ctx.user.id
  )?.n ?? 0;

  // Scanners the user can actually use: their own, unclaimed ones, and any
  // shared device they already have a finger enrolled on.
  const devices = all(
    `SELECT device_id, name, status, last_seen_at, is_simulated FROM devices
     WHERE status = 'active'
       AND (owner_user_id = ? OR owner_user_id IS NULL
            OR id IN (SELECT device_id FROM biometric_mappings WHERE user_id = ?))
     ORDER BY last_seen_at DESC LIMIT 5`,
    ctx.user.id, ctx.user.id
  );

  const enrollments = get(
    `SELECT COUNT(*) AS n FROM biometric_mappings WHERE user_id = ? AND status = 'active'`,
    ctx.user.id
  )?.n ?? 0;

  const recentChanges = all(
    `SELECT h.action, h.entity_type, h.entity_label, h.created_at, u.display_name AS actor
     FROM change_history h
     LEFT JOIN users u ON u.id = h.actor_user_id
     WHERE h.actor_user_id = ?
        OR (h.entity_type = 'person' AND h.entity_id IN (SELECT id FROM persons WHERE created_by_user_id = ?))
     ORDER BY h.created_at DESC, h.id DESC LIMIT 8`,
    ctx.user.id, ctx.user.id
  );

  const upcomingEvents = all(
    `SELECT e.title, e.event_date, e.type, p.display_name
     FROM events e JOIN persons p ON p.id = e.person_id
     WHERE p.created_by_user_id = ? AND e.event_date IS NOT NULL
     ORDER BY e.event_year DESC LIMIT 5`,
    ctx.user.id
  );

  const lastAuth = get(
    `SELECT l.outcome, l.created_at, d.device_id
     FROM biometric_auth_log l LEFT JOIN devices d ON d.id = l.device_id
     WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT 1`,
    ctx.user.id
  );

  return {
    user: {
      id: ctx.user.publicId,
      displayName: ctx.user.displayName,
      email: ctx.user.email,
      role: ctx.user.role,
    },
    self: self ? viewPerson(ctx.user, self) : null,
    authentication: {
      method: ctx.session.authMethod,
      /** Shown prominently: the user is AUTHENTICATED, which is not a claim about kinship. */
      label: ctx.session.authMethod === 'biometric' ? 'Fingerprint verified' : 'Password sign-in',
      sessionExpiresAt: ctx.session.expiresAt,
      enrolledFingerprints: enrollments,
      lastBiometricAttempt: lastAuth
        ? { outcome: lastAuth.outcome, device: lastAuth.device_id, at: lastAuth.created_at }
        : null,
      note: 'Authentication confirms who you are. Family relationships come only from verified tree data.',
    },
    counts: {
      people: personCount,
      relationships: {
        verified: statusMap.verified ?? 0,
        unverified: statusMap.unverified ?? 0,
        possible: statusMap.possible ?? 0,
        verificationRequested: statusMap.verification_requested ?? 0,
        rejected: statusMap.rejected ?? 0,
      },
      generations,
      possibleMatches: matches,
      verificationRequests: verifications,
      notifications: unreadCount(ctx.user.id),
      collaborators: get(
        `SELECT COUNT(*) AS n FROM tree_collaborators WHERE owner_user_id = ? AND status = 'active'`,
        ctx.user.id
      )?.n ?? 0,
    },
    hardware: {
      devices: devices.map((d) => {
        const lastSeen = d.last_seen_at ? new Date(`${d.last_seen_at}Z`).getTime() : null;
        return {
          id: d.device_id,
          name: d.name,
          status: d.status,
          simulated: d.is_simulated === 1,
          online: lastSeen !== null && Date.now() - lastSeen < 120_000,
          lastSeenAt: d.last_seen_at,
        };
      }),
    },
    recentChanges: recentChanges.map((r) => ({
      action: r.action,
      entityType: r.entity_type,
      entityLabel: r.entity_label,
      actor: r.actor ?? 'system',
      at: r.created_at,
    })),
    recentEvents: upcomingEvents.map((e) => ({
      title: e.title, date: e.event_date, type: e.type, person: e.display_name,
    })),
    ai: aiStatus(),
    graphVersion: currentGraphVersion(),
  };
});

export default router;
