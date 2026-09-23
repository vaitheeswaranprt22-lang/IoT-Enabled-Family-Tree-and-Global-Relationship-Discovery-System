/**
 * Turns a graph path into a human relationship description.
 *
 * The engine never invents a relationship: it reads the exact sequence of
 * stored edges and names it. Three properties matter for correctness:
 *
 *   1. A path that crosses a marriage is NOT a blood relationship. It is
 *      labelled as such ("by marriage" / "-in-law") and `isBiological` is false.
 *   2. Adoptive and step edges are carried through to the label rather than
 *      being flattened into "parent".
 *   3. Cousin degrees follow the standard genealogical formula:
 *          degree  = min(up, down) - 1
 *          removed = |up - down|
 *      so two people sharing a great-grandparent at equal depth are second
 *      cousins, and an unequal depth adds "once/twice removed".
 */
import { immediateFamily } from './graph.js';

const ORDINALS = [
  'zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth',
  'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth',
];

const ordinal = (n) => ORDINALS[n] ?? `${n}th`;

const timesRemoved = (n) => {
  if (n === 1) return 'once removed';
  if (n === 2) return 'twice removed';
  if (n === 3) return 'three times removed';
  return `${n} times removed`;
};

/** "great-", "great-great-", then a compact numeric form. */
function greatPrefix(count) {
  if (count <= 0) return '';
  if (count <= 3) return 'great-'.repeat(count);
  return `${count}x great-`;
}

const byGender = (gender, male, female, neutral) => {
  if (gender === 'male') return male;
  if (gender === 'female') return female;
  return neutral;
};

const possessive = (gender) => byGender(gender, 'his', 'her', 'their');

// ------------------------------------------------------ single-step terms ---

/** Names one edge, from the perspective of the person at the start of it. */
export function stepTerm(step, targetGender) {
  switch (step.dir) {
    case 'up': {
      const base = byGender(targetGender, 'father', 'mother', 'parent');
      if (step.subtype === 'adoptive') return `adoptive ${base}`;
      if (step.subtype === 'step') return `step-${base}`;
      if (step.subtype === 'foster') return `foster ${base}`;
      if (step.subtype === 'guardian') return `legal guardian`;
      return base;
    }
    case 'down': {
      const base = byGender(targetGender, 'son', 'daughter', 'child');
      if (step.subtype === 'adoptive') return `adopted ${base}`;
      if (step.subtype === 'step') return `step-${base}`;
      if (step.subtype === 'foster') return `foster ${base}`;
      return base;
    }
    case 'spouse': {
      const base = byGender(targetGender, 'husband', 'wife', 'spouse');
      if (step.subtype === 'divorced') return `former ${base}`;
      if (step.subtype === 'widowed') return `late ${base}`;
      if (step.subtype === 'partner') return 'partner';
      return base;
    }
    case 'sibling': {
      const base = byGender(targetGender, 'brother', 'sister', 'sibling');
      if (step.subtype === 'half') return `half-${base}`;
      if (step.subtype === 'step') return `step-${base}`;
      if (step.subtype === 'adoptive') return `adoptive ${base}`;
      return base;
    }
    default:
      return 'relative';
  }
}

// -------------------------------------------------- consanguineous naming ---

/**
 * Names a "V" through a common ancestor: `up` steps up, then `down` steps down.
 * This is the classic genealogical naming table.
 *
 * @param {number} up
 * @param {number} down
 * @param {object} ctx  { gender, sharedParents }
 */
export function vShapeTerm(up, down, ctx = {}) {
  const gender = ctx.gender ?? 'unknown';

  if (up === 0 && down === 0) return { label: 'self', degree: 0 };

  // Straight up: parent, grandparent, great-grandparent, ...
  if (down === 0) {
    if (up === 1) return { label: byGender(gender, 'father', 'mother', 'parent'), degree: 1 };
    const g = greatPrefix(up - 2);
    return { label: `${g}${byGender(gender, 'grandfather', 'grandmother', 'grandparent')}`, degree: up };
  }

  // Straight down: child, grandchild, great-grandchild, ...
  if (up === 0) {
    if (down === 1) return { label: byGender(gender, 'son', 'daughter', 'child'), degree: 1 };
    const g = greatPrefix(down - 2);
    return { label: `${g}${byGender(gender, 'grandson', 'granddaughter', 'grandchild')}`, degree: down };
  }

  // Siblings.
  if (up === 1 && down === 1) {
    const base = byGender(gender, 'brother', 'sister', 'sibling');
    const half = ctx.sharedParents !== undefined && ctx.sharedParents < 2;
    return { label: half ? `half-${base}` : base, degree: 2, half };
  }

  // Parent's sibling: uncle / aunt, with "great-" for each extra generation up.
  if (down === 1) {
    const g = greatPrefix(up - 2);
    return { label: `${g}${byGender(gender, 'uncle', 'aunt', 'uncle or aunt')}`, degree: up + down };
  }

  // Sibling's child: nephew / niece.
  if (up === 1) {
    const g = greatPrefix(down - 2);
    return { label: `${g}${byGender(gender, 'nephew', 'niece', 'nephew or niece')}`, degree: up + down };
  }

  // Cousins.
  const degree = Math.min(up, down) - 1;
  const removed = Math.abs(up - down);
  const label = removed === 0
    ? `${ordinal(degree)} cousin`
    : `${ordinal(degree)} cousin ${timesRemoved(removed)}`;
  return { label, degree: up + down, cousinDegree: degree, removed };
}

// ------------------------------------------------------------ segmenting ---

/**
 * Splits a path into segments the namer can handle:
 *   - 'v'      : a run of `up` steps followed by `down` steps (one common ancestor)
 *   - 'spouse' : a single marriage hop
 *   - 'sibling': an explicit sibling edge (parents unknown)
 *
 * A new V-segment starts whenever an `up` follows a `down`, because that means
 * the path has left one family and entered another.
 */
export function segmentPath(steps) {
  const segments = [];
  let current = null;

  for (const step of steps) {
    if (step.dir === 'spouse' || step.dir === 'sibling') {
      if (current) { segments.push(current); current = null; }
      segments.push({ kind: step.dir, steps: [step], endsAt: step.to, subtype: step.subtype });
      continue;
    }
    if (!current) {
      current = { kind: 'v', up: 0, down: 0, steps: [], endsAt: step.to };
    } else if (step.dir === 'up' && current.down > 0) {
      // down -> up transition: close this V and start a new one.
      segments.push(current);
      current = { kind: 'v', up: 0, down: 0, steps: [], endsAt: step.to };
    }
    if (step.dir === 'up') current.up += 1;
    else current.down += 1;
    current.steps.push(step);
    current.endsAt = step.to;
  }
  if (current) segments.push(current);
  return segments;
}

// -------------------------------------------- two-term idiom simplification ---

/** Matches a composed pair of terms against the familiar English idioms. */
function simplifyPair(first, second, endGender) {
  const a = first.label;
  const b = second.kind;

  const isParent = /(^|-)(father|mother|parent)$/.test(a) && !a.includes('grand');
  const isGrandparent = a.includes('grandfather') || a.includes('grandmother') || a.includes('grandparent');
  const isChild = /^(son|daughter|child)$/.test(a);
  const isSibling = /(brother|sister|sibling)$/.test(a);
  const isUncleAunt = /(uncle|aunt)/.test(a);

  // X's spouse
  if (b === 'spouse') {
    if (isParent) return `step-${byGender(endGender, 'father', 'mother', 'parent')}`;
    if (isSibling) return byGender(endGender, 'brother-in-law', 'sister-in-law', 'sibling-in-law');
    if (isChild) return byGender(endGender, 'son-in-law', 'daughter-in-law', 'child-in-law');
    if (isUncleAunt) return `${byGender(endGender, 'uncle', 'aunt', 'uncle or aunt')} by marriage`;
    if (isGrandparent) return `${byGender(endGender, 'grandfather', 'grandmother', 'grandparent')} by marriage`;
  }
  return null;
}

/** Matches spouse-first idioms: "my wife's mother" -> mother-in-law. */
function simplifySpouseFirst(secondLabel, endGender) {
  const isParent = /(^|-)(father|mother|parent)$/.test(secondLabel) && !secondLabel.includes('grand');
  const isChild = /^(son|daughter|child)$/.test(secondLabel);
  const isSibling = /(brother|sister|sibling)$/.test(secondLabel);
  const isGrandparent = secondLabel.includes('grand');
  const isUncleAunt = /(uncle|aunt)/.test(secondLabel);

  if (isParent) return byGender(endGender, 'father-in-law', 'mother-in-law', 'parent-in-law');
  if (isSibling) return byGender(endGender, 'brother-in-law', 'sister-in-law', 'sibling-in-law');
  if (isChild) return `step-${byGender(endGender, 'son', 'daughter', 'child')}`;
  if (isGrandparent) return `${byGender(endGender, 'grandfather', 'grandmother', 'grandparent')}-in-law`;
  if (isUncleAunt) return `${byGender(endGender, 'uncle', 'aunt', 'uncle or aunt')} by marriage`;
  return null;
}

// --------------------------------------------------------- main describer ---

/**
 * Produces the full description of one path.
 *
 * @param {object} graph
 * @param {Array}  steps      path steps from `findPaths`
 * @param {Function} genderOf (personId) => 'male'|'female'|'other'|'unknown'
 * @param {Function} nameOf   (personId) => display name
 */
export function describePath(graph, steps, genderOf, nameOf) {
  if (!steps.length) {
    return {
      label: 'the same person',
      category: 'self',
      isBiological: true,
      degreeOfSeparation: 0,
      chain: [],
      narrative: 'This is the same person.',
      viaMarriage: false,
      statuses: [],
    };
  }

  const segments = segmentPath(steps);

  // Name each segment from the perspective of its starting person.
  const terms = segments.map((seg) => {
    const endGender = genderOf(seg.endsAt);
    if (seg.kind === 'spouse') {
      return { kind: 'spouse', label: stepTerm(seg.steps[0], endGender), gender: endGender };
    }
    if (seg.kind === 'sibling') {
      return { kind: 'sibling', label: stepTerm(seg.steps[0], endGender), gender: endGender };
    }
    // A single-edge segment is named by `stepTerm`, which carries the subtype:
    // an adoptive mother must not be flattened to "mother". Longer segments
    // keep the plain genealogical term and surface the nuance through
    // `category` and the per-link `chain`, where it reads more naturally.
    if (seg.steps.length === 1) {
      return { kind: 'v', label: stepTerm(seg.steps[0], endGender), gender: endGender };
    }

    // For a 1-up/1-down V, work out whether the two share one parent or two.
    let sharedParents;
    if (seg.up === 1 && seg.down === 1) {
      const startId = seg.steps[0].from;
      const fam = immediateFamily(graph, startId);
      const found = fam.siblings.find((s) => s.to === seg.endsAt);
      sharedParents = found?.sharedParents ?? (found ? 2 : 1);
    }
    const v = vShapeTerm(seg.up, seg.down, { gender: endGender, sharedParents });
    return { kind: 'v', label: v.label, gender: endGender, meta: v };
  });

  // Compose a single label.
  let label;
  const endGender = genderOf(steps[steps.length - 1].to);

  if (terms.length === 1) {
    label = terms[0].label;
  } else if (terms.length === 2) {
    label =
      (terms[0].kind === 'spouse'
        ? simplifySpouseFirst(terms[1].label, endGender)
        : simplifyPair(terms[0], terms[1], endGender)) ??
      `${terms[0].label}'s ${terms[1].label}`;
  } else {
    // Longer chains read most clearly as a possessive sequence.
    label = terms.map((t) => t.label).join("'s ");
  }

  // Classification.
  const hasSpouse = steps.some((s) => s.dir === 'spouse');
  const hasAdoptive = steps.some((s) => s.subtype === 'adoptive');
  const hasStep = steps.some((s) => s.subtype === 'step' || s.subtype === 'foster' || s.subtype === 'guardian');
  const isBiological = !hasSpouse && !hasAdoptive && !hasStep &&
    steps.every((s) => s.dir === 'sibling' ? s.subtype !== 'step' : s.subtype === 'biological' || s.dir === 'sibling');

  let category = 'biological';
  if (hasSpouse && (hasAdoptive || hasStep)) category = 'mixed';
  else if (hasSpouse) category = 'marital';
  else if (hasAdoptive) category = 'adoptive';
  else if (hasStep) category = 'step';

  // Step-by-step chain for the UI.
  const chain = steps.map((step) => {
    const g = genderOf(step.to);
    return {
      fromId: step.from,
      toId: step.to,
      toName: nameOf(step.to),
      direction: step.dir,
      subtype: step.subtype,
      status: step.status,
      term: stepTerm(step, g),
      gender: g,
    };
  });

  // Readable narrative: "your father -> his mother -> her brother".
  const narrative = chain
    .map((link, i) => {
      const prefix = i === 0 ? 'your' : possessive(chain[i - 1].gender);
      return `${prefix} ${link.term} (${link.toName})`;
    })
    .join(' → ');

  const statuses = [...new Set(steps.map((s) => s.status))];

  return {
    label,
    category,
    isBiological,
    viaMarriage: hasSpouse,
    degreeOfSeparation: steps.length,
    chain,
    narrative,
    statuses,
    /** True only when every edge on the path has been human-verified. */
    fullyVerified: statuses.length > 0 && statuses.every((s) => s === 'verified'),
  };
}

/**
 * Names the relationship implied by a common ancestor, independent of any
 * particular path. Used by the "common ancestor" panel.
 */
export function relationshipFromCommonAncestor(generationsFromA, generationsFromB, gender = 'unknown') {
  return vShapeTerm(generationsFromA, generationsFromB, { gender });
}

/** How a person at the far end of a path refers back to the near end. */
export function reciprocalLabel(graph, steps, genderOf, nameOf) {
  const reversed = steps
    .slice()
    .reverse()
    .map((s) => ({
      from: s.to,
      to: s.from,
      dir: s.dir === 'up' ? 'down' : s.dir === 'down' ? 'up' : s.dir,
      subtype: s.subtype,
      status: s.status,
      relId: s.relId,
    }));
  return describePath(graph, reversed, genderOf, nameOf).label;
}

export { ordinal, timesRemoved, greatPrefix };
