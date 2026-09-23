/**
 * Shared person and relationship write operations.
 *
 * Routes, the seed script and the merge workflow all go through here so that
 * normalisation, cycle checking, audit logging and graph-cache invalidation
 * happen exactly once and cannot be skipped.
 */
import { run, get, all, newPublicId } from '../db/index.js';
import { normalizeName, phoneticKey, buildDisplayName, yearOf } from './text.js';
import { recordChange } from './audit.js';
import { bumpGraphVersion, loadGraph, wouldCreateCycle } from '../engine/graph.js';
import { conflict, badRequest, notFound } from './errors.js';

/** Fields a client is allowed to set on a person. */
export const PERSON_FIELDS = [
  'given_name', 'middle_name', 'family_name', 'maiden_name', 'gender',
  'birth_date', 'birth_precision', 'birth_place',
  'death_date', 'death_precision', 'death_place', 'is_living',
  'occupation', 'current_place', 'notes', 'visibility',
];

/**
 * Creates a person record.
 * @param {object} input   snake_case column values
 * @param {object} meta    { ownerUserId, actor, ip, isSynthetic, dataLabel }
 */
export function createPerson(input, meta) {
  const givenName = (input.given_name ?? '').trim();
  if (!givenName) throw badRequest('A first name is required.');

  const displayName = buildDisplayName({
    givenName,
    middleName: input.middle_name,
    familyName: input.family_name,
  });

  const publicId = newPublicId();
  const isLiving = input.is_living !== undefined
    ? (input.is_living ? 1 : 0)
    : (input.death_date ? 0 : 1);

  const result = run(
    `INSERT INTO persons
       (public_id, created_by_user_id, given_name, middle_name, family_name, maiden_name,
        display_name, name_normalized, name_phonetic, gender,
        birth_date, birth_precision, birth_year, birth_place,
        death_date, death_precision, death_place, is_living,
        occupation, current_place, notes, visibility, is_synthetic, data_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    publicId,
    meta.ownerUserId,
    givenName,
    input.middle_name ?? null,
    input.family_name ?? null,
    input.maiden_name ?? null,
    displayName,
    normalizeName(displayName),
    phoneticKey(displayName),
    input.gender ?? 'unknown',
    input.birth_date ?? null,
    input.birth_precision ?? (input.birth_date ? 'exact' : 'unknown'),
    input.birth_year ?? yearOf(input.birth_date),
    input.birth_place ?? null,
    input.death_date ?? null,
    input.death_precision ?? (input.death_date ? 'exact' : 'unknown'),
    input.death_place ?? null,
    isLiving,
    input.occupation ?? null,
    input.current_place ?? null,
    input.notes ?? null,
    input.visibility ?? 'family',
    meta.isSynthetic ? 1 : 0,
    meta.dataLabel ?? null
  );

  const person = get(`SELECT * FROM persons WHERE id = ?`, result.lastInsertRowid);

  recordChange({
    actorUserId: meta.actor?.id ?? null,
    actorLabel: meta.actor?.displayName ?? 'system',
    entityType: 'person',
    entityId: person.id,
    entityLabel: person.display_name,
    action: 'Person Added',
    newValue: person.display_name,
    detail: meta.detail ?? null,
    ip: meta.ip ?? null,
  });

  return person;
}

/** Applies a partial update, writing one history row per changed field. */
export function updatePerson(person, changes, meta) {
  const updates = {};
  for (const field of PERSON_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(changes, field)) updates[field] = changes[field];
  }
  if (!Object.keys(updates).length) return person;

  // Recompute derived columns when a name part changes.
  const nameChanged = ['given_name', 'middle_name', 'family_name'].some((f) => f in updates);
  if (nameChanged) {
    const displayName = buildDisplayName({
      givenName: updates.given_name ?? person.given_name,
      middleName: 'middle_name' in updates ? updates.middle_name : person.middle_name,
      familyName: 'family_name' in updates ? updates.family_name : person.family_name,
    });
    updates.display_name = displayName;
    updates.name_normalized = normalizeName(displayName);
    updates.name_phonetic = phoneticKey(displayName);
  }
  if ('birth_date' in updates) updates.birth_year = yearOf(updates.birth_date);
  if ('death_date' in updates && updates.death_date) updates.is_living = 0;
  if ('is_living' in updates) updates.is_living = updates.is_living ? 1 : 0;

  const columns = Object.keys(updates);
  run(
    `UPDATE persons SET ${columns.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now')
     WHERE id = ?`,
    ...columns.map((c) => updates[c]),
    person.id
  );

  for (const column of columns) {
    if (['display_name', 'name_normalized', 'name_phonetic', 'birth_year'].includes(column)) continue;
    const before = person[column];
    const after = updates[column];
    if (String(before ?? '') === String(after ?? '')) continue;
    recordChange({
      actorUserId: meta.actor?.id ?? null,
      actorLabel: meta.actor?.displayName ?? 'system',
      entityType: 'person',
      entityId: person.id,
      entityLabel: person.display_name,
      action: 'Person Updated',
      field: column,
      oldValue: before,
      newValue: after,
      ip: meta.ip ?? null,
    });
  }

  return get(`SELECT * FROM persons WHERE id = ?`, person.id);
}

// --------------------------------------------------------- relationships ---

/** Symmetric edge types are stored once, always low id -> high id. */
function canonicalPair(type, aId, bId) {
  if (type === 'parent') return [aId, bId];
  return aId < bId ? [aId, bId] : [bId, aId];
}

/**
 * Creates a relationship edge.
 *
 * @param {object} input { fromPersonId, toPersonId, type, subtype, status, notes, startDate, endDate }
 * @param {object} meta  { actor, ip, source }
 *
 * `status` defaults to 'unverified'. Nothing here may write 'verified'
 * directly unless `meta.allowDirectVerify` is set, which only the seed script
 * and an explicit human approval path use.
 */
export function createRelationship(input, meta) {
  const { type } = input;
  let { fromPersonId, toPersonId } = input;

  if (fromPersonId === toPersonId) throw badRequest('A person cannot be related to themselves.');

  const from = get(`SELECT * FROM persons WHERE id = ?`, fromPersonId);
  const to = get(`SELECT * FROM persons WHERE id = ?`, toPersonId);
  if (!from || !to) throw notFound('One of the people in this relationship was not found.');

  if (type === 'parent') {
    // Guard against making someone their own ancestor.
    const graph = loadGraph({ statuses: ['verified', 'unverified'] });
    if (wouldCreateCycle(graph, fromPersonId, toPersonId)) {
      throw conflict(
        `${from.display_name} cannot be a parent of ${to.display_name}: that would make them their own ancestor.`
      );
    }
    // A child may not have more than two parents of the same subtype chain.
    const existingParents = all(
      `SELECT r.id, p.display_name FROM relationships r
       JOIN persons p ON p.id = r.from_person_id
       WHERE r.to_person_id = ? AND r.type = 'parent' AND r.status <> 'rejected'`,
      toPersonId
    );
    if (existingParents.length >= 4) {
      throw conflict(`${to.display_name} already has ${existingParents.length} parent records.`);
    }
  } else {
    [fromPersonId, toPersonId] = canonicalPair(type, fromPersonId, toPersonId);
  }

  const existing = get(
    `SELECT * FROM relationships WHERE from_person_id = ? AND to_person_id = ? AND type = ?`,
    fromPersonId, toPersonId, type
  );
  if (existing) {
    throw conflict('That relationship already exists.', {
      relationshipId: existing.public_id,
      status: existing.status,
    });
  }

  const status = meta.allowDirectVerify && input.status ? input.status : (input.status ?? 'unverified');
  if (status === 'verified' && !meta.allowDirectVerify) {
    throw badRequest('A relationship cannot be created as verified. Create it, then request verification.');
  }

  const publicId = newPublicId();
  const result = run(
    `INSERT INTO relationships
       (public_id, from_person_id, to_person_id, type, subtype, status, confidence,
        source, start_date, end_date, notes, created_by, verified_by, verified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    publicId,
    fromPersonId,
    toPersonId,
    type,
    input.subtype ?? defaultSubtype(type),
    status,
    input.confidence ?? 1.0,
    meta.source ?? 'user',
    input.startDate ?? null,
    input.endDate ?? null,
    input.notes ?? null,
    meta.actor?.id ?? null,
    status === 'verified' ? (meta.actor?.id ?? null) : null,
    status === 'verified' ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null
  );

  bumpGraphVersion();

  const relationship = get(`SELECT * FROM relationships WHERE id = ?`, result.lastInsertRowid);

  recordChange({
    actorUserId: meta.actor?.id ?? null,
    actorLabel: meta.actor?.displayName ?? 'system',
    entityType: 'relationship',
    entityId: relationship.id,
    entityLabel: `${from.display_name} -> ${to.display_name}`,
    action: status === 'verified' ? 'Relationship Verified' : 'Relationship Suggested',
    newValue: `${type}/${relationship.subtype} (${status})`,
    ip: meta.ip ?? null,
  });

  return relationship;
}

function defaultSubtype(type) {
  if (type === 'parent') return 'biological';
  if (type === 'spouse') return 'married';
  return 'full';
}

/** Changes a relationship's verification status, with an audit entry. */
export function setRelationshipStatus(relationship, status, meta) {
  const previous = relationship.status;
  run(
    `UPDATE relationships
     SET status = ?, verified_by = ?, verified_at = ?, rejected_reason = ?, updated_at = datetime('now')
     WHERE id = ?`,
    status,
    status === 'verified' ? (meta.actor?.id ?? null) : null,
    status === 'verified' ? new Date().toISOString().replace('T', ' ').slice(0, 19) : null,
    status === 'rejected' ? (meta.reason ?? null) : null,
    relationship.id
  );

  bumpGraphVersion();

  const ACTIONS = {
    verified: 'Relationship Verified',
    rejected: 'Connection Rejected',
    verification_requested: 'Verification Requested',
    possible: 'Relationship Marked Possible',
    unverified: 'Relationship Unverified',
  };

  recordChange({
    actorUserId: meta.actor?.id ?? null,
    actorLabel: meta.actor?.displayName ?? 'system',
    entityType: 'relationship',
    entityId: relationship.id,
    entityLabel: relationshipLabel(relationship),
    action: ACTIONS[status] ?? 'Relationship Updated',
    field: 'status',
    oldValue: previous,
    newValue: status,
    detail: meta.reason ?? null,
    ip: meta.ip ?? null,
  });

  return get(`SELECT * FROM relationships WHERE id = ?`, relationship.id);
}

export function relationshipLabel(relationship) {
  const from = get(`SELECT display_name FROM persons WHERE id = ?`, relationship.from_person_id);
  const to = get(`SELECT display_name FROM persons WHERE id = ?`, relationship.to_person_id);
  const arrow = relationship.type === 'parent' ? 'is parent of' : `is ${relationship.type} of`;
  return `${from?.display_name ?? '?'} ${arrow} ${to?.display_name ?? '?'}`;
}

/** Serialises a relationship for the API. */
export function viewRelationship(relationship, { includeNames = true } = {}) {
  const base = {
    id: relationship.public_id,
    type: relationship.type,
    subtype: relationship.subtype,
    status: relationship.status,
    confidence: relationship.confidence,
    source: relationship.source,
    startDate: relationship.start_date,
    endDate: relationship.end_date,
    notes: relationship.notes,
    verifiedAt: relationship.verified_at,
    rejectedReason: relationship.rejected_reason,
    createdAt: relationship.created_at,
  };
  if (!includeNames) return base;

  const from = get(`SELECT public_id, display_name, gender FROM persons WHERE id = ?`, relationship.from_person_id);
  const to = get(`SELECT public_id, display_name, gender FROM persons WHERE id = ?`, relationship.to_person_id);
  return {
    ...base,
    from: from ? { id: from.public_id, name: from.display_name, gender: from.gender } : null,
    to: to ? { id: to.public_id, name: to.display_name, gender: to.gender } : null,
    label: relationshipLabel(relationship),
  };
}

/**
 * Merges `duplicate` into `survivor` after human approval.
 * Relationship edges are repointed, conflicts are dropped rather than
 * duplicated, and a reversible snapshot is stored in `person_merges`.
 */
export function mergePersons(survivor, duplicate, meta) {
  if (survivor.id === duplicate.id) throw badRequest('Cannot merge a person into themselves.');

  const snapshot = {
    person: duplicate,
    relationships: all(
      `SELECT * FROM relationships WHERE from_person_id = ? OR to_person_id = ?`,
      duplicate.id, duplicate.id
    ),
    events: all(`SELECT * FROM events WHERE person_id = ?`, duplicate.id),
  };

  // Repoint every edge, skipping any that would collide or self-loop.
  for (const rel of snapshot.relationships) {
    const newFrom = rel.from_person_id === duplicate.id ? survivor.id : rel.from_person_id;
    const newTo = rel.to_person_id === duplicate.id ? survivor.id : rel.to_person_id;
    if (newFrom === newTo) { run(`DELETE FROM relationships WHERE id = ?`, rel.id); continue; }

    const [a, b] = rel.type === 'parent' ? [newFrom, newTo] : canonicalPair(rel.type, newFrom, newTo);
    const clash = get(
      `SELECT id FROM relationships WHERE from_person_id = ? AND to_person_id = ? AND type = ? AND id <> ?`,
      a, b, rel.type, rel.id
    );
    if (clash) { run(`DELETE FROM relationships WHERE id = ?`, rel.id); continue; }

    run(
      `UPDATE relationships SET from_person_id = ?, to_person_id = ?, updated_at = datetime('now') WHERE id = ?`,
      a, b, rel.id
    );
  }

  run(`UPDATE events SET person_id = ? WHERE person_id = ?`, survivor.id, duplicate.id);
  run(`UPDATE events SET related_person_id = ? WHERE related_person_id = ?`, survivor.id, duplicate.id);

  // Fill blanks on the survivor from the record being merged away.
  const fillable = ['middle_name', 'family_name', 'maiden_name', 'birth_date', 'birth_place',
    'death_date', 'death_place', 'occupation', 'current_place', 'photo_path', 'notes'];
  const fills = {};
  for (const field of fillable) {
    if (!survivor[field] && duplicate[field]) fills[field] = duplicate[field];
  }
  if (Object.keys(fills).length) {
    const cols = Object.keys(fills);
    run(
      `UPDATE persons SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`,
      ...cols.map((c) => fills[c]),
      survivor.id
    );
  }

  run(
    `UPDATE persons SET merged_into_id = ?, merged_at = datetime('now') WHERE id = ?`,
    survivor.id, duplicate.id
  );
  run(
    `INSERT INTO person_merges (surviving_id, merged_id, match_id, approved_by, snapshot)
     VALUES (?, ?, ?, ?, ?)`,
    survivor.id, duplicate.id, meta.matchId ?? null, meta.actor?.id ?? null, JSON.stringify(snapshot)
  );

  bumpGraphVersion();

  recordChange({
    actorUserId: meta.actor?.id ?? null,
    actorLabel: meta.actor?.displayName ?? 'system',
    entityType: 'person',
    entityId: survivor.id,
    entityLabel: survivor.display_name,
    action: 'Duplicate Merged',
    oldValue: duplicate.display_name,
    newValue: survivor.display_name,
    detail: `Merged after human verification (match ${meta.matchPublicId ?? 'n/a'}).`,
    ip: meta.ip ?? null,
  });

  return get(`SELECT * FROM persons WHERE id = ?`, survivor.id);
}
