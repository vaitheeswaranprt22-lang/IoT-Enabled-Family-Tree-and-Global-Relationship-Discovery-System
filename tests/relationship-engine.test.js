/**
 * Relationship engine: path finding and kinship naming.
 *
 * The fixture is a four-generation family with two branches that share a
 * great-grandparent couple, plus an adoption, a step-parent and a second
 * marriage -- the cases where naive kinship code gets it wrong.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph } from './helpers/build-graph.js';
import { findPaths, commonAncestors, immediateFamily, ancestorsOf, descendantsOf, wouldCreateCycle } from '../backend/engine/graph.js';
import { describePath, vShapeTerm, segmentPath } from '../backend/engine/relationship.js';

/*
  Generation 1   : george  x  martha
  Generation 2   : henry (m)      and      irene (f)     <- siblings
                   henry x julia            irene x karl
  Generation 3   : liam, mia (children of henry+julia)
                   noah        (child of irene+karl)
  Generation 4   : olivia (child of liam)
                   peter  (child of noah)
*/
const fixture = buildGraph({
  people: {
    george: { gender: 'male' },   martha: { gender: 'female' },
    henry:  { gender: 'male' },   julia:  { gender: 'female' },
    irene:  { gender: 'female' }, karl:   { gender: 'male' },
    liam:   { gender: 'male' },   mia:    { gender: 'female' },
    noah:   { gender: 'male' },
    olivia: { gender: 'female' }, peter:  { gender: 'male' },
  },
  edges: [
    ['george', 'spouse', 'martha'],
    ['george', 'parent', 'henry'], ['martha', 'parent', 'henry'],
    ['george', 'parent', 'irene'], ['martha', 'parent', 'irene'],
    ['henry', 'spouse', 'julia'],
    ['irene', 'spouse', 'karl'],
    ['henry', 'parent', 'liam'], ['julia', 'parent', 'liam'],
    ['henry', 'parent', 'mia'],  ['julia', 'parent', 'mia'],
    ['irene', 'parent', 'noah'], ['karl', 'parent', 'noah'],
    ['liam', 'parent', 'olivia'],
    ['noah', 'parent', 'peter'],
  ],
});

const { graph, id, genderOf, nameOf } = fixture;

/** Convenience: shortest path from a to b, described. */
function describe(aKey, bKey) {
  const result = findPaths(graph, id(aKey), id(bKey));
  assert.ok(result.found, `expected a path from ${aKey} to ${bKey}`);
  return describePath(graph, result.paths[0].steps, genderOf, nameOf);
}

test('vShapeTerm implements the standard kinship table', () => {
  assert.equal(vShapeTerm(1, 0, { gender: 'male' }).label, 'father');
  assert.equal(vShapeTerm(0, 1, { gender: 'female' }).label, 'daughter');
  assert.equal(vShapeTerm(2, 0, { gender: 'female' }).label, 'grandmother');
  assert.equal(vShapeTerm(3, 0, { gender: 'male' }).label, 'great-grandfather');
  assert.equal(vShapeTerm(4, 0, { gender: 'male' }).label, 'great-great-grandfather');
  assert.equal(vShapeTerm(0, 3, { gender: 'female' }).label, 'great-granddaughter');

  assert.equal(vShapeTerm(1, 1, { gender: 'male', sharedParents: 2 }).label, 'brother');
  assert.equal(vShapeTerm(1, 1, { gender: 'male', sharedParents: 1 }).label, 'half-brother');

  assert.equal(vShapeTerm(2, 1, { gender: 'female' }).label, 'aunt');
  assert.equal(vShapeTerm(3, 1, { gender: 'male' }).label, 'great-uncle');
  assert.equal(vShapeTerm(1, 2, { gender: 'male' }).label, 'nephew');
  assert.equal(vShapeTerm(1, 3, { gender: 'female' }).label, 'great-niece');

  assert.equal(vShapeTerm(2, 2, { gender: 'male' }).label, 'first cousin');
  assert.equal(vShapeTerm(3, 3, { gender: 'male' }).label, 'second cousin');
  assert.equal(vShapeTerm(4, 4, { gender: 'male' }).label, 'third cousin');
  assert.equal(vShapeTerm(3, 2, { gender: 'male' }).label, 'first cousin once removed');
  assert.equal(vShapeTerm(2, 3, { gender: 'male' }).label, 'first cousin once removed');
  assert.equal(vShapeTerm(4, 2, { gender: 'male' }).label, 'first cousin twice removed');
  assert.equal(vShapeTerm(5, 3, { gender: 'male' }).label, 'second cousin twice removed');
});

test('direct ancestors and descendants are named correctly', () => {
  assert.equal(describe('liam', 'henry').label, 'father');
  assert.equal(describe('liam', 'julia').label, 'mother');
  assert.equal(describe('liam', 'george').label, 'grandfather');
  assert.equal(describe('olivia', 'george').label, 'great-grandfather');
  assert.equal(describe('george', 'olivia').label, 'great-granddaughter');
  assert.equal(describe('henry', 'liam').label, 'son');
});

test('siblings, uncles and cousins resolve through the shared ancestor', () => {
  assert.equal(describe('liam', 'mia').label, 'sister');
  assert.equal(describe('henry', 'irene').label, 'sister');
  assert.equal(describe('liam', 'irene').label, 'aunt');
  assert.equal(describe('liam', 'noah').label, 'first cousin');
  assert.equal(describe('olivia', 'noah').label, 'first cousin once removed');
  assert.equal(describe('olivia', 'peter').label, 'second cousin');
  assert.equal(describe('noah', 'olivia').label, 'first cousin once removed');
});

test('a sibling path is biological and reports its shared ancestors', () => {
  const rel = describe('liam', 'mia');
  assert.equal(rel.isBiological, true);
  assert.equal(rel.viaMarriage, false);
  assert.equal(rel.category, 'biological');

  const shared = commonAncestors(graph, id('liam'), id('mia'));
  const sharedIds = shared.map((s) => s.personId);
  assert.ok(sharedIds.includes(id('henry')), 'henry should be a most-recent common ancestor');
  assert.ok(sharedIds.includes(id('julia')), 'julia should be a most-recent common ancestor');
  // george/martha are further back and must not be reported as *most recent*.
  assert.ok(!sharedIds.includes(id('george')));
});

test('second cousins share a great-grandparent couple', () => {
  const shared = commonAncestors(graph, id('olivia'), id('peter'));
  assert.ok(shared.length >= 1);
  assert.ok(shared.every((s) => s.generationsFromA === 3 && s.generationsFromB === 3));
  const ids = shared.map((s) => s.personId);
  assert.ok(ids.includes(id('george')) || ids.includes(id('martha')));
});

test('paths crossing a marriage are labelled as in-law, not blood', () => {
  // liam -> henry (father) -> irene (sister) -> karl (husband)
  const rel = describe('liam', 'karl');
  assert.equal(rel.viaMarriage, true);
  assert.equal(rel.isBiological, false);
  assert.equal(rel.category, 'marital');
  assert.equal(rel.label, 'uncle by marriage');

  // A spouse's parent is a parent-in-law.
  const inLaw = describe('julia', 'george');
  assert.equal(inLaw.viaMarriage, true);
  assert.equal(inLaw.label, 'father-in-law');
  assert.equal(inLaw.isBiological, false);
});

test('spouse and sibling-in-law idioms', () => {
  assert.equal(describe('henry', 'julia').label, 'wife');
  assert.equal(describe('julia', 'henry').label, 'husband');
  // julia -> henry (husband) -> irene (sister)  ==> sister-in-law
  assert.equal(describe('julia', 'irene').label, 'sister-in-law');
});

test('adoptive and step edges survive into the label', () => {
  const f = buildGraph({
    people: {
      dad: { gender: 'male' }, kid: { gender: 'male' },
      stepmum: { gender: 'female' }, adoptive: { gender: 'female' }, child: { gender: 'female' },
    },
    edges: [
      ['dad', 'parent', 'kid'],
      ['dad', 'spouse', 'stepmum'],
      ['adoptive', 'parent', 'child', 'adoptive'],
    ],
  });
  const kidToStep = describePath(
    f.graph,
    findPaths(f.graph, f.id('kid'), f.id('stepmum')).paths[0].steps,
    f.genderOf, f.nameOf
  );
  assert.equal(kidToStep.label, 'step-mother');
  assert.equal(kidToStep.isBiological, false);
  assert.equal(kidToStep.category, 'marital');

  const childToAdoptive = describePath(
    f.graph,
    findPaths(f.graph, f.id('child'), f.id('adoptive')).paths[0].steps,
    f.genderOf, f.nameOf
  );
  assert.equal(childToAdoptive.label, 'adoptive mother');
  assert.equal(childToAdoptive.category, 'adoptive');
  assert.equal(childToAdoptive.isBiological, false);
});

test('half siblings are distinguished from full siblings', () => {
  const f = buildGraph({
    people: { dad: { gender: 'male' }, mum1: { gender: 'female' }, mum2: { gender: 'female' },
              a: { gender: 'male' }, b: { gender: 'female' }, c: { gender: 'female' } },
    edges: [
      ['dad', 'parent', 'a'], ['mum1', 'parent', 'a'],
      ['dad', 'parent', 'b'], ['mum1', 'parent', 'b'],
      ['dad', 'parent', 'c'], ['mum2', 'parent', 'c'],
    ],
  });
  const full = describePath(f.graph, findPaths(f.graph, f.id('a'), f.id('b')).paths[0].steps, f.genderOf, f.nameOf);
  const half = describePath(f.graph, findPaths(f.graph, f.id('a'), f.id('c')).paths[0].steps, f.genderOf, f.nameOf);
  assert.equal(full.label, 'sister');
  assert.equal(half.label, 'half-sister');
});

test('the long cross-branch path from the brief is found and described', () => {
  // A -> father -> grandfather -> grandfather's spouse -> spouse's sibling -> that sibling's child
  const f = buildGraph({
    people: {
      userA: { gender: 'male' }, father: { gender: 'male' }, grandpa: { gender: 'male' },
      grandma: { gender: 'female' }, grandmaSister: { gender: 'female' }, cousinChild: { gender: 'male' },
    },
    edges: [
      ['father', 'parent', 'userA'],
      ['grandpa', 'parent', 'father'],
      ['grandpa', 'spouse', 'grandma'],
      ['grandma', 'sibling', 'grandmaSister'],
      ['grandmaSister', 'parent', 'cousinChild'],
    ],
  });
  const result = findPaths(f.graph, f.id('userA'), f.id('cousinChild'));
  assert.ok(result.found);
  const rel = describePath(f.graph, result.paths[0].steps, f.genderOf, f.nameOf);
  assert.equal(rel.degreeOfSeparation, 5);
  assert.equal(rel.viaMarriage, true);
  assert.equal(rel.isBiological, false);
  assert.match(rel.narrative, /your father/);
  assert.equal(rel.chain.length, 5);
  assert.equal(rel.chain[2].direction, 'spouse');
});

test('no path is reported when two trees are unconnected', () => {
  const f = buildGraph({
    people: { a: {}, b: {}, x: {}, y: {} },
    edges: [['a', 'parent', 'b'], ['x', 'parent', 'y']],
  });
  const result = findPaths(f.graph, f.id('b'), f.id('y'));
  assert.equal(result.found, false);
  assert.equal(result.paths.length, 0);
});

test('multiple distinct paths are returned when they exist', () => {
  // Double first cousins: two brothers marry two sisters.
  const f = buildGraph({
    people: { b1: { gender: 'male' }, b2: { gender: 'male' }, s1: { gender: 'female' }, s2: { gender: 'female' },
              gpa: { gender: 'male' }, gma: { gender: 'female' },
              kid1: { gender: 'male' }, kid2: { gender: 'female' } },
    edges: [
      ['gpa', 'parent', 'b1'], ['gpa', 'parent', 'b2'],
      ['gma', 'parent', 's1'], ['gma', 'parent', 's2'],
      ['b1', 'parent', 'kid1'], ['s1', 'parent', 'kid1'],
      ['b2', 'parent', 'kid2'], ['s2', 'parent', 'kid2'],
    ],
  });
  const result = findPaths(f.graph, f.id('kid1'), f.id('kid2'), { maxPaths: 5 });
  assert.ok(result.found);
  assert.ok(result.paths.length >= 2, 'both the paternal and maternal route should be found');
  const labels = result.paths.map((p) => describePath(f.graph, p.steps, f.genderOf, f.nameOf).label);
  assert.ok(labels.every((l) => l === 'first cousin'), `expected first cousin, got ${labels.join(', ')}`);
});

test('graph helpers: ancestors, descendants, immediate family, cycle guard', () => {
  const anc = ancestorsOf(graph, id('olivia'));
  assert.equal(anc.get(id('liam')).gen, 1);
  assert.equal(anc.get(id('henry')).gen, 2);
  assert.equal(anc.get(id('george')).gen, 3);
  assert.ok(!anc.has(id('karl')), 'an uncle by marriage is not an ancestor');

  const desc = descendantsOf(graph, id('george'));
  assert.equal(desc.get(id('henry')).gen, 1);
  assert.equal(desc.get(id('olivia')).gen, 3);

  const fam = immediateFamily(graph, id('liam'));
  assert.equal(fam.parents.length, 2);
  assert.equal(fam.children.length, 1);
  assert.equal(fam.siblings.length, 1);
  assert.equal(fam.siblings[0].to, id('mia'));
  assert.equal(fam.siblings[0].sharedParents, 2);

  // george is already an ancestor of olivia, so olivia cannot become his parent.
  assert.equal(wouldCreateCycle(graph, id('olivia'), id('george')), true);
  assert.equal(wouldCreateCycle(graph, id('george'), id('george')), true);
  assert.equal(wouldCreateCycle(graph, id('karl'), id('olivia')), false);
});

test('segmentPath splits at marriages and direction reversals', () => {
  const steps = [
    { dir: 'up', to: 2, subtype: 'biological' },
    { dir: 'up', to: 3, subtype: 'biological' },
    { dir: 'spouse', to: 4, subtype: 'married' },
    { dir: 'down', to: 5, subtype: 'biological' },
  ];
  const segs = segmentPath(steps);
  assert.equal(segs.length, 3);
  assert.equal(segs[0].kind, 'v');
  assert.equal(segs[0].up, 2);
  assert.equal(segs[1].kind, 'spouse');
  assert.equal(segs[2].kind, 'v');
  assert.equal(segs[2].down, 1);
});
