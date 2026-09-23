/**
 * Possible-match routes.
 *
 * The contract enforced here:
 *   - A scan only ever writes rows with status 'possible'.
 *   - Accepting a match does NOT merge anything. It opens a verification
 *     request that the other tree's owner must approve.
 *   - The merge itself happens only in `verification.js`, after approval.
 *
 * Nothing in this file can create a verified relationship.
 */
import { Router } from '../lib/http.js';
import { validate, parsePagination } from '../lib/validate.js';
import { all, get, run, newPublicId, transaction } from '../db/index.js';
import { scanForMatches, suggestMissingLinks, suggestTreesToExplore, aiStatus } from '../ai/suggest.js';
import { scorePair, relativeNames } from '../engine/matching.js';
import { viewPerson, canViewPerson } from '../lib/privacy.js';
import { recordChange, notify } from '../lib/audit.js';
import { notFound, forbidden, conflict, badRequest } from '../lib/errors.js';
import config from '../config.js';

const router = new Router();

/** Every match involving a person in one of the caller's trees. */
function loadMatch(ctx, publicId) {
  const match = get(`SELECT * FROM match_suggestions WHERE public_id = ?`, publicId);
  if (!match) throw notFound('That possible match was not found.');

  const a = get(`SELECT * FROM persons WHERE id = ?`, match.person_a_id);
  const b = get(`SELECT * FROM persons WHERE id = ?`, match.person_b_id);
  if (!a || !b) throw notFound('One of the people in this match no longer exists.');

  const involvesMe = a.created_by_user_id === ctx.user.id || b.created_by_user_id === ctx.user.id;
  if (!involvesMe && ctx.user.role !== 'admin') {
    throw forbidden('This possible match does not involve your family tree.');
  }
  return { match, a, b };
}

function viewMatch(ctx, match, a, b) {
  let evidence = { factors: [], conflicts: [] };
  try {
    const parsed = JSON.parse(match.evidence);
    evidence = Array.isArray(parsed) ? { factors: parsed, conflicts: [] } : parsed;
  } catch { /* keep the empty default */ }

  return {
    id: match.public_id,
    kind: match.kind,
    score: match.score,
    band: match.band,
    /** Always 'possible' until a human decides. Never auto-promoted. */
    status: match.status,
    source: match.source,
    aiModel: match.ai_model,
    rationale: match.rationale,
    evidence: evidence.factors ?? [],
    conflicts: evidence.conflicts ?? [],
    suggestedRelationship: match.suggested_relationship,
    personA: viewPerson(ctx.user, a),
    personB: viewPerson(ctx.user, b),
    trees: {
      a: treeLabel(a.created_by_user_id, ctx.user.id),
      b: treeLabel(b.created_by_user_id, ctx.user.id),
      sameTree: a.created_by_user_id === b.created_by_user_id,
    },
    reviewedBy: match.reviewed_by ? get(`SELECT display_name FROM users WHERE id = ?`, match.reviewed_by)?.display_name : null,
    reviewedAt: match.reviewed_at,
    reviewNote: match.review_note,
    createdAt: match.created_at,
    requiresHumanVerification: true,
    canDecide:
      a.created_by_user_id === ctx.user.id || b.created_by_user_id === ctx.user.id || ctx.user.role === 'admin',
  };
}

function treeLabel(ownerId, viewerId) {
  const owner = get(`SELECT public_id, display_name FROM users WHERE id = ?`, ownerId);
  return {
    ownerId: owner?.public_id ?? null,
    ownerName: owner?.display_name ?? 'Unknown',
    isMine: ownerId === viewerId,
  };
}

// ------------------------------------------------------------------ list ---

router.get('/', async (ctx) => {
  const { page, pageSize, offset } = parsePagination(ctx.query, { defaultSize: 25 });
  const status = ctx.query.status ?? 'possible';
  const kind = ctx.query.kind;

  const filters = [
    `(pa.created_by_user_id = ? OR pb.created_by_user_id = ?)`,
    `pa.merged_into_id IS NULL`,
    `pb.merged_into_id IS NULL`,
  ];
  const params = [ctx.user.id, ctx.user.id];

  if (status !== 'all') { filters.push('ms.status = ?'); params.push(status); }
  if (kind) { filters.push('ms.kind = ?'); params.push(kind); }
  if (ctx.query.band) { filters.push('ms.band = ?'); params.push(ctx.query.band); }

  const where = filters.join(' AND ');
  const total = get(
    `SELECT COUNT(*) AS n FROM match_suggestions ms
     JOIN persons pa ON pa.id = ms.person_a_id
     JOIN persons pb ON pb.id = ms.person_b_id
     WHERE ${where}`,
    ...params
  )?.n ?? 0;

  const rows = all(
    `SELECT ms.* FROM match_suggestions ms
     JOIN persons pa ON pa.id = ms.person_a_id
     JOIN persons pb ON pb.id = ms.person_b_id
     WHERE ${where}
     ORDER BY ms.score DESC, ms.created_at DESC
     LIMIT ? OFFSET ?`,
    ...params, pageSize, offset
  );

  const matches = [];
  for (const row of rows) {
    const a = get(`SELECT * FROM persons WHERE id = ?`, row.person_a_id);
    const b = get(`SELECT * FROM persons WHERE id = ?`, row.person_b_id);
    if (!a || !b) continue;
    matches.push(viewMatch(ctx, row, a, b));
  }

  return {
    matches, page, pageSize, total,
    totalPages: Math.ceil(total / pageSize),
    thresholds: {
      minScore: config.matching.minScore,
      strongScore: config.matching.strongScore,
      note: 'A high score never merges anything automatically. Every match needs human verification.',
    },
  };
});

// ------------------------------------------------------------------ scan ---

router.post('/scan', async (ctx) => {
  const input = validate(ctx.body, {
    crossTree: { type: 'bool', default: true },
    limit: { type: 'int', min: 1, max: 100, default: config.ai.maxCandidates },
  });

  const result = await scanForMatches(ctx.user, {
    crossTree: input.crossTree,
    persist: true,
    limit: input.limit,
  });

  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'match', entityId: null, entityLabel: 'Match scan',
    action: 'Match Scan Run',
    detail: `${result.suggestions.length} candidate(s) from ${result.scanned} person record(s); mode ${result.mode}.`,
    ip: ctx.ip,
  });

  if (result.suggestions.length) {
    notify({
      userId: ctx.user.id, type: 'match', severity: 'info',
      title: `${result.suggestions.length} possible match(es) found`,
      body: 'Review the evidence for each one. Nothing has been connected or merged.',
      link: '#/matches',
    });
  }

  return {
    ...result,
    ai: aiStatus(),
    message: `${result.suggestions.length} possible match(es) recorded. None of them have been connected -- each needs your review.`,
  };
});

// ------------------------------------------------------------- compare two ---

/** Ad-hoc comparison of any two visible people, without persisting anything. */
router.post('/compare', async (ctx) => {
  const input = validate(ctx.body, {
    personAId: { type: 'string', required: true, maxLength: 64 },
    personBId: { type: 'string', required: true, maxLength: 64 },
  });

  const a = get(`SELECT * FROM persons WHERE public_id = ?`, input.personAId);
  const b = get(`SELECT * FROM persons WHERE public_id = ?`, input.personBId);
  if (!a || !b) throw notFound('One of those people was not found.');
  if (!canViewPerson(ctx.user, a) || !canViewPerson(ctx.user, b)) throw notFound('One of those people was not found.');
  if (a.id === b.id) throw badRequest('Those are the same record.');

  const scored = scorePair(a, b, {
    relativesA: relativeNames(a.id),
    relativesB: relativeNames(b.id),
  });

  return {
    personA: viewPerson(ctx.user, a),
    personB: viewPerson(ctx.user, b),
    ...scored,
    verdict:
      scored.suppressed
        ? 'Conflicting evidence: these are very likely different people.'
        : scored.band === 'strong'
          ? 'Strong similarity -- but still only a Possible Match until a human confirms it.'
          : scored.band === 'possible'
            ? 'Possible Match. Review the evidence.'
            : 'Weak similarity. Probably different people.',
    requiresHumanVerification: true,
  };
});

// ------------------------------------------------------------------ read ---

router.get('/:id', async (ctx) => {
  const { match, a, b } = loadMatch(ctx, ctx.params.id);
  const relA = relativeNames(a.id);
  const relB = relativeNames(b.id);

  return {
    match: viewMatch(ctx, match, a, b),
    context: {
      a: { parents: relA.parents, spouses: relA.spouses, children: relA.children },
      b: { parents: relB.parents, spouses: relB.spouses, children: relB.children },
    },
    openVerification: get(
      `SELECT public_id, status, created_at FROM verification_requests
       WHERE subject_type = 'match' AND subject_id = ? AND status = 'open'`,
      match.id
    ),
  };
});

// ----------------------------------------------------------- human review ---

/**
 * "Accept" records the reviewer's opinion and opens a verification request.
 * It does NOT merge or connect anything by itself -- when the two records sit
 * in different trees, the other owner must approve.
 */
router.post('/:id/accept', async (ctx) => {
  const { match, a, b } = loadMatch(ctx, ctx.params.id);
  if (match.status !== 'possible' && match.status !== 'verification_requested') {
    throw conflict(`This match has already been ${match.status}.`);
  }

  const input = validate(ctx.body, {
    note: { type: 'string', maxLength: 1000 },
    // For a duplicate: which record should survive the merge.
    survivingPersonId: { type: 'string', maxLength: 64 },
  });

  const otherOwnerId = a.created_by_user_id === ctx.user.id ? b.created_by_user_id : a.created_by_user_id;
  const sameOwner = a.created_by_user_id === b.created_by_user_id;

  const result = transaction(() => {
    run(
      `UPDATE match_suggestions
       SET status = 'verification_requested', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ?
       WHERE id = ?`,
      ctx.user.id, input.note ?? null, match.id
    );

    const assignedTo = sameOwner ? ctx.user.id : otherOwnerId;
    const insert = run(
      `INSERT INTO verification_requests
         (public_id, subject_type, subject_id, requested_by, assigned_to, message)
       VALUES (?, 'match', ?, ?, ?, ?)`,
      newPublicId(), match.id, ctx.user.id, assignedTo,
      input.note ?? `Proposed ${match.kind}: "${a.display_name}" and "${b.display_name}".`
    );

    recordChange({
      actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
      entityType: 'match', entityId: match.id,
      entityLabel: `${a.display_name} / ${b.display_name}`,
      action: 'Possible Match Accepted (pending verification)',
      oldValue: match.status, newValue: 'verification_requested',
      detail: input.note ?? null, ip: ctx.ip,
    });

    return { requestId: insert.lastInsertRowid, assignedTo };
  });

  notify({
    userId: result.assignedTo,
    type: 'verification',
    severity: 'warning',
    title: 'A possible match needs verification',
    body: `${ctx.user.displayName} believes "${a.display_name}" and "${b.display_name}" ${match.kind === 'duplicate' ? 'are the same person' : 'connect your family trees'}. Review the evidence to approve or reject.`,
    link: '#/verifications',
  });

  const request = get(`SELECT * FROM verification_requests WHERE id = ?`, result.requestId);

  return {
    ok: true,
    status: 'verification_requested',
    merged: false,
    connected: false,
    message: sameOwner
      ? 'Recorded. Approve the verification request to complete the merge.'
      : `Recorded. The other tree owner has been asked to confirm before anything is connected.`,
    verificationRequest: { id: request.public_id, assignedTo: result.assignedTo, status: request.status },
  };
});

router.post('/:id/reject', async (ctx) => {
  const { match, a, b } = loadMatch(ctx, ctx.params.id);
  const input = validate(ctx.body, { note: { type: 'string', maxLength: 1000 } });

  run(
    `UPDATE match_suggestions
     SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), review_note = ?
     WHERE id = ?`,
    ctx.user.id, input.note ?? null, match.id
  );

  // Close any open verification request for this match.
  run(
    `UPDATE verification_requests
     SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), decision_note = ?
     WHERE subject_type = 'match' AND subject_id = ? AND status = 'open'`,
    ctx.user.id, input.note ?? 'Match rejected by reviewer.', match.id
  );

  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'match', entityId: match.id,
    entityLabel: `${a.display_name} / ${b.display_name}`,
    action: 'Connection Rejected', oldValue: match.status, newValue: 'rejected',
    detail: input.note ?? null, ip: ctx.ip,
  });

  return { ok: true, status: 'rejected', message: 'Recorded. These records will stay separate.' };
});

/** Hides a candidate without judging it -- it will not resurface in scans. */
router.post('/:id/dismiss', async (ctx) => {
  const { match } = loadMatch(ctx, ctx.params.id);
  run(
    `UPDATE match_suggestions SET status = 'dismissed', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`,
    ctx.user.id, match.id
  );
  return { ok: true, status: 'dismissed' };
});

// ------------------------------------------------- AI-assisted suggestions ---

router.get('/suggestions/links', async (ctx) => {
  return {
    suggestions: suggestMissingLinks(ctx.user, { limit: 40 }),
    ai: aiStatus(),
    note: 'These are observations about gaps in your data. None of them change anything until you act on them.',
  };
});

router.get('/suggestions/trees', async (ctx) => {
  return {
    trees: suggestTreesToExplore(ctx.user, { limit: 10 }),
    ai: aiStatus(),
  };
});

router.get('/ai/status', async () => ({ ai: aiStatus() }));

export default router;
