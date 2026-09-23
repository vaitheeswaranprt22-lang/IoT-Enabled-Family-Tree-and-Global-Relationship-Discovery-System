/**
 * Family-tree routes: the data behind the interactive visualisation.
 *
 * The client never downloads the whole graph. It asks for a window around a
 * focus person and expands branches on demand, which is what keeps the page
 * responsive on a tree with thousands of people.
 */
import { Router } from '../lib/http.js';
import { all, get } from '../db/index.js';
import { loadGraph, expandAround, immediateFamily, ancestorsOf, descendantsOf } from '../engine/graph.js';
import { viewPerson, canViewPerson, readableOwnerIds } from '../lib/privacy.js';
import { notFound } from '../lib/errors.js';

const router = new Router();

/** Which edge statuses to traverse. Verified only, unless asked otherwise. */
function statusesFrom(query) {
  return query.include === 'all'
    ? ['verified', 'unverified', 'possible', 'verification_requested']
    : query.include === 'unverified'
      ? ['verified', 'unverified']
      : ['verified'];
}

/** Resolves the focus person: explicit id, else the caller's own person. */
function resolveFocus(ctx) {
  if (ctx.query.focus) {
    const person = get(`SELECT * FROM persons WHERE public_id = ?`, ctx.query.focus);
    if (!person) throw notFound('That person was not found.');
    if (!canViewPerson(ctx.user, person)) throw notFound('That person was not found.');
    return person;
  }
  if (ctx.user.selfPersonId) {
    const person = get(`SELECT * FROM persons WHERE id = ?`, ctx.user.selfPersonId);
    if (person) return person;
  }
  const fallback = get(
    `SELECT * FROM persons WHERE created_by_user_id = ? AND merged_into_id IS NULL ORDER BY id LIMIT 1`,
    ctx.user.id
  );
  if (!fallback) throw notFound('Your tree has no people yet. Add someone to get started.');
  return fallback;
}

// ------------------------------------------------------------ tree window ---

router.get('/', async (ctx) => {
  const focus = resolveFocus(ctx);
  const up = Math.min(12, Math.max(0, Number.parseInt(ctx.query.up ?? '3', 10) || 3));
  const down = Math.min(12, Math.max(0, Number.parseInt(ctx.query.down ?? '3', 10) || 3));
  const nodeCap = Math.min(3000, Math.max(50, Number.parseInt(ctx.query.limit ?? '600', 10) || 600));

  const graph = loadGraph({ statuses: statusesFrom(ctx.query) });
  const window = expandAround(graph, focus.id, {
    up, down, nodeCap,
    includeSpouses: ctx.query.spouses !== 'false',
    includeSiblings: ctx.query.siblings !== 'false',
  });

  // Resolve nodes to person views, dropping anything the viewer may not see.
  const nodes = [];
  const visibleIds = new Set();
  const publicIdOf = new Map();
  for (const [personId, info] of window.nodes) {
    const row = get(`SELECT * FROM persons WHERE id = ?`, personId);
    if (!row) continue;
    const view = viewPerson(ctx.user, row);
    if (!view) continue;
    visibleIds.add(personId);
    publicIdOf.set(personId, row.public_id);
    nodes.push({
      ...view,
      generation: info.generation,
      role: info.role,
      // Tells the client whether expanding further would reveal more.
      hasMoreAncestors: hasNeighbourOutside(graph, personId, 'up', window.nodes),
      hasMoreDescendants: hasNeighbourOutside(graph, personId, 'down', window.nodes),
    });
  }

  const edges = window.edges
    .filter((e) => visibleIds.has(e.from) && visibleIds.has(e.to))
    .map((e) => ({
      id: e.relId,
      from: publicIdOf.get(e.from),
      to: publicIdOf.get(e.to),
      type: e.dir === 'up' || e.dir === 'down' ? 'parent' : e.dir,
      subtype: e.subtype,
      status: e.status,
    }));

  return {
    focus: viewPerson(ctx.user, focus),
    generations: { up, down },
    nodes,
    edges,
    truncated: window.truncated,
    edgeStatuses: statusesFrom(ctx.query),
    counts: { nodes: nodes.length, edges: edges.length },
  };
});

function hasNeighbourOutside(graph, personId, direction, loadedNodes) {
  for (const edge of graph.adj.get(personId) ?? []) {
    if (edge.dir === direction && !loadedNodes.has(edge.to)) return true;
  }
  return false;
}

// ---------------------------------------------- progressive branch loading ---

/**
 * Loads one person's immediate neighbours. The client calls this when the user
 * clicks "expand" on a node, so large trees stream in a branch at a time.
 */
router.get('/neighbors/:id', async (ctx) => {
  const person = get(`SELECT * FROM persons WHERE public_id = ?`, ctx.params.id);
  if (!person) throw notFound('Person not found.');
  if (!canViewPerson(ctx.user, person)) throw notFound('Person not found.');

  const graph = loadGraph({ statuses: statusesFrom(ctx.query) });
  const fam = immediateFamily(graph, person.id);

  const resolve = (edge, generation, role) => {
    const row = get(`SELECT * FROM persons WHERE id = ?`, edge.to);
    if (!row) return null;
    const view = viewPerson(ctx.user, row);
    if (!view) return null;
    return {
      ...view,
      generation,
      role,
      edge: {
        type: edge.dir === 'up' || edge.dir === 'down' ? 'parent' : edge.dir,
        subtype: edge.subtype,
        status: edge.status,
        derived: edge.derived ?? false,
      },
      hasMoreAncestors: (graph.adj.get(row.id) ?? []).some((e) => e.dir === 'up'),
      hasMoreDescendants: (graph.adj.get(row.id) ?? []).some((e) => e.dir === 'down'),
    };
  };

  return {
    person: viewPerson(ctx.user, person),
    parents: fam.parents.map((e) => resolve(e, 1, 'ancestor')).filter(Boolean),
    children: fam.children.map((e) => resolve(e, -1, 'descendant')).filter(Boolean),
    spouses: fam.spouses.map((e) => resolve(e, 0, 'spouse')).filter(Boolean),
    siblings: fam.siblings.map((e) => resolve(e, 0, 'sibling')).filter(Boolean),
  };
});

// -------------------------------------------------------- ancestor lines ----

router.get('/ancestors/:id', async (ctx) => {
  const person = get(`SELECT * FROM persons WHERE public_id = ?`, ctx.params.id);
  if (!person || !canViewPerson(ctx.user, person)) throw notFound('Person not found.');
  const generations = Math.min(20, Number.parseInt(ctx.query.generations ?? '6', 10) || 6);

  const graph = loadGraph({ statuses: statusesFrom(ctx.query) });
  const ancestors = ancestorsOf(graph, person.id, generations);

  const byGeneration = new Map();
  for (const [id, info] of ancestors) {
    const row = get(`SELECT * FROM persons WHERE id = ?`, id);
    if (!row) continue;
    const view = viewPerson(ctx.user, row);
    if (!view) continue;
    if (!byGeneration.has(info.gen)) byGeneration.set(info.gen, []);
    byGeneration.get(info.gen).push({ ...view, biological: info.biological });
  }

  return {
    person: viewPerson(ctx.user, person),
    generations: [...byGeneration.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([gen, people]) => ({ generation: gen, label: generationLabel(gen, 'up'), people })),
    total: ancestors.size,
  };
});

router.get('/descendants/:id', async (ctx) => {
  const person = get(`SELECT * FROM persons WHERE public_id = ?`, ctx.params.id);
  if (!person || !canViewPerson(ctx.user, person)) throw notFound('Person not found.');
  const generations = Math.min(20, Number.parseInt(ctx.query.generations ?? '6', 10) || 6);

  const graph = loadGraph({ statuses: statusesFrom(ctx.query) });
  const descendants = descendantsOf(graph, person.id, generations);

  const byGeneration = new Map();
  for (const [id, info] of descendants) {
    const row = get(`SELECT * FROM persons WHERE id = ?`, id);
    if (!row) continue;
    const view = viewPerson(ctx.user, row);
    if (!view) continue;
    if (!byGeneration.has(info.gen)) byGeneration.set(info.gen, []);
    byGeneration.get(info.gen).push(view);
  }

  return {
    person: viewPerson(ctx.user, person),
    generations: [...byGeneration.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([gen, people]) => ({ generation: gen, label: generationLabel(gen, 'down'), people })),
    total: descendants.size,
  };
});

function generationLabel(gen, direction) {
  if (direction === 'up') {
    if (gen === 1) return 'Parents';
    if (gen === 2) return 'Grandparents';
    if (gen === 3) return 'Great-grandparents';
    return `${'Great-'.repeat(Math.min(gen - 2, 3))}grandparents (generation ${gen})`;
  }
  if (gen === 1) return 'Children';
  if (gen === 2) return 'Grandchildren';
  if (gen === 3) return 'Great-grandchildren';
  return `${'Great-'.repeat(Math.min(gen - 2, 3))}grandchildren (generation ${gen})`;
}

// ------------------------------------------------------------------ stats ---

router.get('/stats', async (ctx) => {
  const ownerIds = readableOwnerIds(ctx.user);
  const placeholders = ownerIds.map(() => '?').join(',');

  const personCount = get(
    `SELECT COUNT(*) AS n FROM persons WHERE created_by_user_id = ? AND merged_into_id IS NULL`,
    ctx.user.id
  )?.n ?? 0;

  const byStatus = all(
    `SELECT r.status, COUNT(*) AS n FROM relationships r
     JOIN persons p ON p.id = r.from_person_id
     WHERE p.created_by_user_id IN (${placeholders})
     GROUP BY r.status`,
    ...ownerIds
  );

  const living = get(
    `SELECT SUM(is_living) AS living, COUNT(*) AS total FROM persons
     WHERE created_by_user_id = ? AND merged_into_id IS NULL`,
    ctx.user.id
  );

  // Generation span measured from the account holder's own person record.
  let generationSpan = { ancestors: 0, descendants: 0, total: 1 };
  if (ctx.user.selfPersonId) {
    const graph = loadGraph({ statuses: ['verified'] });
    const up = ancestorsOf(graph, ctx.user.selfPersonId, 40);
    const down = descendantsOf(graph, ctx.user.selfPersonId, 40);
    const maxUp = up.size ? Math.max(...[...up.values()].map((v) => v.gen)) : 0;
    const maxDown = down.size ? Math.max(...[...down.values()].map((v) => v.gen)) : 0;
    generationSpan = { ancestors: maxUp, descendants: maxDown, total: maxUp + maxDown + 1 };
  }

  const openMatches = get(
    `SELECT COUNT(*) AS n FROM match_suggestions ms
     JOIN persons p ON p.id = ms.person_a_id
     WHERE ms.status = 'possible' AND (p.created_by_user_id = ?
       OR ms.person_b_id IN (SELECT id FROM persons WHERE created_by_user_id = ?))`,
    ctx.user.id, ctx.user.id
  )?.n ?? 0;

  const openVerifications = get(
    `SELECT COUNT(*) AS n FROM verification_requests WHERE assigned_to = ? AND status = 'open'`,
    ctx.user.id
  )?.n ?? 0;

  const statusMap = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));

  return {
    people: personCount,
    living: living?.living ?? 0,
    deceased: (living?.total ?? 0) - (living?.living ?? 0),
    relationships: {
      verified: statusMap.verified ?? 0,
      unverified: statusMap.unverified ?? 0,
      possible: statusMap.possible ?? 0,
      verificationRequested: statusMap.verification_requested ?? 0,
      rejected: statusMap.rejected ?? 0,
      total: Object.values(statusMap).reduce((a, b) => a + b, 0),
    },
    generations: generationSpan,
    possibleMatches: openMatches,
    verificationRequests: openVerifications,
    collaborators: get(
      `SELECT COUNT(*) AS n FROM tree_collaborators WHERE owner_user_id = ? AND status = 'active'`,
      ctx.user.id
    )?.n ?? 0,
  };
});

export default router;
