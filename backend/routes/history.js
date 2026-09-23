/**
 * Change history -- the audit trail.
 *
 * Shows who changed what, when, and what the value was before and after.
 * Scoped to entities in trees the caller can read.
 */
import { Router } from '../lib/http.js';
import { parsePagination } from '../lib/validate.js';
import { all, get } from '../db/index.js';
import { readableOwnerIds } from '../lib/privacy.js';

const router = new Router();

const ACTION_GROUPS = {
  person: ['Person Added', 'Person Updated', 'Person Deleted', 'Photo Updated', 'Photo Removed', 'Duplicate Merged'],
  relationship: ['Relationship Suggested', 'Relationship Verified', 'Relationship Updated',
    'Relationship Removed', 'Relationship Marked Possible', 'Relationship Unverified', 'Connection Rejected'],
  verification: ['Verification Requested', 'Verification Approved', 'Verification Rejected'],
  match: ['Match Scan Run', 'Possible Match Accepted (pending verification)', 'Connection Rejected'],
  security: ['Password Changed', 'Password Reset', 'Account Updated', 'Device Registered',
    'Device Revoked', 'Fingerprint Enrolled', 'Fingerprint Removed', 'Biometric Authentication'],
  collaboration: ['Collaborator Invited', 'Collaboration Accepted', 'Collaborator Removed',
    'Collaborator Role Changed', 'Left Family Tree'],
};

router.get('/', async (ctx) => {
  const { page, pageSize, offset } = parsePagination(ctx.query, { defaultSize: 50, maxSize: 200 });
  const ownerIds = readableOwnerIds(ctx.user);

  const filters = [];
  const params = [];

  // Rows the caller may see: their own actions, plus changes to entities in
  // trees they can read.
  filters.push(`(
    h.actor_user_id = ?
    OR (h.entity_type = 'person' AND h.entity_id IN (
          SELECT id FROM persons WHERE created_by_user_id IN (${ownerIds.map(() => '?').join(',')})))
    OR (h.entity_type = 'relationship' AND h.entity_id IN (
          SELECT r.id FROM relationships r
          JOIN persons p ON p.id = r.from_person_id
          WHERE p.created_by_user_id IN (${ownerIds.map(() => '?').join(',')})))
  )`);
  params.push(ctx.user.id, ...ownerIds, ...ownerIds);

  if (ctx.query.entityType) { filters.push('h.entity_type = ?'); params.push(ctx.query.entityType); }
  if (ctx.query.action) { filters.push('h.action = ?'); params.push(ctx.query.action); }
  if (ctx.query.group && ACTION_GROUPS[ctx.query.group]) {
    const group = ACTION_GROUPS[ctx.query.group];
    filters.push(`h.action IN (${group.map(() => '?').join(',')})`);
    params.push(...group);
  }
  if (ctx.query.since) { filters.push('h.created_at >= ?'); params.push(ctx.query.since); }
  if (ctx.query.actor === 'me') { filters.push('h.actor_user_id = ?'); params.push(ctx.user.id); }

  const where = filters.join(' AND ');
  const total = get(`SELECT COUNT(*) AS n FROM change_history h WHERE ${where}`, ...params)?.n ?? 0;

  const rows = all(
    `SELECT h.*, u.display_name AS actor_name, u.public_id AS actor_public_id
     FROM change_history h
     LEFT JOIN users u ON u.id = h.actor_user_id
     WHERE ${where}
     ORDER BY h.created_at DESC, h.id DESC
     LIMIT ? OFFSET ?`,
    ...params, pageSize, offset
  );

  return {
    history: rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id,
      entityLabel: r.entity_label,
      field: r.field,
      oldValue: r.old_value,
      newValue: r.new_value,
      detail: r.detail,
      actor: {
        id: r.actor_public_id,
        name: r.actor_name ?? r.actor_label ?? 'system',
        isMe: r.actor_user_id === ctx.user.id,
      },
      at: r.created_at,
    })),
    total, page, pageSize,
    totalPages: Math.ceil(total / pageSize),
    groups: Object.keys(ACTION_GROUPS),
  };
});

/** Recent activity for the dashboard. */
router.get('/recent', async (ctx) => {
  const rows = all(
    `SELECT h.*, u.display_name AS actor_name
     FROM change_history h
     LEFT JOIN users u ON u.id = h.actor_user_id
     WHERE h.actor_user_id = ?
        OR (h.entity_type = 'person' AND h.entity_id IN (
              SELECT id FROM persons WHERE created_by_user_id = ?))
     ORDER BY h.created_at DESC, h.id DESC
     LIMIT 12`,
    ctx.user.id, ctx.user.id
  );

  return {
    recent: rows.map((r) => ({
      action: r.action,
      entityType: r.entity_type,
      entityLabel: r.entity_label,
      field: r.field,
      oldValue: r.old_value,
      newValue: r.new_value,
      actor: r.actor_name ?? r.actor_label ?? 'system',
      at: r.created_at,
    })),
  };
});

/** Security-relevant events for the current account. */
router.get('/security', async (ctx) => {
  const rows = all(
    `SELECT * FROM security_log WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`,
    ctx.user.id
  );
  return {
    events: rows.map((r) => ({
      event: r.event,
      severity: r.severity,
      ip: r.ip,
      route: r.route,
      detail: r.detail,
      at: r.created_at,
    })),
  };
});

export default router;
