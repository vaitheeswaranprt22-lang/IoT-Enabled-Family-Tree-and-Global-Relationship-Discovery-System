/**
 * Audit trail, notifications and security logging.
 *
 * Every mutation of a person, relationship, match or verification is recorded
 * here with actor, action, old value and new value. The change-history screen
 * reads straight from `change_history`, so there is no way to change family
 * data through the API without leaving a record.
 */
import { run, get, all, newPublicId } from '../db/index.js';

/**
 * @param {object} p
 * @param {number|null} p.actorUserId
 * @param {string}      p.actorLabel   preserved even if the account is deleted
 * @param {string}      p.entityType   person|relationship|event|match|...
 * @param {number|null} p.entityId
 * @param {string}      p.entityLabel  e.g. the person's name at the time
 * @param {string}      p.action       'Person Added', 'Relationship Verified', ...
 */
export function recordChange({
  actorUserId = null,
  actorLabel = null,
  entityType,
  entityId = null,
  entityLabel = null,
  action,
  field = null,
  oldValue = null,
  newValue = null,
  detail = null,
  ip = null,
}) {
  run(
    `INSERT INTO change_history
       (actor_user_id, actor_label, entity_type, entity_id, entity_label,
        action, field, old_value, new_value, detail, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    actorUserId,
    actorLabel,
    entityType,
    entityId,
    entityLabel,
    action,
    field,
    oldValue === null || oldValue === undefined ? null : String(oldValue).slice(0, 2000),
    newValue === null || newValue === undefined ? null : String(newValue).slice(0, 2000),
    detail,
    ip
  );
}

/**
 * Diffs two records and writes one history row per changed field.
 * Used by PATCH handlers so "what actually changed" is never guesswork.
 */
export function recordFieldChanges(base, before, after, fields) {
  let changed = 0;
  for (const field of fields) {
    const oldVal = before?.[field] ?? null;
    const newVal = after?.[field] ?? null;
    if (String(oldVal ?? '') === String(newVal ?? '')) continue;
    recordChange({ ...base, field, oldValue: oldVal, newValue: newVal });
    changed += 1;
  }
  return changed;
}

export function notify({ userId, type, title, body = null, link = null, severity = 'info' }) {
  if (!userId) return null;
  run(
    `INSERT INTO notifications (public_id, user_id, type, severity, title, body, link)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newPublicId(),
    userId,
    type,
    severity,
    title,
    body,
    link
  );
  return true;
}

export function notifyMany(userIds, payload) {
  const seen = new Set();
  for (const id of userIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    notify({ ...payload, userId: id });
  }
}

export function unreadCount(userId) {
  const row = get(
    `SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL`,
    userId
  );
  return row?.n ?? 0;
}

export function logSecurity({ event, severity = 'info', userId = null, ip = null, route = null, detail = null }) {
  run(
    `INSERT INTO security_log (event, severity, user_id, ip, route, detail)
     VALUES (?, ?, ?, ?, ?, ?)`,
    event,
    severity,
    userId,
    ip,
    route,
    detail
  );
  if (severity === 'critical') {
    console.warn(`[security] ${event} ip=${ip ?? '-'} user=${userId ?? '-'} ${detail ?? ''}`);
  }
}

/** Recent history for one entity, newest first. */
export function historyFor(entityType, entityId, limit = 50) {
  return all(
    `SELECT h.*, u.display_name AS actor_name
     FROM change_history h
     LEFT JOIN users u ON u.id = h.actor_user_id
     WHERE h.entity_type = ? AND h.entity_id = ?
     ORDER BY h.created_at DESC, h.id DESC
     LIMIT ?`,
    entityType,
    entityId,
    limit
  );
}
