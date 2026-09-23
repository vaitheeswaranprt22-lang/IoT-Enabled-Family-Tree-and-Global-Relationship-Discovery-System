/**
 * Person routes: the people in the family graph.
 *
 * Every read goes through `viewPerson`, so the owner's privacy settings and the
 * viewer's access level are applied before anything leaves the server.
 */
import { Router } from '../lib/http.js';
import { validate, parsePagination } from '../lib/validate.js';
import { all, get, run, transaction } from '../db/index.js';
import {
  createPerson, updatePerson, createRelationship, viewRelationship,
} from '../lib/person-service.js';
import {
  viewPerson, loadVisiblePerson, loadEditablePerson, canSuggestOnTree,
  readableOwnerIds, privacyFor, accessLevel, atLeast,
} from '../lib/privacy.js';
import { recordChange, historyFor } from '../lib/audit.js';
import { badRequest, forbidden, notFound, conflict } from '../lib/errors.js';
import { loadGraph, immediateFamily, bumpGraphVersion } from '../engine/graph.js';
import { stepTerm } from '../engine/relationship.js';
import config from '../config.js';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const router = new Router();

const PERSON_SCHEMA = {
  givenName: { type: 'string', maxLength: 80, minLength: 1, label: 'First name' },
  middleName: { type: 'string', maxLength: 80 },
  familyName: { type: 'string', maxLength: 80 },
  maidenName: { type: 'string', maxLength: 80 },
  gender: { type: 'enum', values: ['male', 'female', 'other', 'unknown'] },
  birthDate: { type: 'date', notFuture: true },
  birthPrecision: { type: 'enum', values: ['exact', 'month', 'year', 'about', 'unknown'] },
  birthPlace: { type: 'string', maxLength: 200 },
  deathDate: { type: 'date', notFuture: true },
  deathPrecision: { type: 'enum', values: ['exact', 'month', 'year', 'about', 'unknown'] },
  deathPlace: { type: 'string', maxLength: 200 },
  isLiving: { type: 'bool' },
  occupation: { type: 'string', maxLength: 120 },
  currentPlace: { type: 'string', maxLength: 200 },
  notes: { type: 'string', maxLength: 4000 },
  visibility: { type: 'enum', values: ['private', 'family', 'public'] },
};

/** camelCase API shape -> snake_case columns. */
function toColumns(input) {
  const map = {
    givenName: 'given_name', middleName: 'middle_name', familyName: 'family_name',
    maidenName: 'maiden_name', gender: 'gender',
    birthDate: 'birth_date', birthPrecision: 'birth_precision', birthPlace: 'birth_place',
    deathDate: 'death_date', deathPrecision: 'death_precision', deathPlace: 'death_place',
    isLiving: 'is_living', occupation: 'occupation', currentPlace: 'current_place',
    notes: 'notes', visibility: 'visibility',
  };
  const out = {};
  for (const [key, column] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(input, key)) out[column] = input[key];
  }
  return out;
}

// ------------------------------------------------------------------ list ---

router.get('/', async (ctx) => {
  const { page, pageSize, offset } = parsePagination(ctx.query, { defaultSize: 50, maxSize: 200 });
  const ownerIds = ctx.query.scope === 'mine' ? [ctx.user.id] : readableOwnerIds(ctx.user);
  if (!ownerIds.length) return { persons: [], page, pageSize, total: 0 };

  const filters = [`p.created_by_user_id IN (${ownerIds.map(() => '?').join(',')})`];
  const params = [...ownerIds];

  if (ctx.query.q) {
    filters.push(`(p.name_normalized LIKE ? OR p.name_phonetic LIKE ?)`);
    const term = `%${String(ctx.query.q).toLowerCase().trim()}%`;
    params.push(term, term);
  }
  if (ctx.query.gender) { filters.push('p.gender = ?'); params.push(ctx.query.gender); }
  if (ctx.query.living === 'true') filters.push('p.is_living = 1');
  if (ctx.query.living === 'false') filters.push('p.is_living = 0');
  if (ctx.query.visibility) { filters.push('p.visibility = ?'); params.push(ctx.query.visibility); }
  if (ctx.query.birthFrom) { filters.push('p.birth_year >= ?'); params.push(Number(ctx.query.birthFrom)); }
  if (ctx.query.birthTo) { filters.push('p.birth_year <= ?'); params.push(Number(ctx.query.birthTo)); }
  if (ctx.query.includeMerged !== 'true') filters.push('p.merged_into_id IS NULL');

  const where = filters.join(' AND ');
  const total = get(`SELECT COUNT(*) AS n FROM persons p WHERE ${where}`, ...params)?.n ?? 0;

  const sortColumn = {
    name: 'p.display_name', birth: 'p.birth_year', created: 'p.created_at', updated: 'p.updated_at',
  }[ctx.query.sort ?? 'name'] ?? 'p.display_name';
  const direction = ctx.query.order === 'desc' ? 'DESC' : 'ASC';

  const rows = all(
    `SELECT p.* FROM persons p WHERE ${where}
     ORDER BY ${sortColumn} ${direction} NULLS LAST, p.id ASC
     LIMIT ? OFFSET ?`,
    ...params, pageSize, offset
  );

  return {
    persons: rows.filter((r) => viewPerson(ctx.user, r)).map((r) => viewPerson(ctx.user, r)),
    page, pageSize, total,
    totalPages: Math.ceil(total / pageSize),
  };
});

// ---------------------------------------------------------------- create ---

router.post('/', async (ctx) => {
  const input = validate(ctx.body, {
    ...PERSON_SCHEMA,
    givenName: { ...PERSON_SCHEMA.givenName, required: true },
    // Optional: link the new person to an existing one in the same action.
    relateTo: { type: 'string', maxLength: 64 },
    relationType: { type: 'enum', values: ['parent', 'child', 'spouse', 'sibling'] },
    relationSubtype: { type: 'enum', values: ['biological', 'adoptive', 'step', 'foster', 'guardian', 'married', 'partner', 'divorced', 'widowed', 'full', 'half', 'unknown'] },
    ownerId: { type: 'string', maxLength: 64 },
  });

  // Decide which tree the person belongs to.
  let ownerUserId = ctx.user.id;
  if (input.ownerId) {
    const owner = get(`SELECT id FROM users WHERE public_id = ?`, input.ownerId);
    if (!owner) throw notFound('That tree owner was not found.');
    if (owner.id !== ctx.user.id && !canSuggestOnTree(ctx.user, owner.id)) {
      throw forbidden('You do not have permission to add people to that tree.');
    }
    ownerUserId = owner.id;
  }

  const defaults = privacyFor(ownerUserId);
  const columns = toColumns(input);
  if (!columns.visibility) columns.visibility = defaults.default_person_visibility;

  const result = transaction(() => {
    const person = createPerson(columns, {
      ownerUserId,
      actor: ctx.user,
      ip: ctx.ip,
    });

    let relationship = null;
    if (input.relateTo && input.relationType) {
      const other = get(`SELECT * FROM persons WHERE public_id = ?`, input.relateTo);
      if (!other) throw notFound('The person to relate to was not found.');
      if (!atLeast(accessLevel(ctx.user, other.created_by_user_id), 'suggester')) {
        throw forbidden('You cannot create relationships in that tree.');
      }

      // 'child' is expressed as a parent edge pointing the other way.
      const spec =
        input.relationType === 'parent'
          ? { fromPersonId: other.id, toPersonId: person.id, type: 'parent' }
          : input.relationType === 'child'
            ? { fromPersonId: person.id, toPersonId: other.id, type: 'parent' }
            : { fromPersonId: person.id, toPersonId: other.id, type: input.relationType };

      relationship = createRelationship(
        { ...spec, subtype: input.relationSubtype },
        { actor: ctx.user, ip: ctx.ip, source: 'user' }
      );
    }
    return { person, relationship };
  });

  return {
    __status: 201,
    person: viewPerson(ctx.user, result.person, { includeAudit: true }),
    relationship: result.relationship ? viewRelationship(result.relationship) : null,
  };
});

// ------------------------------------------------------------------ read ---

router.get('/:id', async (ctx) => {
  const person = loadVisiblePerson(ctx.user, ctx.params.id);
  const graph = loadGraph({ statuses: ['verified', 'unverified'] });
  const fam = immediateFamily(graph, person.id);

  const resolve = (edge) => {
    const row = get(`SELECT * FROM persons WHERE id = ?`, edge.to);
    if (!row) return null;
    const view = viewPerson(ctx.user, row);
    return view
      ? {
          person: view,
          term: stepTerm({ dir: edge.dir, subtype: edge.subtype }, row.gender),
          subtype: edge.subtype,
          status: edge.status,
          derived: edge.derived ?? false,
          relationshipId: edge.relId ? get(`SELECT public_id FROM relationships WHERE id = ?`, edge.relId)?.public_id : null,
        }
      : null;
  };

  return {
    person: viewPerson(ctx.user, person, { includeAudit: true }),
    family: {
      parents: fam.parents.map(resolve).filter(Boolean),
      children: fam.children.map(resolve).filter(Boolean),
      spouses: fam.spouses.map(resolve).filter(Boolean),
      siblings: fam.siblings.map(resolve).filter(Boolean),
    },
    events: all(
      `SELECT * FROM events WHERE person_id = ? ORDER BY event_year ASC, event_date ASC`,
      person.id
    ).map(viewEvent),
  };
});

function viewEvent(row) {
  return {
    id: row.public_id,
    type: row.type,
    title: row.title,
    description: row.description,
    date: row.event_date,
    year: row.event_year,
    precision: row.date_precision,
    place: row.place,
    visibility: row.visibility,
    isSynthetic: row.is_synthetic === 1,
  };
}

// ---------------------------------------------------------------- update ---

router.patch('/:id', async (ctx) => {
  const person = loadEditablePerson(ctx.user, ctx.params.id);
  const input = validate(ctx.body, PERSON_SCHEMA);
  const columns = toColumns(input);

  if (!Object.keys(columns).length) throw badRequest('No changes were supplied.');

  const updated = updatePerson(person, columns, { actor: ctx.user, ip: ctx.ip });
  return { person: viewPerson(ctx.user, updated, { includeAudit: true }) };
});

// ---------------------------------------------------------------- delete ---

router.delete('/:id', async (ctx) => {
  const person = loadEditablePerson(ctx.user, ctx.params.id);

  const selfOf = get(`SELECT id FROM users WHERE self_person_id = ?`, person.id);
  if (selfOf) throw conflict('This person record represents a user account and cannot be deleted.');

  const edgeCount = get(
    `SELECT COUNT(*) AS n FROM relationships WHERE from_person_id = ? OR to_person_id = ?`,
    person.id, person.id
  )?.n ?? 0;

  if (edgeCount > 0 && ctx.query.force !== 'true') {
    throw conflict(
      `${person.display_name} still has ${edgeCount} relationship(s). Remove them first, or repeat with ?force=true.`,
      { relationships: edgeCount }
    );
  }

  transaction(() => {
    run(`DELETE FROM persons WHERE id = ?`, person.id);   // cascades to edges/events
    recordChange({
      actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
      entityType: 'person', entityId: person.id, entityLabel: person.display_name,
      action: 'Person Deleted', oldValue: person.display_name, ip: ctx.ip,
      detail: edgeCount ? `${edgeCount} relationship(s) removed with the person.` : null,
    });
  });
  bumpGraphVersion();

  return { ok: true, deleted: person.public_id, relationshipsRemoved: edgeCount };
});

// -------------------------------------------------------------- relatives ---

router.get('/:id/relatives', async (ctx) => {
  const person = loadVisiblePerson(ctx.user, ctx.params.id);
  const rows = all(
    `SELECT * FROM relationships
     WHERE from_person_id = ? OR to_person_id = ?
     ORDER BY type, created_at`,
    person.id, person.id
  );
  return { relationships: rows.map((r) => viewRelationship(r)) };
});

// --------------------------------------------------------------- history ---

router.get('/:id/history', async (ctx) => {
  const person = loadVisiblePerson(ctx.user, ctx.params.id);
  return {
    history: historyFor('person', person.id, 100).map((h) => ({
      id: h.id,
      action: h.action,
      field: h.field,
      oldValue: h.old_value,
      newValue: h.new_value,
      actor: h.actor_name ?? h.actor_label ?? 'system',
      detail: h.detail,
      at: h.created_at,
    })),
  };
});

// ----------------------------------------------------------------- photo ---

/**
 * Photos arrive as a base64 data URL in JSON rather than multipart, which keeps
 * the server dependency-free. The bytes are validated against a magic-number
 * allow-list so a renamed executable cannot be stored as a "photo".
 */
const IMAGE_SIGNATURES = [
  { ext: 'png', mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg', mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { ext: 'gif', mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'webp', mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
];

function detectImage(buffer) {
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.bytes.every((b, i) => buffer[i] === b)) return sig;
  }
  return null;
}

router.post('/:id/photo', async (ctx) => {
  const person = loadEditablePerson(ctx.user, ctx.params.id);
  const dataUrl = String(ctx.body.image ?? '');
  const match = dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/i);
  if (!match) throw badRequest('Send the photo as a base64 data URL, e.g. "data:image/png;base64,...".');

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > config.uploads.maxBytes) {
    throw badRequest(`That image is ${(buffer.length / 1024 / 1024).toFixed(1)} MB. The limit is ${(config.uploads.maxBytes / 1024 / 1024).toFixed(1)} MB.`);
  }
  const detected = detectImage(buffer);
  if (!detected) throw badRequest('That file is not a PNG, JPEG, GIF or WebP image.');

  mkdirSync(config.uploads.dir, { recursive: true });
  const filename = `${person.public_id}-${crypto.randomBytes(6).toString('hex')}.${detected.ext}`;
  writeFileSync(path.join(config.uploads.dir, filename), buffer);

  const previous = person.photo_path;
  run(`UPDATE persons SET photo_path = ?, updated_at = datetime('now') WHERE id = ?`, filename, person.id);

  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'person', entityId: person.id, entityLabel: person.display_name,
    action: 'Photo Updated', field: 'photo_path', oldValue: previous, newValue: filename, ip: ctx.ip,
  });

  return { ok: true, photoUrl: `/api/persons/${person.public_id}/photo` };
});

router.get('/:id/photo', async (ctx) => {
  const person = loadVisiblePerson(ctx.user, ctx.params.id);
  if (!person.photo_path) throw notFound('No photo for this person.');

  // Living-person privacy also applies to the photo.
  const view = viewPerson(ctx.user, person);
  if (view.restricted || view.detailsHidden) throw notFound('No photo available.');

  const full = path.join(config.uploads.dir, path.basename(person.photo_path));
  if (!existsSync(full)) throw notFound('The stored photo file is missing.');

  const buffer = readFileSync(full);
  const detected = detectImage(buffer);
  ctx.res.writeHead(200, {
    'Content-Type': detected?.mime ?? 'application/octet-stream',
    'Content-Length': buffer.length,
    'Cache-Control': 'private, max-age=600',
  });
  ctx.res.end(buffer);
  return undefined;
});

router.delete('/:id/photo', async (ctx) => {
  const person = loadEditablePerson(ctx.user, ctx.params.id);
  run(`UPDATE persons SET photo_path = NULL, updated_at = datetime('now') WHERE id = ?`, person.id);
  recordChange({
    actorUserId: ctx.user.id, actorLabel: ctx.user.displayName,
    entityType: 'person', entityId: person.id, entityLabel: person.display_name,
    action: 'Photo Removed', oldValue: person.photo_path, ip: ctx.ip,
  });
  return { ok: true };
});

export default router;
