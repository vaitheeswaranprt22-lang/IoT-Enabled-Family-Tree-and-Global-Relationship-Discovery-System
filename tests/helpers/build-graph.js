/**
 * Builds an in-memory graph object matching what `loadGraph()` returns, so the
 * traversal and naming logic can be tested without touching a database.
 *
 * Spec format:
 *   people: { alice: { gender: 'female' }, ... }
 *   edges:  [ ['bob','parent','alice'],                 // bob is alice's parent
 *             ['bob','spouse','carol'],
 *             ['dee','sibling','eve','half'] ]          // optional subtype
 */
export function buildGraph(spec) {
  const ids = new Map();
  const names = new Map();
  const genders = new Map();
  let next = 1;

  const idOf = (key) => {
    if (!ids.has(key)) {
      ids.set(key, next);
      names.set(next, spec.people?.[key]?.name ?? key);
      genders.set(next, spec.people?.[key]?.gender ?? 'unknown');
      next += 1;
    }
    return ids.get(key);
  };

  for (const key of Object.keys(spec.people ?? {})) idOf(key);

  const adj = new Map();
  const push = (from, edge) => {
    let list = adj.get(from);
    if (!list) { list = []; adj.set(from, list); }
    list.push(edge);
  };

  let relId = 1;
  for (const [a, type, b, subtype] of spec.edges ?? []) {
    const idA = idOf(a);
    const idB = idOf(b);
    const status = 'verified';
    if (type === 'parent') {
      const st = subtype ?? 'biological';
      push(idB, { to: idA, dir: 'up', subtype: st, status, relId });
      push(idA, { to: idB, dir: 'down', subtype: st, status, relId });
    } else if (type === 'spouse') {
      const st = subtype ?? 'married';
      push(idA, { to: idB, dir: 'spouse', subtype: st, status, relId });
      push(idB, { to: idA, dir: 'spouse', subtype: st, status, relId });
    } else if (type === 'sibling') {
      const st = subtype ?? 'full';
      push(idA, { to: idB, dir: 'sibling', subtype: st, status, relId });
      push(idB, { to: idA, dir: 'sibling', subtype: st, status, relId });
    }
    relId += 1;
  }

  return {
    graph: { adj, edgeCount: relId - 1, statuses: ['verified'], version: 0 },
    id: (key) => ids.get(key),
    genderOf: (id) => genders.get(id) ?? 'unknown',
    nameOf: (id) => names.get(id) ?? `#${id}`,
  };
}
