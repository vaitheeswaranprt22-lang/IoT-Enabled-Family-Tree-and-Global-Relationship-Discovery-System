/**
 * Possible-match and duplicate detection.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE:
 *   Similarity NEVER creates a connection. Everything produced here is a
 *   *candidate* with an evidence list attached, written to `match_suggestions`
 *   with status 'possible'. Only an explicit human decision, recorded in
 *   `verification_requests`, can turn a candidate into a relationship or a
 *   merged person.
 *
 * Scoring works on weighted evidence with *present-weight normalisation*: a
 * factor only contributes when both records actually carry that information,
 * and the final score is scaled down when very little was comparable. That
 * stops "two people share a common name and nothing else" from scoring high.
 *
 * Conflicting evidence is treated as decisive. Two records with exact but
 * different dates of birth, or two known and different genders, are suppressed
 * outright rather than merely scored lower -- this is what keeps the deliberate
 * "similar name, different person" cases in the demo data from ever matching.
 */
import { all, get } from '../db/index.js';
import config from '../config.js';
import { nameSimilarity, normalizeName, soundex, placeSimilarity, yearOf } from '../lib/text.js';

const WEIGHTS = {
  fullName: 0.30,
  givenName: 0.09,
  familyName: 0.11,
  birthDate: 0.20,
  deathDate: 0.06,
  birthPlace: 0.07,
  gender: 0.04,
  parents: 0.18,
  spouses: 0.09,
  children: 0.06,
};

/** Below this much comparable evidence, the score is damped proportionally. */
const MIN_EVIDENCE_MASS = 0.55;

// ------------------------------------------------------------- relatives ---

/** Names of a person's parents / spouses / children, for corroboration. */
export function relativeNames(personId) {
  const parents = all(
    `SELECT p.display_name AS name, p.gender FROM relationships r
     JOIN persons p ON p.id = r.from_person_id
     WHERE r.to_person_id = ? AND r.type = 'parent' AND r.status IN ('verified','unverified')`,
    personId
  );
  const children = all(
    `SELECT p.display_name AS name, p.gender FROM relationships r
     JOIN persons p ON p.id = r.to_person_id
     WHERE r.from_person_id = ? AND r.type = 'parent' AND r.status IN ('verified','unverified')`,
    personId
  );
  const spouses = all(
    `SELECT p.display_name AS name, p.gender FROM relationships r
     JOIN persons p ON p.id = CASE WHEN r.from_person_id = ? THEN r.to_person_id ELSE r.from_person_id END
     WHERE r.type = 'spouse' AND (r.from_person_id = ? OR r.to_person_id = ?)
       AND r.status IN ('verified','unverified')`,
    personId, personId, personId
  );
  return {
    parents: parents.map((r) => r.name),
    children: children.map((r) => r.name),
    spouses: spouses.map((r) => r.name),
  };
}

/** Best pairwise name agreement between two name lists, 0..1. */
function listSimilarity(listA, listB) {
  if (!listA?.length || !listB?.length) return null;
  let best = 0;
  for (const a of listA) {
    for (const b of listB) {
      const s = nameSimilarity(a, b);
      if (s > best) best = s;
    }
  }
  return best;
}

/**
 * How common is this name in the database? A very common name is weak evidence,
 * so its weight is reduced. Without this, every "Kumar" in a large tree would
 * generate noise.
 */
function nameCommonnessFactor(nameNormalized) {
  const row = get(
    `SELECT COUNT(*) AS n FROM persons WHERE name_normalized = ? AND merged_into_id IS NULL`,
    nameNormalized
  );
  const count = row?.n ?? 1;
  if (count <= 2) return 1;
  if (count <= 4) return 0.85;
  if (count <= 8) return 0.65;
  return 0.45;
}

// --------------------------------------------------------------- scoring ---

/**
 * Compares two person rows.
 * @returns {{score:number, band:string, evidence:Array, conflicts:Array, suppressed:boolean, rationale:string}}
 */
export function scorePair(a, b, options = {}) {
  const evidence = [];
  const conflicts = [];
  const tolerance = options.dobToleranceYears ?? config.matching.dobToleranceYears;

  let weightedSum = 0;
  let presentWeight = 0;
  const addFactor = (key, value, detail) => {
    if (value === null || value === undefined) return;
    const weight = WEIGHTS[key] * (detail?.weightScale ?? 1);
    weightedSum += weight * value;
    presentWeight += weight;
    evidence.push({
      factor: key,
      value: Number(value.toFixed(3)),
      weight: Number(weight.toFixed(3)),
      ...detail,
    });
  };

  // ---- names -------------------------------------------------------------
  const commonness = Math.min(
    nameCommonnessFactor(a.name_normalized),
    nameCommonnessFactor(b.name_normalized)
  );
  const fullName = nameSimilarity(a.display_name, b.display_name);
  addFactor('fullName', fullName, {
    weightScale: commonness,
    a: a.display_name,
    b: b.display_name,
    note: commonness < 1 ? 'Weight reduced: this name is common in the database.' : undefined,
  });

  if (a.given_name && b.given_name) {
    addFactor('givenName', nameSimilarity(a.given_name, b.given_name), {
      a: a.given_name, b: b.given_name,
      phonetic: soundex(a.given_name) === soundex(b.given_name),
    });
  }
  if (a.family_name && b.family_name) {
    addFactor('familyName', nameSimilarity(a.family_name, b.family_name), {
      a: a.family_name, b: b.family_name,
    });
  }

  // ---- dates -------------------------------------------------------------
  const yearA = a.birth_year ?? yearOf(a.birth_date);
  const yearB = b.birth_year ?? yearOf(b.birth_date);
  const preciseA = a.birth_date && a.birth_precision === 'exact';
  const preciseB = b.birth_date && b.birth_precision === 'exact';

  if (yearA !== null && yearB !== null) {
    const gap = Math.abs(yearA - yearB);
    if (preciseA && preciseB && a.birth_date !== b.birth_date && gap > tolerance) {
      conflicts.push({
        factor: 'birthDate',
        severity: 'decisive',
        a: a.birth_date, b: b.birth_date,
        note: `Both records give an exact date of birth and they differ by ${gap} year(s).`,
      });
    } else if (preciseA && preciseB && a.birth_date === b.birth_date) {
      addFactor('birthDate', 1, { a: a.birth_date, b: b.birth_date, note: 'Exact dates of birth agree.' });
    } else if (gap === 0) {
      addFactor('birthDate', 0.85, { a: yearA, b: yearB, note: 'Birth years agree.' });
    } else if (gap <= tolerance) {
      addFactor('birthDate', Math.max(0, 0.7 - gap * 0.2), {
        a: yearA, b: yearB, note: `Birth years differ by ${gap}, within the ${tolerance}-year tolerance.`,
      });
    } else {
      conflicts.push({
        factor: 'birthDate', severity: gap > tolerance * 3 ? 'decisive' : 'strong',
        a: yearA, b: yearB, note: `Birth years differ by ${gap} year(s).`,
      });
    }
  }

  if (a.death_date && b.death_date) {
    if (a.death_date === b.death_date) {
      addFactor('deathDate', 1, { a: a.death_date, b: b.death_date, note: 'Dates of death agree.' });
    } else {
      const gap = Math.abs((yearOf(a.death_date) ?? 0) - (yearOf(b.death_date) ?? 0));
      if (gap > tolerance) {
        conflicts.push({ factor: 'deathDate', severity: 'strong', a: a.death_date, b: b.death_date,
          note: `Dates of death differ by ${gap} year(s).` });
      } else {
        addFactor('deathDate', 0.6, { a: a.death_date, b: b.death_date });
      }
    }
  }
  // One record says the person died, the other says they are living.
  if ((a.death_date && b.is_living === 1) || (b.death_date && a.is_living === 1)) {
    conflicts.push({ factor: 'living', severity: 'strong',
      note: 'One record has a date of death while the other is marked as living.' });
  }

  // ---- gender ------------------------------------------------------------
  if (a.gender !== 'unknown' && b.gender !== 'unknown') {
    if (a.gender === b.gender) {
      addFactor('gender', 1, { a: a.gender, b: b.gender });
    } else {
      conflicts.push({ factor: 'gender', severity: 'decisive', a: a.gender, b: b.gender,
        note: 'The records record different genders.' });
    }
  }

  // ---- places ------------------------------------------------------------
  const place = placeSimilarity(a.birth_place, b.birth_place);
  if (place !== null) {
    if (place >= 0.5) addFactor('birthPlace', place, { a: a.birth_place, b: b.birth_place });
    else conflicts.push({ factor: 'birthPlace', severity: 'weak', a: a.birth_place, b: b.birth_place,
      note: 'Birthplaces do not appear to match.' });
  }

  // ---- family corroboration ---------------------------------------------
  const relA = options.relativesA ?? relativeNames(a.id);
  const relB = options.relativesB ?? relativeNames(b.id);

  const parentSim = listSimilarity(relA.parents, relB.parents);
  if (parentSim !== null) {
    if (parentSim >= 0.72) {
      addFactor('parents', parentSim, { a: relA.parents, b: relB.parents, note: 'A parent name matches.' });
    } else {
      addFactor('parents', parentSim * 0.4, { a: relA.parents, b: relB.parents });
      if (parentSim < 0.35 && relA.parents.length && relB.parents.length) {
        conflicts.push({ factor: 'parents', severity: 'strong', a: relA.parents, b: relB.parents,
          note: 'Both records name parents, and none of them match.' });
      }
    }
  }

  const spouseSim = listSimilarity(relA.spouses, relB.spouses);
  if (spouseSim !== null) addFactor('spouses', spouseSim, { a: relA.spouses, b: relB.spouses });

  const childSim = listSimilarity(relA.children, relB.children);
  if (childSim !== null) addFactor('children', childSim, { a: relA.children, b: relB.children });

  // ---- combine -----------------------------------------------------------
  let score = presentWeight > 0 ? weightedSum / presentWeight : 0;

  // Damp the score when very little was actually comparable.
  if (presentWeight < MIN_EVIDENCE_MASS) {
    score *= presentWeight / MIN_EVIDENCE_MASS;
    evidence.push({
      factor: 'evidenceMass', value: Number((presentWeight / MIN_EVIDENCE_MASS).toFixed(3)), weight: 0,
      note: 'Score reduced: the two records have little comparable information.',
    });
  }

  // Conflicts are applied last and can be decisive.
  let suppressed = false;
  for (const c of conflicts) {
    if (c.severity === 'decisive') { score *= 0.12; suppressed = true; }
    else if (c.severity === 'strong') score *= 0.55;
    else score *= 0.9;
  }

  // A "strong" band demands corroboration beyond the name: at least two
  // independent non-name factors must agree well. Name alone is never enough.
  const corroborating = evidence.filter(
    (e) => !['fullName', 'givenName', 'familyName', 'evidenceMass'].includes(e.factor) && e.value >= 0.7
  ).length;

  let band = 'weak';
  if (score >= config.matching.strongScore && corroborating >= 2) band = 'strong';
  else if (score >= config.matching.minScore) band = 'possible';

  return {
    score: Math.max(0, Math.min(1, Number(score.toFixed(4)))),
    band,
    evidence,
    conflicts,
    suppressed,
    corroborating,
    rationale: buildRationale({ score, band, evidence, conflicts, corroborating, a, b }),
  };
}

/** Plain-English summary shown next to every Possible Match. */
function buildRationale({ band, evidence, conflicts, corroborating, a, b }) {
  const agreeing = evidence
    .filter((e) => e.value >= 0.7 && e.factor !== 'evidenceMass')
    .map((e) => LABELS[e.factor] ?? e.factor);

  const parts = [];
  if (agreeing.length) parts.push(`${agreeing.join(', ')} agree`);
  else parts.push('only weak similarity was found');

  if (conflicts.length) {
    parts.push(`but ${conflicts.map((c) => (c.note ?? LABELS[c.factor] ?? c.factor)).join(' ')}`);
  }

  const verdict =
    band === 'strong'
      ? `"${a.display_name}" and "${b.display_name}" look like the same person, but this still needs human confirmation before anything is merged.`
      : band === 'possible'
        ? `"${a.display_name}" and "${b.display_name}" may be the same person. Review the evidence before deciding.`
        : `"${a.display_name}" and "${b.display_name}" are probably different people.`;

  const corroborationNote =
    band !== 'weak' && corroborating < 2
      ? ' Note: the similarity rests mainly on the name, which on its own is not enough to identify a person.'
      : '';

  return `${parts.join(' ')}. ${verdict}${corroborationNote}`;
}

const LABELS = {
  fullName: 'full name', givenName: 'first name', familyName: 'family name',
  birthDate: 'date of birth', deathDate: 'date of death', birthPlace: 'birthplace',
  gender: 'gender', parents: 'parent names', spouses: 'spouse names', children: 'children names',
  living: 'living status',
};

// -------------------------------------------------------- candidate search ---

/**
 * Cheap retrieval step: pulls persons that *could* match, using indexed
 * columns only. Scoring is expensive, so this keeps the comparison set small
 * even in a large database.
 */
export function candidatesFor(person, { ownerIds = null, limit = 250, excludeSameOwner = false } = {}) {
  const params = [];
  const clauses = [
    'p.id <> ?',
    'p.merged_into_id IS NULL',
  ];
  params.push(person.id);

  if (excludeSameOwner) {
    clauses.push('p.created_by_user_id <> ?');
    params.push(person.created_by_user_id);
  }
  if (ownerIds && ownerIds.length) {
    clauses.push(`p.created_by_user_id IN (${ownerIds.map(() => '?').join(',')})`);
    params.push(...ownerIds);
  }

  // Retrieval is a union of cheap, indexed signals. Scoring is expensive, so
  // this stage is deliberately generous about what it lets through and strict
  // about staying on an index.
  //
  // The given-name + birth-year and exact-birth-date clauses matter more than
  // they look: a record abbreviated as "Meenakshi R" shares neither a
  // normalised name nor a family name with "Meenakshi Raghavan", so without
  // them the most common kind of duplicate would never even be compared.
  const phonetic = person.name_phonetic ?? '';
  const year = person.birth_year;

  const sql = `
    SELECT p.* FROM persons p
    WHERE ${clauses.join(' AND ')}
      AND (
        p.name_normalized = ?
        OR (p.name_phonetic <> '' AND p.name_phonetic = ?)
        OR (p.family_name IS NOT NULL AND p.family_name = ?
            AND (? IS NULL OR p.birth_year IS NULL OR ABS(p.birth_year - ?) <= 30))
        OR (p.given_name = ? AND ? IS NOT NULL AND p.birth_year IS NOT NULL
            AND ABS(p.birth_year - ?) <= 3)
        OR (? IS NOT NULL AND p.birth_date = ?)
      )
    LIMIT ?`;

  return all(
    sql,
    ...params,
    person.name_normalized,
    phonetic,
    person.family_name ?? '\u0000',
    year, year,
    person.given_name ?? '\u0000', year, year,
    person.birth_date, person.birth_date,
    limit
  );
}

/**
 * Scores every candidate for one person.
 *
 * The kind is always 'duplicate', because `scorePair` answers exactly one
 * question: are these two records the same human being? Which tree a record
 * happens to sit in says nothing about that. A cross-tree duplicate is the
 * normal way two family trees turn out to be connected -- one person recorded
 * twice, by two relatives who had never met -- so `crossTree` is reported
 * alongside rather than changing what the candidate *is*.
 *
 * The 'connection' and 'relationship' kinds are reserved for suggesting an
 * edge between two people who are agreed to be different.
 */
export function findMatchesFor(person, options = {}) {
  const candidates = candidatesFor(person, options);
  const relativesA = relativeNames(person.id);
  const results = [];

  for (const candidate of candidates) {
    const scored = scorePair(person, candidate, { ...options, relativesA });
    if (scored.score < config.matching.minScore) continue;
    results.push({
      person: candidate,
      ...scored,
      kind: 'duplicate',
      crossTree: candidate.created_by_user_id !== person.created_by_user_id,
    });
  }

  results.sort((x, y) => y.score - x.score);
  return results.slice(0, options.max ?? 25);
}

/**
 * Two records cannot be the same person if the graph already says they are
 * related -- you are not a duplicate of your own brother. Checked before a
 * 'duplicate' suggestion is written.
 */
export function alreadyRelated(graph, idA, idB, maxDepth = 3) {
  const seen = new Set([idA]);
  let frontier = [idA];
  for (let d = 0; d < maxDepth; d += 1) {
    const next = [];
    for (const node of frontier) {
      for (const edge of graph.adj.get(node) ?? []) {
        if (edge.to === idB) return true;
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        next.push(edge.to);
      }
    }
    frontier = next;
  }
  return false;
}

export { WEIGHTS, MIN_EVIDENCE_MASS, LABELS };
