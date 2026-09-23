/**
 * Relationship routes: the edges of the family graph.
 *
 * A relationship is always created as 'unverified'. Promoting it to 'verified'
 * happens only through an explicit human decision -- either the tree owner
 * acting directly, or an approved verification request.
 */
import { Router } from '../lib/http.js';
import { validate, parsePagination } from '../lib/validate.js';
import { all, get, run, newPublicId, transaction } from '../db/index.js';
import {
  createRelationship, setRelationshipStatus, viewRelationship, relationshipLabel,
} from '../lib/person-service.js';
import {
  canViewPerson, accessLevel, atLeast, canVerifyOnTree,
} from '../lib/privacy.js';
import { recordChange, notify, historyFor } from '../lib/audit.js';
import { badRequest, forbidden, notFound, conflict } from '../lib/errors.js';
import { bumpGraphVersion } from '../engine/graph.js';

const router = new Router();

/** Loads both endpoints, checking the viewer may see them. */
function loadEndpoints(ctx, fromId, toId) {
  const from = get(`SELECT * FROM persons WHERE public_id = ?`, fromId);
  const to = get(`SELECT * FROM persons WHERE public_id = ?`, toId);
  if (!from || !to) throw notFound('One of the people was not found.');
  if (!canViewPerson(ctx.user, from) || !canViewPerson(ctx.user, to)) {
    throw notFound('One of the people was not found.');
  }
  return { from, to };
}

/** A relationship touches two trees; the actor needs standing in both. */
function requireStanding(ctx, from, to, required) {
  const levelFrom = accessLevel(ctx.user, from.created_by_user_id);
  const levelTo = accessLevel(ctx.user, to.created_by_user_id);
  if (!atLeast(levelFrom, required) || !atLeast(levelTo, required)) {
    throw forbidden(
      `You need ${required} access on both trees to do that. You have ${levelFrom} and ${levelTo}.`
    );
  }
}

// ------------------------------------------------------------------ list ---

router.get('/', async (ctx) => {
  const { page, pageSize, offset } = parsePagination(ctx.query, { defaultSize: 50 });
  const filters = [];
  const params = [];

  if (ctx.query.status) { filters.push('r.status = ?'); params.push(ctx.query.status); }
  if (ctx.query.type) { filters.push('r.type = ?'); params.push(ctx.query.type); }
  if (ctx.query.person) {
    const person = get(`SELECT id FROM persons WHERE public_id = ?`, ctx.query.person);
    if (!person) throw notFound('Person not found.');
    filters.push('(r.from_person_id = ? OR r.to_person_id = ?)');
    params.push(person.id, person.id);
  }

  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = all(
    `SELECT r.* FROM relationships r ${where}
     ORDER BY r.created_at DESC LIMIT ? OFFSET ?`,
    ...params, pageSize, offset
  );

  // Only return edges where the viewer can see both endpoints.
  const visible = rows.filter((r) => {
    const from = get(`SELECT * FROM persons WHERE id = ?`, r.from_person_id);
    const to = get(`SELECT * FROM persons WHERE id = ?`, r.to_person_id);
    return from && to && canViewPerson(ctx.user, from) && canViewPerson(ctx.user, to);
  });

  return {
    relationships: visible.map((r) => viewRelationship(r)),
    page, pageSize,
  };
});

// ---------------------------------------------------------------- create ---

router.post('/', async (ctx) => {
  const input = validate(ctx.body, {
    fromPersonId: { type: 'string', required: true, maxLength: 64, label: 'First person' },
    toPersonId: { type: 'string', required: true, maxLength: 64, label: 'Second person' },
    // 'child' is sugar for a parent edge in the opposite direction.
    type: { type: 'enum', required: true, values: ['parent', 'child', 'spouse', 'sibling'], label: 'Relationship type' },
    subtype: {
      type: 'enum',
      values: ['biological', 'adoptive', 'step', 'foster', 'guardian',
        'married', 'partner', 'divorced', 'widowed', 'full', 'half', 'unknown'],
    },
    startDate: { type: 'date' },
    endDate: { type: 'date' },
    notes: { type: 'string', maxLength: 1000 },
  });

  const { from, to } = loadEndpoints(ctx, input.fromPersonId, input.toPersonId);
  requireStanding(ctx, from, to, 'suggester');

  const spec =
    input.type === 'child'
      ? { fromPersonId: to.id, toPersonId: from.id, type: 'parent' }
      : { fromPersonId: from.id, toPersonId: to.id, type: input.type };

  const relationship = createRelationship(
    { ...spec, subtype: input.subtype, startDate: input.startDate, endDate: input.endDate, notes: input.notes },
    { actor: ctx.user, ip: ctx.ip, source: 'user' }
  );

  // Notify the other tree's owner when a relationship crosses trees.
  if (from.created_by_user_id !== to.created_by_user_id) {
    const otherOwner = from.created_by_user_id === ctx.user.id
      ? to.created_by_user_id
      : from.created_by_user_id;
    notify({
      userId: otherOwner,
      type: 'relationship',
      severity: 'info',
      title: 'A relationship was proposed involving your tree',
      body: `${ctx.user.displayName} proposed: ${relationshipLabel(relationship)}. It is unverified until you confirm it.`,
      link: '#/verifications',
    });
  }

  return { __status: 201, relationship: viewRelationship(relationship) };
});

// ------------------------------------------------------------------ read ---

router.get('/:id', async (ctx) => {
  const relationship = get(`SELECT * FROM relationships WHERE public_id = ?`, ctx.params.id);
  if (!relationship) throw notFound('Relationship not found.');
  const from = get(`SELECT * FROM persons WHERE id = ?`, relationship.from_person_id);
  const to = get(`SELECT * FROM persons WHERE id = ?`, relationship.to_person_id);
  if (!canViewPerson(ctx.user, from) || !canViewPerson(ctx.user, to)) throw notFound('Relationship not found.');

  return {
    relationship: viewRelationship(relationship),
    history: historyFor('relationship', relationship.id, 50).map((h) => ({
      action: h.action, field: h.field, oldValue: h.old_value, newValue: h.new_value,
      actor: h.actor_name ?? h.actor_label ?? 'system', at: h.created_at, detail: h.detail,
    })),
  };
});

// --------------------------------------------------------------- verify ----

/**
 * Direct status change. Only someone with verifier standing on BOTH trees may
 * mark an edge verified -- which, for a cross-tree edge, means the two owners
 * must already have granted each other that role. Otherwise the caller must go
 * through a verification request.
 */
router.patch('/:id', async (ctx) => {
  const relationship = get(`SELECT * FROM relationships WHERE public_id = ?`, ctx.params.id);
  if (!relationship) throw notFound('Relationship not found.');

  const input = validate(ctx.body, {
    status: { type: 'enum', values: ['unverified', 'possible', 'verified', 'rejected'], required: true },
    reason: { type: 'string', maxLength: 500 },
    subtype: {
      type: 'enum',
      values: ['biological', 'adoptive', 'step', 'foster', 'guardian',
        'married', 'partner', 'divorced', 'widowed', 'full', 'half', 'unknown'],
    },
    notes: { type: 'string', maxLength: 1000 },
  });

  const from = get(`SELECT * FROM persons WHERE id = ?`, relationship.from_person_id);
  const to = get(`SELECT * FROM persons WHERE id = ?`, relationship.to_person_id);

  if (input.status === 'verified') {
    if (!canVerifyOnTree(ctx.user, from.created_by_user_id) || !canVerifyOnTree(ctx.user, to.created_by_user_id)) {
      throw forbidden(
        'Verifying this relationship needs verifier access on both family trees. Send a verification request instead.'
      );
    }
    if (relationship.status === 'verified') throw conflict('This relationship is already verified.');
  } else {
    requireStanding(ctx, from, to, 'editor');
  }

  if (input.subtype || input.notes !== undefined) {
    run(
      `UPDATE relationships SET subtype = COALESCE(?, subtype), notes = COALESCE(?, notes),
       updated_at = datetime('now') WHERE id = ?`,
      input.subtype ?? null, input.notes ?? null, relationship.id
    );
  }

  const updated = setRelationshipStatus(relationship, input.status, {
    actor: ctx.user, ip: ctx.ip, reason: input.reason,
  });

  if (input.status === 'verified') {
    const owners = new Set([from.created_by_user_id, to.created_by_user_id]);
    owners.delete(ctx.user.id);
    for (const owner of owners) {
      notify({
        userId: owner, type: 'relationship', severity: 'success',
        title: 'A relationship was verified',
        body: `${relationshipLabel(updated)} is now a verified connection in your tree.`,
        link: '#/tree',
      });
    }
  }

  return { relationship: viewRelationship(updated) };
});

// --------------------------------------------- request human verification ---

router.post('/:id/request-verification', async (ctx) => {
  const relationship = get(`SELECT * FROM relationships WHERE public_id = ?`, ctx.params.id);
  if (!relationship) throw notFound('Relationship not found.');
  if (relationship.status === 'verified') throw conflict('This relationship is already verified.');

  const input = validate(ctx.body, { message: { type: 'string', maxLength: 1000 } });

  const from = get(`SELECT * FROM persons WHERE id = ?`, relationship.from_person_id);
  const to = get(`SELECT * FROM persons WHERE id = ?`, relationship.to_person_id);
  requireStanding(ctx, from, to, 'suggester');

  // The request goes to whichever tree owner is not the requester.
  const owners = [from.created_by_user_id, to.created_by_user_id].filter((id) => id !== ctx.user.id);
  const assignedTo = owners[0] ?? from.created_by_user_id;

  const existing = get(
    `SELECT id FROM verification_requests
     WHERE subject_type = 'relationship' AND subject_id = ? AND status = 'open'`,
    relationship.id
  );
  if (existing) throw conflict('A verification request for this relationship is already open.');

  const result = transaction(() => {
    const insert = run(
      `INSERT INTO verification_requests (public_id, subject_type, subject_id, requested_by, assigned_to, message)
       VALUES (?, 'relationship', ?, ?, ?, ?)`,
      newPublicId(), relationship.id, ctx.user.id, assignedTo, input.message ?? null
    );
    setRelationshipStatus(relationship, 'verification_requested', { actor: ctx.user, ip: ctx.ip });
    recordChange({
      actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
      entityType: 'verification', entityId: insert.lastInsertRowid,
      entityLabel: relationshipLabel(relationship),
      action: 'Verification Requested', ip: ctx.ip,
    });
    return get(`SELECT * FROM verification_requests WHERE id = ?`, insert.lastInsertRowid);
  });

  notify({
    userId: assignedTo, type: 'verification', severity: 'warning',
    title: 'A relationship needs your verification',
    body: `${ctx.user.displayName} asked you to confirm: ${relationshipLabel(relationship)}`,
    link: '#/verifications',
  });

  return {
    __status: 201,
    verificationRequest: { id: result.public_id, status: result.status, assignedTo, createdAt: result.created_at },
  };
});

// ---------------------------------------------------------------- delete ---

router.delete('/:id', async (ctx) => {
  const relationship = get(`SELECT * FROM relationships WHERE public_id = ?`, ctx.params.id);
  if (!relationship) throw notFound('Relationship not found.');

  const from = get(`SELECT * FROM persons WHERE id = ?`, relationship.from_person_id);
  const to = get(`SELECT * FROM persons WHERE id = ?`, relationship.to_person_id);
  requireStanding(ctx, from, to, 'editor');

  if (relationship.status === 'verified' &&
      !canVerifyOnTree(ctx.user, from.created_by_user_id)) {
    throw forbidden('Removing a verified relationship needs verifier access.');
  }

  const label = relationshipLabel(relationship);
  run(`DELETE FROM relationships WHERE id = ?`, relationship.id);
  bumpGraphVersion();

  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'relationship', entityId: relationship.id, entityLabel: label,
    action: 'Relationship Removed', oldValue: `${relationship.type} (${relationship.status})`, ip: ctx.ip,
  });

  return { ok: true, removed: label };
});

export default router;
