/**
 * Search routes, including the headline feature:
 *   "How am I related to this person?"
 *
 * The answer is computed by traversing the stored graph. When no verified path
 * exists the endpoint says so explicitly rather than guessing -- and it will
 * optionally report a provisional path through unverified edges, clearly
 * labelled as such.
 */
import { Router } from '../lib/http.js';
import { validate, parsePagination } from '../lib/validate.js';
import { all, get } from '../db/index.js';
import { loadGraph, findPaths, commonAncestors } from '../engine/graph.js';
import { describePath, reciprocalLabel, relationshipFromCommonAncestor } from '../engine/relationship.js';
import { explainPath } from '../ai/suggest.js';
import {
  viewPerson, canViewPerson, canViewAsSearchTarget, readableOwnerIds,
  allowsRelationshipSearch, privacyFor,
} from '../lib/privacy.js';
import { notFound, badRequest, forbidden } from '../lib/errors.js';
import { normalizeName, phoneticKey } from '../lib/text.js';
import config from '../config.js';

const router = new Router();

// ------------------------------------------------------------ find people ---

router.get('/persons', async (ctx) => {
  const term = String(ctx.query.q ?? '').trim();
  if (term.length < 2) throw badRequest('Enter at least two characters to search.');
  const { pageSize, offset } = parsePagination(ctx.query, { defaultSize: 25, maxSize: 100 });

  const scope = ctx.query.scope ?? 'mine';
  let ownerFilter = '';
  const params = [];

  if (scope === 'mine') {
    ownerFilter = 'AND p.created_by_user_id = ?';
    params.push(ctx.user.id);
  } else if (scope === 'shared') {
    const ids = readableOwnerIds(ctx.user);
    ownerFilter = `AND p.created_by_user_id IN (${ids.map(() => '?').join(',')})`;
    params.push(...ids);
  } else {
    // Global scope only reaches trees whose owners allow relationship search,
    // and only surfaces people whose own visibility permits it.
    ownerFilter = `AND p.created_by_user_id IN (
        SELECT u.id FROM users u
        LEFT JOIN privacy_settings ps ON ps.user_id = u.id
        WHERE u.status = 'active' AND COALESCE(ps.allow_relationship_search, 1) = 1
      )`;
  }

  const normalized = normalizeName(term);
  const phonetic = phoneticKey(term);

  const rows = all(
    `SELECT p.*,
            CASE
              WHEN p.name_normalized = ?        THEN 100
              WHEN p.name_normalized LIKE ?     THEN 80
              WHEN p.name_phonetic  = ?         THEN 60
              ELSE 40
            END AS rank
     FROM persons p
     WHERE p.merged_into_id IS NULL
       ${ownerFilter}
       AND (p.name_normalized LIKE ? OR p.name_phonetic LIKE ?)
     ORDER BY rank DESC, p.display_name ASC
     LIMIT ? OFFSET ?`,
    normalized, `${normalized}%`, phonetic,
    ...params,
    `%${normalized}%`, `%${phonetic}%`,
    pageSize, offset
  );

  // In global scope a consenting account holder's own record is reachable even
  // when the rest of their tree is not, so they can be found and compared.
  const asSearchTarget = scope === 'global';

  const results = [];
  for (const row of rows) {
    const allowed = asSearchTarget
      ? canViewAsSearchTarget(ctx.user, row)
      : canViewPerson(ctx.user, row);
    if (!allowed) continue;
    const owner = get(`SELECT public_id, display_name FROM users WHERE id = ?`, row.created_by_user_id);
    results.push({
      ...viewPerson(ctx.user, row, { asSearchTarget }),
      matchRank: row.rank,
      tree: {
        ownerId: owner?.public_id ?? null,
        ownerName: owner?.display_name ?? 'Unknown',
        isMine: row.created_by_user_id === ctx.user.id,
      },
    });
  }

  return { query: term, scope, results, count: results.length };
});

// ------------------------------------------------------------- find users ---

router.get('/users', async (ctx) => {
  const term = String(ctx.query.q ?? '').trim();
  if (term.length < 2) throw badRequest('Enter at least two characters to search.');

  const rows = all(
    `SELECT u.public_id, u.display_name, u.created_at, u.is_synthetic,
            p.public_id AS person_public_id, p.display_name AS person_name,
            (SELECT COUNT(*) FROM persons px WHERE px.created_by_user_id = u.id AND px.merged_into_id IS NULL) AS tree_size
     FROM users u
     LEFT JOIN persons p ON p.id = u.self_person_id
     LEFT JOIN privacy_settings ps ON ps.user_id = u.id
     WHERE u.status = 'active'
       AND u.id <> ?
       AND COALESCE(ps.show_in_directory, 1) = 1
       AND LOWER(u.display_name) LIKE ?
     ORDER BY u.display_name
     LIMIT 25`,
    ctx.user.id, `%${term.toLowerCase()}%`
  );

  return {
    users: rows.map((r) => ({
      id: r.public_id,
      displayName: r.display_name,
      treeSize: r.tree_size,
      selfPerson: r.person_public_id ? { id: r.person_public_id, name: r.person_name } : null,
      isSynthetic: r.is_synthetic === 1,
      memberSince: r.created_at,
    })),
  };
});

// ------------------------------------------ "How am I related to them?" -----

/**
 * Resolves the two endpoints of a relationship query.
 * `from` defaults to the caller's own person record.
 */
function resolveEndpoints(ctx, input) {
  let from;
  if (input.fromPersonId) {
    from = get(`SELECT * FROM persons WHERE public_id = ?`, input.fromPersonId);
  } else if (ctx.user.selfPersonId) {
    from = get(`SELECT * FROM persons WHERE id = ?`, ctx.user.selfPersonId);
  }
  if (!from) throw badRequest('Could not work out who to search from. Set your own person record first.');
  if (!canViewPerson(ctx.user, from)) throw notFound('That person was not found.');

  let to = null;
  if (input.toPersonId) {
    to = get(`SELECT * FROM persons WHERE public_id = ?`, input.toPersonId);
  } else if (input.toUserId) {
    const other = get(`SELECT * FROM users WHERE public_id = ? AND status = 'active'`, input.toUserId);
    if (!other) throw notFound('That user was not found.');
    if (!other.self_person_id) throw notFound('That user has no person record to search towards.');
    to = get(`SELECT * FROM persons WHERE id = ?`, other.self_person_id);
  }
  if (!to) throw badRequest('Choose a person or a registered user to compare with.');

  // The target tree owner must allow relationship search.
  if (to.created_by_user_id !== ctx.user.id && !allowsRelationshipSearch(to.created_by_user_id)) {
    throw forbidden('That family tree has turned off relationship search.');
  }
  // A consenting account holder's own record is reachable even when the rest
  // of their tree is not -- see `isSearchableSelfPerson`.
  if (!canViewAsSearchTarget(ctx.user, to)) throw notFound('That person was not found.');

  return { from, to };
}

async function relationshipSearch(ctx) {
  const input = validate(ctx.body, {
    fromPersonId: { type: 'string', maxLength: 64 },
    toPersonId: { type: 'string', maxLength: 64 },
    toUserId: { type: 'string', maxLength: 64 },
    includeUnverified: { type: 'bool', default: false },
    maxPaths: { type: 'int', min: 1, max: 10, default: config.engine.maxPathsReturned },
  });

  const { from, to } = resolveEndpoints(ctx, input);

  if (from.id === to.id) {
    return {
      found: true,
      samePerson: true,
      from: viewPerson(ctx.user, from),
      to: viewPerson(ctx.user, to),
      message: 'That is the same person record.',
      paths: [],
    };
  }

  // Always try verified edges first. Only fall back to unverified when the
  // caller explicitly asked, and label the result accordingly.
  const verifiedGraph = loadGraph({ statuses: ['verified'] });
  let graph = verifiedGraph;
  let usedUnverified = false;

  let result = findPaths(verifiedGraph, from.id, to.id, { maxPaths: input.maxPaths });

  if (!result.found && input.includeUnverified) {
    graph = loadGraph({ statuses: ['verified', 'unverified', 'verification_requested'] });
    result = findPaths(graph, from.id, to.id, { maxPaths: input.maxPaths });
    usedUnverified = result.found;
  }

  const genderOf = (id) => get(`SELECT gender FROM persons WHERE id = ?`, id)?.gender ?? 'unknown';
  const nameOf = (id) => {
    const row = get(`SELECT * FROM persons WHERE id = ?`, id);
    if (!row) return 'Unknown';
    const view = viewPerson(ctx.user, row);
    return view?.displayName ?? 'Private person';
  };

  if (!result.found) {
    return {
      found: false,
      from: viewPerson(ctx.user, from),
      to: viewPerson(ctx.user, to, { asSearchTarget: true }),
      searchedStatuses: input.includeUnverified ? ['verified', 'unverified'] : ['verified'],
      truncated: result.truncated,
      message: input.includeUnverified
        ? `No relationship path was found between ${from.display_name} and ${to.display_name}, even including unverified relationships. Their family branches are not connected in the data recorded so far.`
        : `No verified relationship path was found between ${from.display_name} and ${to.display_name}. You can search again including unverified relationships, or look for a Possible Match that would connect the branches.`,
      suggestion: 'Run a possible-match scan to see whether the two trees share a person who has been entered twice.',
      paths: [],
    };
  }

  // Describe every path found.
  const described = result.paths.map((p, index) => {
    const description = describePath(graph, p.steps, genderOf, nameOf);
    return {
      rank: index + 1,
      ...description,
      reciprocal: reciprocalLabel(graph, p.steps, genderOf, nameOf),
      people: p.nodes.map((id) => {
        const row = get(`SELECT * FROM persons WHERE id = ?`, id);
        return row ? viewPerson(ctx.user, row) : null;
      }).filter(Boolean),
    };
  });

  // Common ancestors, reported for blood relationships.
  const shared = commonAncestors(graph, from.id, to.id);
  const commonAncestorViews = shared.map((s) => {
    const row = get(`SELECT * FROM persons WHERE id = ?`, s.personId);
    const view = row ? viewPerson(ctx.user, row) : null;
    return {
      person: view,
      generationsFromA: s.generationsFromA,
      generationsFromB: s.generationsFromB,
      biological: s.biological,
      relationToYou: relationshipFromCommonAncestor(s.generationsFromA, 0, row?.gender ?? 'unknown').label,
      relationToThem: relationshipFromCommonAncestor(s.generationsFromB, 0, row?.gender ?? 'unknown').label,
    };
  }).filter((c) => c.person);

  const primary = described[0];

  return {
    found: true,
    from: viewPerson(ctx.user, from),
    to: viewPerson(ctx.user, to, { asSearchTarget: true }),
    /** The headline answer. */
    relationship: {
      label: primary.label,
      reciprocal: primary.reciprocal,
      category: primary.category,
      isBiological: primary.isBiological,
      viaMarriage: primary.viaMarriage,
      degreeOfSeparation: primary.degreeOfSeparation,
      /**
       * VERIFIED   -- every edge on the path has been confirmed by a human
       * PROVISIONAL-- the path relies on at least one unverified edge
       */
      verificationStatus: primary.fullyVerified ? 'VERIFIED' : 'PROVISIONAL',
    },
    summary: `${to.display_name} is your ${primary.label}.`,
    explanation: explainPath(primary, commonAncestorViews.map((c) => c.person.displayName)),
    paths: described,
    pathCount: described.length,
    multiplePathsFound: described.length > 1,
    commonAncestors: commonAncestorViews,
    usedUnverifiedEdges: usedUnverified,
    truncated: result.truncated,
    note: usedUnverified
      ? 'This connection depends on relationships that have not been verified yet. Request verification before treating it as confirmed.'
      : null,
  };
}

router.post('/relationship', relationshipSearch);

/** Convenience GET form so a result can be shared as a link. */
router.get('/relationship', async (ctx) =>
  relationshipSearch({
    ...ctx,
    body: {
      fromPersonId: ctx.query.from,
      toPersonId: ctx.query.to,
      toUserId: ctx.query.toUser,
      includeUnverified: ctx.query.includeUnverified === 'true',
    },
  })
);

// ----------------------------------------------------------- tree browser ---

/** Registered trees the user could compare against. */
router.get('/trees', async (ctx) => {
  const rows = all(
    `SELECT u.public_id, u.display_name, u.is_synthetic,
            (SELECT COUNT(*) FROM persons p WHERE p.created_by_user_id = u.id AND p.merged_into_id IS NULL) AS people,
            (SELECT COUNT(*) FROM relationships r
               JOIN persons p2 ON p2.id = r.from_person_id
              WHERE p2.created_by_user_id = u.id AND r.status = 'verified') AS verified_links,
            COALESCE(ps.allow_relationship_search, 1) AS searchable
     FROM users u
     LEFT JOIN privacy_settings ps ON ps.user_id = u.id
     WHERE u.status = 'active'
       AND u.id <> ?
       AND COALESCE(ps.show_in_directory, 1) = 1
     ORDER BY people DESC
     LIMIT 50`,
    ctx.user.id
  );

  return {
    trees: rows.map((r) => ({
      ownerId: r.public_id,
      ownerName: r.display_name,
      people: r.people,
      verifiedRelationships: r.verified_links,
      searchable: r.searchable === 1,
      isSynthetic: r.is_synthetic === 1,
    })),
  };
});

export default router;
