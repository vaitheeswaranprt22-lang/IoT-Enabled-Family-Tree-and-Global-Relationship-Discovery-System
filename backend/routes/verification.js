/**
 * Verification workflow -- the gate every uncertain connection must pass.
 *
 *      Possible Match / Unverified relationship
 *              |
 *              v
 *      Verification Requested   (someone asks for confirmation)
 *              |
 *              v
 *      Authorised user reviews the evidence
 *              |
 *      +-------+-------+
 *      |               |
 *   Approve          Reject
 *      |               |
 *      v               v
 *  Verified edge   Rejected, recorded with a reason
 *
 * This module is the ONLY place that turns a suggestion into a verified
 * relationship or performs a duplicate merge.
 */
import { Router } from '../lib/http.js';
import { validate, parsePagination } from '../lib/validate.js';
import { all, get, run, transaction } from '../db/index.js';
import {
  setRelationshipStatus, mergePersons, viewRelationship, relationshipLabel, createRelationship,
} from '../lib/person-service.js';
import { viewPerson, canVerifyOnTree, accessLevel, atLeast } from '../lib/privacy.js';
import { recordChange, notify } from '../lib/audit.js';
import { notFound, forbidden, conflict, badRequest } from '../lib/errors.js';

const router = new Router();

/** Expands a request into the thing it is actually about. */
function describeSubject(ctx, request) {
  if (request.subject_type === 'relationship') {
    const relationship = get(`SELECT * FROM relationships WHERE id = ?`, request.subject_id);
    if (!relationship) return { kind: 'relationship', missing: true };
    return {
      kind: 'relationship',
      relationship: viewRelationship(relationship),
      label: relationshipLabel(relationship),
      currentStatus: relationship.status,
    };
  }

  if (request.subject_type === 'match') {
    const match = get(`SELECT * FROM match_suggestions WHERE id = ?`, request.subject_id);
    if (!match) return { kind: 'match', missing: true };
    const a = get(`SELECT * FROM persons WHERE id = ?`, match.person_a_id);
    const b = get(`SELECT * FROM persons WHERE id = ?`, match.person_b_id);
    let evidence = { factors: [], conflicts: [] };
    try {
      const parsed = JSON.parse(match.evidence);
      evidence = Array.isArray(parsed) ? { factors: parsed, conflicts: [] } : parsed;
    } catch { /* default */ }

    return {
      kind: 'match',
      matchKind: match.kind,
      score: match.score,
      band: match.band,
      rationale: match.rationale,
      evidence: evidence.factors ?? [],
      conflicts: evidence.conflicts ?? [],
      personA: a ? viewPerson(ctx.user, a) : null,
      personB: b ? viewPerson(ctx.user, b) : null,
      label: a && b ? `${a.display_name} / ${b.display_name}` : 'Unknown pair',
      sameTree: a && b ? a.created_by_user_id === b.created_by_user_id : false,
    };
  }

  return { kind: request.subject_type, label: `#${request.subject_id}` };
}

function viewRequest(ctx, request) {
  const requester = get(`SELECT public_id, display_name FROM users WHERE id = ?`, request.requested_by);
  const assignee = request.assigned_to
    ? get(`SELECT public_id, display_name FROM users WHERE id = ?`, request.assigned_to)
    : null;

  return {
    id: request.public_id,
    subjectType: request.subject_type,
    subject: describeSubject(ctx, request),
    status: request.status,
    message: request.message,
    decisionNote: request.decision_note,
    requestedBy: requester ? { id: requester.public_id, name: requester.display_name } : null,
    assignedTo: assignee ? { id: assignee.public_id, name: assignee.display_name } : null,
    decidedAt: request.decided_at,
    createdAt: request.created_at,
    isMine: request.requested_by === ctx.user.id,
    canDecide: request.assigned_to === ctx.user.id || ctx.user.role === 'admin',
  };
}

// ------------------------------------------------------------------ list ---

router.get('/', async (ctx) => {
  const { page, pageSize, offset } = parsePagination(ctx.query, { defaultSize: 25 });
  const box = ctx.query.box ?? 'incoming';     // incoming | outgoing | all
  const status = ctx.query.status ?? 'open';

  const filters = [];
  const params = [];

  if (box === 'incoming') { filters.push('assigned_to = ?'); params.push(ctx.user.id); }
  else if (box === 'outgoing') { filters.push('requested_by = ?'); params.push(ctx.user.id); }
  else { filters.push('(assigned_to = ? OR requested_by = ?)'); params.push(ctx.user.id, ctx.user.id); }

  if (status !== 'all') { filters.push('status = ?'); params.push(status); }

  const where = filters.join(' AND ');
  const total = get(`SELECT COUNT(*) AS n FROM verification_requests WHERE ${where}`, ...params)?.n ?? 0;
  const rows = all(
    `SELECT * FROM verification_requests WHERE ${where}
     ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC
     LIMIT ? OFFSET ?`,
    ...params, pageSize, offset
  );

  return {
    requests: rows.map((r) => viewRequest(ctx, r)),
    page, pageSize, total,
    counts: {
      incomingOpen: get(
        `SELECT COUNT(*) AS n FROM verification_requests WHERE assigned_to = ? AND status = 'open'`,
        ctx.user.id
      )?.n ?? 0,
      outgoingOpen: get(
        `SELECT COUNT(*) AS n FROM verification_requests WHERE requested_by = ? AND status = 'open'`,
        ctx.user.id
      )?.n ?? 0,
    },
  };
});

router.get('/:id', async (ctx) => {
  const request = get(`SELECT * FROM verification_requests WHERE public_id = ?`, ctx.params.id);
  if (!request) throw notFound('Verification request not found.');
  if (request.requested_by !== ctx.user.id && request.assigned_to !== ctx.user.id && ctx.user.role !== 'admin') {
    throw forbidden('This verification request is not addressed to you.');
  }
  return { request: viewRequest(ctx, request) };
});

// --------------------------------------------------------------- approve ---

function loadDecidable(ctx, publicId) {
  const request = get(`SELECT * FROM verification_requests WHERE public_id = ?`, publicId);
  if (!request) throw notFound('Verification request not found.');
  if (request.status !== 'open') throw conflict(`This request was already ${request.status}.`);
  if (request.assigned_to !== ctx.user.id && ctx.user.role !== 'admin') {
    throw forbidden('Only the person this request is addressed to can decide it.');
  }
  return request;
}

router.post('/:id/approve', async (ctx) => {
  const request = loadDecidable(ctx, ctx.params.id);
  const input = validate(ctx.body, {
    note: { type: 'string', maxLength: 1000 },
    // For a duplicate merge: which record survives.
    survivingPersonId: { type: 'string', maxLength: 64 },
    // For a cross-tree connection: the relationship to create.
    relationshipType: { type: 'enum', values: ['parent', 'child', 'spouse', 'sibling'] },
    relationshipSubtype: {
      type: 'enum',
      values: ['biological', 'adoptive', 'step', 'foster', 'guardian',
        'married', 'partner', 'divorced', 'widowed', 'full', 'half', 'unknown'],
    },
  });

  const outcome = transaction(() => {
    if (request.subject_type === 'relationship') return approveRelationship(ctx, request, input);
    if (request.subject_type === 'match') return approveMatch(ctx, request, input);
    throw badRequest(`Cannot approve a request of type "${request.subject_type}".`);
  });

  run(
    `UPDATE verification_requests
     SET status = 'approved', decided_by = ?, decided_at = datetime('now'), decision_note = ?
     WHERE id = ?`,
    ctx.user.id, input.note ?? null, request.id
  );

  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'verification', entityId: request.id, entityLabel: outcome.label,
    action: 'Verification Approved', oldValue: 'open', newValue: 'approved',
    detail: input.note ?? null, ip: ctx.ip,
  });

  notify({
    userId: request.requested_by, type: 'verification', severity: 'success',
    title: 'Your verification request was approved',
    body: outcome.message,
    link: outcome.link ?? '#/tree',
  });

  return { ok: true, status: 'approved', ...outcome };
});

/** Promotes the relationship edge to 'verified'. */
function approveRelationship(ctx, request, input) {
  const relationship = get(`SELECT * FROM relationships WHERE id = ?`, request.subject_id);
  if (!relationship) throw notFound('The relationship in this request no longer exists.');

  const from = get(`SELECT * FROM persons WHERE id = ?`, relationship.from_person_id);
  const to = get(`SELECT * FROM persons WHERE id = ?`, relationship.to_person_id);

  // The approver must hold verifier standing on the tree they own.
  const ownsFrom = from.created_by_user_id === ctx.user.id;
  const ownsTo = to.created_by_user_id === ctx.user.id;
  if (!ownsFrom && !ownsTo && ctx.user.role !== 'admin') {
    throw forbidden('You do not own either of the trees this relationship touches.');
  }

  const updated = setRelationshipStatus(relationship, 'verified', { actor: ctx.user, ip: ctx.ip });
  const label = relationshipLabel(updated);

  return {
    label,
    message: `"${label}" is now a verified relationship and will be used in relationship discovery.`,
    relationship: viewRelationship(updated),
    link: '#/tree',
  };
}

/**
 * Does the pair (requester, approver) between them cover both trees?
 *
 * A tree is covered when one of the two people is its owner, holds editor
 * rights on it, or is a site administrator. Since the requester consented by
 * proposing the match and the approver is consenting now, covering both trees
 * means both families have agreed -- which is the authorisation this workflow
 * is designed to establish.
 */
function bothTreesConsented(ctx, request, personA, personB) {
  const approver = ctx.user;
  const requester = get(
    `SELECT id, role FROM users WHERE id = ? AND status = 'active'`,
    request.requested_by
  );

  const covers = (actor, ownerUserId) => {
    if (!actor) return false;
    if (actor.id === ownerUserId) return true;
    if (actor.role === 'admin') return true;
    return atLeast(accessLevel(actor, ownerUserId), 'editor');
  };

  const covered = (ownerUserId) =>
    covers(approver, ownerUserId) || covers(requester, ownerUserId);

  return covered(personA.created_by_user_id) && covered(personB.created_by_user_id);
}

/**
 * Approving a match either merges two duplicate person records or creates the
 * relationship that joins two trees. Both are irreversible in the graph sense,
 * which is exactly why they live behind this approval step.
 */
function approveMatch(ctx, request, input) {
  const match = get(`SELECT * FROM match_suggestions WHERE id = ?`, request.subject_id);
  if (!match) throw notFound('The possible match in this request no longer exists.');

  const a = get(`SELECT * FROM persons WHERE id = ?`, match.person_a_id);
  const b = get(`SELECT * FROM persons WHERE id = ?`, match.person_b_id);
  if (!a || !b) throw notFound('One of the people in this match no longer exists.');

  run(
    `UPDATE match_suggestions
     SET status = 'accepted', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ?
     WHERE id = ?`,
    ctx.user.id, input.note ?? null, match.id
  );

  if (match.kind === 'duplicate') {
    // Decide which record survives: the caller's choice, else the one with
    // more relationships, else the older record.
    let survivor = a;
    let duplicate = b;
    if (input.survivingPersonId) {
      if (input.survivingPersonId === b.public_id) { survivor = b; duplicate = a; }
      else if (input.survivingPersonId !== a.public_id) {
        throw badRequest('survivingPersonId must be one of the two people in this match.');
      }
    } else {
      const edgesA = get(`SELECT COUNT(*) AS n FROM relationships WHERE from_person_id = ? OR to_person_id = ?`, a.id, a.id)?.n ?? 0;
      const edgesB = get(`SELECT COUNT(*) AS n FROM relationships WHERE from_person_id = ? OR to_person_id = ?`, b.id, b.id)?.n ?? 0;
      if (edgesB > edgesA) { survivor = b; duplicate = a; }
    }

    // Authorisation for a cross-tree merge rests on BOTH owners having
    // consented -- one by proposing the match, the other by approving it here.
    // Requiring the approver to separately hold editor rights on the other
    // person's tree would make the workflow impossible between strangers,
    // which is precisely the case it exists to serve.
    if (!bothTreesConsented(ctx, request, survivor, duplicate)) {
      throw forbidden(
        'Merging these records needs the agreement of both family trees. Ask the other tree’s owner to propose or approve it.'
      );
    }

    const merged = mergePersons(survivor, duplicate, {
      actor: ctx.user, ip: ctx.ip, matchId: match.id, matchPublicId: match.public_id,
    });

    return {
      label: `${survivor.display_name} (merged)`,
      merged: true,
      survivingPerson: viewPerson(ctx.user, merged),
      mergedPersonId: duplicate.public_id,
      message: `"${duplicate.display_name}" was merged into "${survivor.display_name}". Their relationships and events moved across.`,
      link: `#/person/${merged.public_id}`,
    };
  }

  // kind = 'connection' or 'relationship': create the joining edge, verified.
  const type = input.relationshipType ?? match.suggested_relationship ?? 'sibling';
  const relationship = createRelationship(
    {
      fromPersonId: a.id,
      toPersonId: b.id,
      type: type === 'child' ? 'parent' : type,
      subtype: input.relationshipSubtype,
      status: 'verified',
    },
    { actor: ctx.user, ip: ctx.ip, source: 'match', allowDirectVerify: true }
  );

  return {
    label: relationshipLabel(relationship),
    merged: false,
    connected: true,
    relationship: viewRelationship(relationship),
    message: `The two family branches are now connected: ${relationshipLabel(relationship)}.`,
    link: '#/tree',
  };
}

// ---------------------------------------------------------------- reject ---

router.post('/:id/reject', async (ctx) => {
  const request = loadDecidable(ctx, ctx.params.id);
  const input = validate(ctx.body, {
    note: { type: 'string', maxLength: 1000, required: true, label: 'Reason' },
  });

  const subject = describeSubject(ctx, request);

  transaction(() => {
    run(
      `UPDATE verification_requests
       SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decision_note = ?
       WHERE id = ?`,
      ctx.user.id, input.note, request.id
    );

    if (request.subject_type === 'relationship') {
      const relationship = get(`SELECT * FROM relationships WHERE id = ?`, request.subject_id);
      if (relationship) {
        setRelationshipStatus(relationship, 'rejected', {
          actor: ctx.user, ip: ctx.ip, reason: input.note,
        });
      }
    } else if (request.subject_type === 'match') {
      run(
        `UPDATE match_suggestions
         SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ?
         WHERE id = ?`,
        ctx.user.id, input.note, request.subject_id
      );
    }

    recordChange({
      actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
      entityType: 'verification', entityId: request.id, entityLabel: subject.label ?? 'request',
      action: 'Verification Rejected', oldValue: 'open', newValue: 'rejected',
      detail: input.note, ip: ctx.ip,
    });
  });

  notify({
    userId: request.requested_by, type: 'verification', severity: 'warning',
    title: 'Your verification request was rejected',
    body: `${ctx.user.displayName} did not confirm this: "${input.note}"`,
    link: '#/verifications',
  });

  return {
    ok: true,
    status: 'rejected',
    message: 'Recorded. Nothing was connected or merged.',
  };
});

// -------------------------------------------------------------- withdraw ---

router.post('/:id/withdraw', async (ctx) => {
  const request = get(`SELECT * FROM verification_requests WHERE public_id = ?`, ctx.params.id);
  if (!request) throw notFound('Verification request not found.');
  if (request.requested_by !== ctx.user.id) throw forbidden('Only the requester can withdraw a request.');
  if (request.status !== 'open') throw conflict(`This request was already ${request.status}.`);

  transaction(() => {
    run(
      `UPDATE verification_requests
       SET status = 'withdrawn', decided_by = ?, decided_at = datetime('now')
       WHERE id = ?`,
      ctx.user.id, request.id
    );
    if (request.subject_type === 'relationship') {
      const relationship = get(`SELECT * FROM relationships WHERE id = ?`, request.subject_id);
      if (relationship && relationship.status === 'verification_requested') {
        setRelationshipStatus(relationship, 'unverified', { actor: ctx.user, ip: ctx.ip });
      }
    } else if (request.subject_type === 'match') {
      run(`UPDATE match_suggestions SET status = 'possible' WHERE id = ? AND status = 'verification_requested'`,
        request.subject_id);
    }
  });

  return { ok: true, status: 'withdrawn' };
});

export default router;
