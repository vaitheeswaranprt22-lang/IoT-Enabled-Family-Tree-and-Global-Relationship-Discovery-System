/**
 * Family graph: loading, traversal and path finding.
 *
 * MODEL
 *   Persons are nodes. Three canonical stored edge types become four traversal
 *   directions:
 *       parent edge (P -> C)  gives  C --up--> P   and   P --down--> C
 *       spouse edge (A, B)    gives  A <-spouse-> B
 *       sibling edge (A, B)   gives  A <-sibling-> B   (explicit only)
 *
 *   Siblings are normally NOT stored. Two children of the same parent are
 *   connected by up-then-down, which is both the genealogically honest
 *   representation and what lets the engine distinguish full siblings (two
 *   shared parents) from half siblings (one). Explicit sibling edges exist only
 *   for the case where the shared parents are unknown.
 *
 *   By default only `status = 'verified'` edges are traversed. Unverified edges
 *   can be included explicitly, and every returned path reports which statuses
 *   it relied on, so the UI can never present a guess as a fact.
 */
import { all } from '../db/index.js';
import config from '../config.js';

/** Bumped by any write that changes the graph, invalidating the cache. */
let graphVersion = 0;
const graphCache = new Map(); // cacheKey -> { version, graph }

export function bumpGraphVersion() {
  graphVersion += 1;
  graphCache.clear();
}

export const currentGraphVersion = () => graphVersion;

/**
 * Loads the whole edge set into an adjacency map.
 *
 * For the scale this project targets (tens of thousands of persons) an
 * in-memory adjacency map is far faster than recursive SQL and is rebuilt only
 * when the graph actually changes. `docs/architecture.md` describes the
 * partitioned-loading path for larger deployments.
 */
export function loadGraph({ statuses = ['verified'] } = {}) {
  const key = statuses.slice().sort().join(',');
  const cached = graphCache.get(key);
  if (cached && cached.version === graphVersion) return cached.graph;

  const placeholders = statuses.map(() => '?').join(',');
  const rows = all(
    `SELECT id, from_person_id, to_person_id, type, subtype, status
     FROM relationships
     WHERE status IN (${placeholders})`,
    ...statuses
  );

  /** @type {Map<number, Array<{to:number,dir:string,subtype:string,status:string,relId:number}>>} */
  const adj = new Map();
  const push = (from, edge) => {
    let list = adj.get(from);
    if (!list) { list = []; adj.set(from, list); }
    list.push(edge);
  };

  for (const r of rows) {
    if (r.type === 'parent') {
      // to_person_id is the child; the child goes UP to the parent.
      push(r.to_person_id, { to: r.from_person_id, dir: 'up', subtype: r.subtype, status: r.status, relId: r.id });
      push(r.from_person_id, { to: r.to_person_id, dir: 'down', subtype: r.subtype, status: r.status, relId: r.id });
    } else if (r.type === 'spouse') {
      push(r.from_person_id, { to: r.to_person_id, dir: 'spouse', subtype: r.subtype, status: r.status, relId: r.id });
      push(r.to_person_id, { to: r.from_person_id, dir: 'spouse', subtype: r.subtype, status: r.status, relId: r.id });
    } else if (r.type === 'sibling') {
      push(r.from_person_id, { to: r.to_person_id, dir: 'sibling', subtype: r.subtype, status: r.status, relId: r.id });
      push(r.to_person_id, { to: r.from_person_id, dir: 'sibling', subtype: r.subtype, status: r.status, relId: r.id });
    }
  }

  const graph = { adj, edgeCount: rows.length, statuses, version: graphVersion };
  graphCache.set(key, { version: graphVersion, graph });
  return graph;
}

export const neighbors = (graph, id) => graph.adj.get(id) ?? [];

/** Breadth-first distances from `startId`, bounded by depth and node budget. */
export function bfsDistances(graph, startId, maxDepth, budget = config.engine.traversalNodeBudget) {
  const dist = new Map([[startId, 0]]);
  let frontier = [startId];
  let visited = 1;

  for (let depth = 1; depth <= maxDepth && frontier.length; depth += 1) {
    const next = [];
    for (const node of frontier) {
      for (const edge of neighbors(graph, node)) {
        if (dist.has(edge.to)) continue;
        dist.set(edge.to, depth);
        next.push(edge.to);
        visited += 1;
        if (visited > budget) return { dist, truncated: true };
      }
    }
    frontier = next;
  }
  return { dist, truncated: false };
}

/**
 * Finds up to `maxPaths` short paths between two persons.
 *
 * Strategy: BFS outward from both endpoints to get distance labels, take the
 * shortest distance `d`, then enumerate paths with a small slack so that
 * genuinely distinct routes (double cousins, two marriages linking the same
 * branches) all surface rather than only one arbitrary shortest path.
 *
 * @returns {{found:boolean, shortestLength:number|null, paths:Array, truncated:boolean, reason?:string}}
 */
export function findPaths(graph, fromId, toId, options = {}) {
  const maxDepth = options.maxDepth ?? config.engine.maxPathDepth;
  const maxPaths = options.maxPaths ?? config.engine.maxPathsReturned;
  const slack = options.slack ?? 2;
  const budget = options.budget ?? config.engine.traversalNodeBudget;

  if (fromId === toId) {
    return { found: true, shortestLength: 0, paths: [{ nodes: [fromId], steps: [] }], truncated: false, sameNode: true };
  }
  if (!graph.adj.has(fromId) || !graph.adj.has(toId)) {
    return { found: false, shortestLength: null, paths: [], truncated: false, reason: 'isolated' };
  }

  const halfDepth = Math.ceil(maxDepth / 2) + slack;
  const forward = bfsDistances(graph, fromId, halfDepth, budget);
  const backward = bfsDistances(graph, toId, halfDepth, budget);

  // Shortest total distance over every node reachable from both ends.
  let shortest = Infinity;
  for (const [node, dA] of forward.dist) {
    const dB = backward.dist.get(node);
    if (dB === undefined) continue;
    if (dA + dB < shortest) shortest = dA + dB;
  }
  if (!Number.isFinite(shortest) || shortest > maxDepth) {
    return {
      found: false,
      shortestLength: null,
      paths: [],
      truncated: forward.truncated || backward.truncated,
      reason: forward.truncated || backward.truncated ? 'budget' : 'no-path',
    };
  }

  const maxLimit = Math.min(shortest + slack, maxDepth);
  const distToTarget = backward.dist;
  const paths = [];
  let expansions = 0;

  /**
   * Depth-first enumeration, pruned by the backward distance label: a node is
   * only worth entering if it can still reach the target within `limit`.
   *
   * This runs as ITERATIVE DEEPENING -- one pass per exact path length,
   * shortest first. A plain depth-bounded DFS explores in neighbour order, so
   * it can return a long path before a short one; when the caller asks for
   * only one or two paths it would then be handed a detour and told it was
   * the shortest. Deepening one length at a time guarantees the results come
   * out in nondecreasing order, and accepting only paths of exactly the
   * current length means no pass can repeat an earlier pass's work.
   */
  const visited = new Set([fromId]);
  const stackNodes = [fromId];
  const stackSteps = [];

  const walk = (node, depth, limit) => {
    if (paths.length >= maxPaths || expansions > budget) return;
    if (node === toId) {
      if (depth === limit) paths.push({ nodes: stackNodes.slice(), steps: stackSteps.slice() });
      return;
    }
    if (depth >= limit) return;

    // Visit the most promising neighbours first: those closest to the target.
    const candidates = neighbors(graph, node)
      .filter((edge) => {
        if (visited.has(edge.to)) return false;
        const remaining = distToTarget.get(edge.to);
        return remaining !== undefined && depth + 1 + remaining <= limit;
      })
      .sort((a, b) => distToTarget.get(a.to) - distToTarget.get(b.to));

    for (const edge of candidates) {
      expansions += 1;
      visited.add(edge.to);
      stackNodes.push(edge.to);
      stackSteps.push({ from: node, to: edge.to, dir: edge.dir, subtype: edge.subtype, status: edge.status, relId: edge.relId });

      walk(edge.to, depth + 1, limit);

      stackSteps.pop();
      stackNodes.pop();
      visited.delete(edge.to);
      if (paths.length >= maxPaths) return;
    }
  };

  for (let limit = shortest; limit <= maxLimit && paths.length < maxPaths; limit += 1) {
    walk(fromId, 0, limit);
    if (expansions > budget) break;
  }

  return {
    found: paths.length > 0,
    // Taken from the bidirectional BFS, which is exact, rather than from
    // whichever paths the enumeration happened to collect.
    shortestLength: shortest,
    paths,
    truncated: forward.truncated || backward.truncated || expansions > budget,
  };
}

/**
 * All ancestors of `personId` with their generation distance.
 * Follows only `up` edges, so marriage never turns an in-law into an ancestor.
 * @returns {Map<number, {gen:number, biological:boolean}>}
 */
export function ancestorsOf(graph, personId, maxGenerations = 40) {
  const result = new Map();
  let frontier = [{ id: personId, biological: true }];
  const seen = new Set([personId]);

  for (let gen = 1; gen <= maxGenerations && frontier.length; gen += 1) {
    const next = [];
    for (const node of frontier) {
      for (const edge of neighbors(graph, node.id)) {
        if (edge.dir !== 'up') continue;
        const biological = node.biological && edge.subtype === 'biological';
        if (seen.has(edge.to)) {
          // Keep the biologically strongest claim if reached twice.
          const existing = result.get(edge.to);
          if (existing && biological && !existing.biological) existing.biological = true;
          continue;
        }
        seen.add(edge.to);
        result.set(edge.to, { gen, biological });
        next.push({ id: edge.to, biological });
      }
    }
    frontier = next;
  }
  return result;
}

/** All descendants of `personId`, following only `down` edges. */
export function descendantsOf(graph, personId, maxGenerations = 40) {
  const result = new Map();
  let frontier = [personId];
  const seen = new Set([personId]);

  for (let gen = 1; gen <= maxGenerations && frontier.length; gen += 1) {
    const next = [];
    for (const id of frontier) {
      for (const edge of neighbors(graph, id)) {
        if (edge.dir !== 'down' || seen.has(edge.to)) continue;
        seen.add(edge.to);
        result.set(edge.to, { gen });
        next.push(edge.to);
      }
    }
    frontier = next;
  }
  return result;
}

/**
 * Common ancestors of two persons, nearest first.
 * "Nearest" = smallest total generation distance, which is the ancestor a
 * genealogist would name as the link between two branches.
 */
export function commonAncestors(graph, aId, bId, maxGenerations = 40) {
  const ancA = ancestorsOf(graph, aId, maxGenerations);
  const ancB = ancestorsOf(graph, bId, maxGenerations);

  // A person can be both an ancestor of one and the other party themselves.
  if (ancA.has(bId)) ancB.set(bId, { gen: 0, biological: true });
  if (ancB.has(aId)) ancA.set(aId, { gen: 0, biological: true });

  const shared = [];
  for (const [id, infoA] of ancA) {
    const infoB = ancB.get(id);
    if (!infoB) continue;
    shared.push({
      personId: id,
      generationsFromA: infoA.gen,
      generationsFromB: infoB.gen,
      total: infoA.gen + infoB.gen,
      biological: infoA.biological && infoB.biological,
    });
  }
  shared.sort((x, y) => x.total - y.total || x.generationsFromA - y.generationsFromA);

  // Keep only the *most recent* common ancestors: drop any ancestor that is
  // itself an ancestor of another common ancestor (great-grandparents are
  // technically shared too, but naming them would be misleading).
  const mostRecent = [];
  for (const candidate of shared) {
    const isAncestorOfKept = mostRecent.some((kept) => {
      const ancOfKept = ancestorsOf(graph, kept.personId, maxGenerations);
      return ancOfKept.has(candidate.personId);
    });
    if (!isAncestorOfKept) mostRecent.push(candidate);
    if (mostRecent.length >= 4) break;
  }
  return mostRecent;
}

/** Direct family of one person, grouped -- powers the tree's expand controls. */
export function immediateFamily(graph, personId) {
  const out = { parents: [], children: [], spouses: [], siblings: [] };
  const parentIds = [];

  for (const edge of neighbors(graph, personId)) {
    if (edge.dir === 'up') { out.parents.push(edge); parentIds.push(edge.to); }
    else if (edge.dir === 'down') out.children.push(edge);
    else if (edge.dir === 'spouse') out.spouses.push(edge);
    else if (edge.dir === 'sibling') out.siblings.push({ ...edge, derived: false, sharedParents: 0 });
  }

  // Derive siblings from shared parents, counting how many parents are shared
  // so the namer can say "half" versus "full".
  const sharedCount = new Map();
  for (const pid of parentIds) {
    for (const edge of neighbors(graph, pid)) {
      if (edge.dir !== 'down' || edge.to === personId) continue;
      sharedCount.set(edge.to, (sharedCount.get(edge.to) ?? 0) + 1);
    }
  }
  const explicit = new Set(out.siblings.map((s) => s.to));
  for (const [siblingId, count] of sharedCount) {
    if (explicit.has(siblingId)) continue;
    out.siblings.push({
      to: siblingId,
      dir: 'sibling',
      subtype: count >= 2 ? 'full' : 'half',
      status: 'verified',
      relId: null,
      derived: true,
      sharedParents: count,
    });
  }
  return out;
}

/**
 * Collects the sub-graph around a focus person for rendering: `up` generations
 * of ancestors and `down` generations of descendants, plus their spouses and
 * siblings. Progressive loading means the client never has to hold the whole
 * graph, however large the tree becomes.
 */
export function expandAround(graph, focusId, { up = 3, down = 3, includeSpouses = true, includeSiblings = true, nodeCap = 1500 } = {}) {
  const nodes = new Map(); // id -> { generation, via }
  nodes.set(focusId, { generation: 0, role: 'focus' });

  const addNode = (id, generation, role) => {
    if (nodes.size >= nodeCap) return false;
    if (!nodes.has(id)) nodes.set(id, { generation, role });
    return true;
  };

  // Ancestors (negative-free convention: generation increases upward).
  let frontier = [focusId];
  for (let g = 1; g <= up && frontier.length; g += 1) {
    const next = [];
    for (const id of frontier) {
      for (const edge of neighbors(graph, id)) {
        if (edge.dir !== 'up' || nodes.has(edge.to)) continue;
        if (!addNode(edge.to, g, 'ancestor')) break;
        next.push(edge.to);
      }
    }
    frontier = next;
  }

  // Descendants.
  frontier = [focusId];
  for (let g = 1; g <= down && frontier.length; g += 1) {
    const next = [];
    for (const id of frontier) {
      for (const edge of neighbors(graph, id)) {
        if (edge.dir !== 'down' || nodes.has(edge.to)) continue;
        if (!addNode(edge.to, -g, 'descendant')) break;
        next.push(edge.to);
      }
    }
    frontier = next;
  }

  // Siblings of everyone collected so far (same generation).
  if (includeSiblings) {
    for (const [id, info] of [...nodes]) {
      const fam = immediateFamily(graph, id);
      for (const sib of fam.siblings) addNode(sib.to, info.generation, 'sibling');
    }
  }

  // Spouses sit in the same generation band as their partner.
  if (includeSpouses) {
    for (const [id, info] of [...nodes]) {
      for (const edge of neighbors(graph, id)) {
        if (edge.dir !== 'spouse') continue;
        addNode(edge.to, info.generation, 'spouse');
      }
    }
  }

  // Every edge whose endpoints are both inside the collected set.
  const edges = [];
  const emitted = new Set();
  for (const id of nodes.keys()) {
    for (const edge of neighbors(graph, id)) {
      if (!nodes.has(edge.to)) continue;
      const key = edge.relId ? `r${edge.relId}` : `${Math.min(id, edge.to)}-${Math.max(id, edge.to)}-${edge.dir}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      edges.push({
        relId: edge.relId,
        from: edge.dir === 'up' ? edge.to : id,
        to: edge.dir === 'up' ? id : edge.to,
        dir: edge.dir,
        subtype: edge.subtype,
        status: edge.status,
      });
    }
  }

  return { nodes, edges, truncated: nodes.size >= nodeCap };
}

/**
 * Rejects a parent edge that would make someone their own ancestor.
 * Called before writing any `parent` relationship.
 */
export function wouldCreateCycle(graph, parentId, childId) {
  if (parentId === childId) return true;
  // If the proposed parent is already a descendant of the child, the edge
  // closes a loop.
  const descendants = descendantsOf(graph, childId, 60);
  return descendants.has(parentId);
}
