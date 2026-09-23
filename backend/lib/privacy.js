/**
 * Access control and privacy enforcement.
 *
 * This module is the single gate through which person data reaches a client.
 * Routes never serialise a raw `persons` row -- they call `viewPerson()`, which
 * applies the owner's privacy settings and the viewer's access level. Hiding a
 * field in the UI is not privacy; removing it here is.
 *
 * Access levels, strongest first:
 *   owner     -- the account that created the record (or a site admin)
 *   verifier  -- collaborator who may approve/reject verification requests
 *   editor    -- collaborator who may create and edit records
 *   suggester -- collaborator who may propose records (created 'unverified')
 *   viewer    -- collaborator who may read the tree
 *   public    -- any authenticated user
 *   none      -- no access
 */
import { get, all } from '../db/index.js';
import { forbidden, notFound } from './errors.js';

const LEVEL_RANK = { none: 0, public: 1, viewer: 2, suggester: 3, editor: 4, verifier: 5, owner: 6 };

const collaboratorCache = new Map(); // "viewer:owner" -> { level, at }
const CACHE_TTL_MS = 5000;

export function clearAccessCache() {
  collaboratorCache.clear();
}

/** Resolves the viewer's standing relative to a tree owner. */
export function accessLevel(viewer, ownerUserId) {
  if (!viewer) return 'none';
  if (viewer.id === ownerUserId) return 'owner';
  if (viewer.role === 'admin') return 'owner';
  if (viewer.role === 'moderator') return 'viewer';

  const key = `${viewer.id}:${ownerUserId}`;
  const cached = collaboratorCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.level;

  const row = get(
    `SELECT role FROM tree_collaborators
     WHERE owner_user_id = ? AND grantee_user_id = ? AND status = 'active'`,
    ownerUserId,
    viewer.id
  );
  const level = row ? row.role : 'public';
  collaboratorCache.set(key, { level, at: Date.now() });
  return level;
}

export const atLeast = (level, required) => LEVEL_RANK[level] >= LEVEL_RANK[required];

/** Owner privacy settings, with safe defaults if the row is missing. */
export function privacyFor(ownerUserId) {
  return (
    get(`SELECT * FROM privacy_settings WHERE user_id = ?`, ownerUserId) ?? {
      user_id: ownerUserId,
      default_person_visibility: 'family',
      profile_visibility: 'family',
      hide_living_details: 1,
      allow_match_discovery: 1,
      allow_relationship_search: 1,
      allow_ai_suggestions: 1,
      show_in_directory: 1,
    }
  );
}

/**
 * Can `viewer` see this person at all?
 * A person's own `visibility` narrows what the owner's settings already allow.
 */
export function canViewPerson(viewer, person) {
  const level = accessLevel(viewer, person.created_by_user_id);
  if (level === 'owner') return true;

  switch (person.visibility) {
    case 'private':
      return false;                       // owner only, full stop
    case 'family':
      return atLeast(level, 'viewer');    // active collaborators only
    case 'public':
      return atLeast(level, 'public');    // any signed-in user
    default:
      return false;
  }
}

/**
 * Is this person the record that represents a registered account, whose owner
 * has left relationship search switched on?
 *
 * That setting is the consent for being found: "Lets other users run 'How am I
 * related?' towards people in your tree." Without honouring it here, a new
 * account -- whose own record defaults to Family Only -- could never be the
 * target of a relationship search, which would make the headline feature
 * unusable between people who have not already met.
 *
 * The consent is narrow. It covers the account holder's OWN record and nothing
 * else in their tree, and `viewPerson` still applies `hide_living_details`, so
 * a living user's dates, places and notes stay hidden. What becomes visible is
 * the name and the position in the graph -- exactly what the feature needs.
 */
export function isSearchableSelfPerson(person) {
  if (!person) return false;
  const owner = get(`SELECT id FROM users WHERE self_person_id = ? AND status = 'active'`, person.id);
  if (!owner) return false;
  return privacyFor(owner.id).allow_relationship_search === 1;
}

/** `canViewPerson`, widened to cover consenting account holders. */
export function canViewAsSearchTarget(viewer, person) {
  return canViewPerson(viewer, person) || isSearchableSelfPerson(person);
}

export function canEditPerson(viewer, person) {
  const level = accessLevel(viewer, person.created_by_user_id);
  return atLeast(level, 'editor');
}

export function canSuggestOnTree(viewer, ownerUserId) {
  return atLeast(accessLevel(viewer, ownerUserId), 'suggester');
}

export function canVerifyOnTree(viewer, ownerUserId) {
  return atLeast(accessLevel(viewer, ownerUserId), 'verifier');
}

/**
 * Serialises a person for `viewer`, removing anything they may not see.
 *
 * `hide_living_details` protects people who are alive: a collaborator can see
 * that Grandmother exists and how she connects, but not her exact date of
 * birth, address or private notes unless they can edit the tree.
 */
export function viewPerson(viewer, person, { includeAudit = false, asSearchTarget = false } = {}) {
  if (!person) return null;
  const level = accessLevel(viewer, person.created_by_user_id);

  const visible = canViewPerson(viewer, person)
    || (asSearchTarget && isSearchableSelfPerson(person));

  if (!visible) {
    // A private record is acknowledged as existing (the graph shape is already
    // implied by the edges) but carries no identifying detail.
    return {
      id: person.public_id,
      displayName: 'Private person',
      restricted: true,
      visibility: person.visibility,
      gender: 'unknown',
      isLiving: null,
      accessLevel: level,
    };
  }

  const settings = privacyFor(person.created_by_user_id);
  const hideLiving =
    settings.hide_living_details === 1 && person.is_living === 1 && !atLeast(level, 'editor');

  const base = {
    id: person.public_id,
    givenName: person.given_name,
    middleName: person.middle_name,
    familyName: person.family_name,
    maidenName: person.maiden_name,
    displayName: person.display_name,
    gender: person.gender,
    isLiving: person.is_living === 1,
    visibility: person.visibility,
    photoUrl: person.photo_path ? `/api/persons/${person.public_id}/photo` : null,
    isSynthetic: person.is_synthetic === 1,
    dataLabel: person.data_label,
    accessLevel: level,
    canEdit: atLeast(level, 'editor'),
    restricted: false,
    mergedInto: person.merged_into_public_id ?? null,
  };

  if (hideLiving) {
    return {
      ...base,
      birthDate: null,
      birthYear: person.birth_year ?? null, // a year alone is not identifying
      birthPrecision: 'unknown',
      birthPlace: null,
      deathDate: null,
      deathPlace: null,
      occupation: null,
      currentPlace: null,
      notes: null,
      detailsHidden: true,
      detailsHiddenReason: 'The tree owner hides detailed information for living people.',
    };
  }

  const full = {
    ...base,
    birthDate: person.birth_date,
    birthYear: person.birth_year,
    birthPrecision: person.birth_precision,
    birthPlace: person.birth_place,
    deathDate: person.death_date,
    deathPrecision: person.death_precision,
    deathPlace: person.death_place,
    occupation: person.occupation,
    currentPlace: person.current_place,
    notes: atLeast(level, 'viewer') ? person.notes : null,
    detailsHidden: false,
  };

  if (includeAudit && atLeast(level, 'editor')) {
    full.createdAt = person.created_at;
    full.updatedAt = person.updated_at;
    full.ownerUserId = person.created_by_user_id;
  }
  return full;
}

/** Loads a person by public id and throws 404 if the viewer may not see it. */
export function loadVisiblePerson(viewer, publicId) {
  const person = get(`SELECT * FROM persons WHERE public_id = ?`, publicId);
  if (!person) throw notFound('That person was not found.');
  if (!canViewPerson(viewer, person)) {
    // 404 rather than 403: confirming existence would itself leak information.
    throw notFound('That person was not found.');
  }
  return person;
}

export function loadEditablePerson(viewer, publicId) {
  const person = get(`SELECT * FROM persons WHERE public_id = ?`, publicId);
  if (!person) throw notFound('That person was not found.');
  if (!canViewPerson(viewer, person)) throw notFound('That person was not found.');
  if (!canEditPerson(viewer, person)) {
    throw forbidden('You can view this person but not change them.');
  }
  return person;
}

/** Every user id whose tree `viewer` may read -- own tree plus active grants. */
export function readableOwnerIds(viewer) {
  if (!viewer) return [];
  if (viewer.role === 'admin') {
    return all(`SELECT id FROM users WHERE status = 'active'`).map((r) => r.id);
  }
  const grants = all(
    `SELECT owner_user_id FROM tree_collaborators
     WHERE grantee_user_id = ? AND status = 'active'`,
    viewer.id
  ).map((r) => r.owner_user_id);
  return [viewer.id, ...grants];
}

/**
 * Filters a list of person rows to those the viewer may see, and serialises
 * them. Used by search and listing endpoints.
 */
export function viewPersonList(viewer, rows, options = {}) {
  const out = [];
  for (const row of rows) {
    if (!canViewPerson(viewer, row)) continue;
    out.push(viewPerson(viewer, row, options));
  }
  return out;
}

/**
 * Cross-tree discovery consent. A user who turns off match discovery is
 * excluded from other people's candidate lists entirely -- not merely hidden.
 */
export function allowsMatchDiscovery(ownerUserId) {
  return privacyFor(ownerUserId).allow_match_discovery === 1;
}

export function allowsRelationshipSearch(ownerUserId) {
  return privacyFor(ownerUserId).allow_relationship_search === 1;
}

export function allowsAiSuggestions(ownerUserId) {
  return privacyFor(ownerUserId).allow_ai_suggestions === 1;
}
