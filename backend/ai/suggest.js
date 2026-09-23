/**
 * AI-assisted suggestion layer.
 *
 * Produces four kinds of suggestion, all of them advisory:
 *   1. Possible duplicate person records
 *   2. Possible cross-tree connections (two trees that may join)
 *   3. Missing relationships inside one tree (gaps the data implies)
 *   4. Data-quality observations (impossible dates, missing anchors)
 *
 * Every item returned carries `requiresHumanVerification: true` and an
 * `evidence` array. Nothing in this module writes a relationship; the routes
 * persist suggestions to `match_suggestions` with status 'possible' only.
 */
import { all, get, run, newPublicId, transaction } from '../db/index.js';
import config from '../config.js';
import { loadGraph, immediateFamily } from '../engine/graph.js';
import { findMatchesFor, alreadyRelated, relativeNames } from '../engine/matching.js';
import { reviewCandidates, aiStatus } from './provider.js';
import { allowsMatchDiscovery, allowsAiSuggestions } from '../lib/privacy.js';
import { yearOf } from '../lib/text.js';

/**
 * Scans one user's tree for duplicate and connection candidates.
 *
 * @param {object} viewer  the acting user
 * @param {object} opts    { crossTree, persist, limit }
 * @returns {Promise<{suggestions:Array, aiUsed:boolean, scanned:number, mode:string}>}
 */
export async function scanForMatches(viewer, opts = {}) {
  const { crossTree = true, persist = true, limit = config.ai.maxCandidates } = opts;
  const graph = loadGraph({ statuses: ['verified', 'unverified'] });

  const persons = all(
    `SELECT * FROM persons WHERE created_by_user_id = ? AND merged_into_id IS NULL`,
    viewer.id
  );

  // Only trees whose owners have opted into discovery may be searched.
  const discoverableOwners = all(
    `SELECT u.id FROM users u
     LEFT JOIN privacy_settings ps ON ps.user_id = u.id
     WHERE u.status = 'active'
       AND COALESCE(ps.allow_match_discovery, 1) = 1`
  ).map((r) => r.id);

  const ownerScope = crossTree ? discoverableOwners : [viewer.id];
  const raw = [];

  for (const person of persons) {
    const matches = findMatchesFor(person, { ownerIds: ownerScope, max: 8 });
    for (const m of matches) {
      // Two records already linked by a close relationship are not duplicates:
      // you are not a duplicate of your own brother.
      if (alreadyRelated(graph, person.id, m.person.id, 3)) continue;
      // Respect the other owner's discovery consent for cross-tree candidates.
      if (m.person.created_by_user_id !== viewer.id && !allowsMatchDiscovery(m.person.created_by_user_id)) continue;

      const [a, b] = person.id < m.person.id ? [person, m.person] : [m.person, person];
      raw.push({
        key: `${a.id}:${b.id}:${m.kind}`,
        kind: m.kind,
        crossTree: m.crossTree,
        a, b,
        score: m.score,
        band: m.band,
        evidence: m.evidence,
        conflicts: m.conflicts,
        rationale: m.rationale,
        corroborating: m.corroborating,
      });
    }
  }

  // Collapse duplicates of the same pair, keeping the highest score.
  const byKey = new Map();
  for (const item of raw) {
    const existing = byKey.get(item.key);
    if (!existing || item.score > existing.score) byKey.set(item.key, item);
  }
  let suggestions = [...byKey.values()].sort((x, y) => y.score - x.score).slice(0, limit);

  // Optional model-assisted review of the shortlist.
  let aiUsed = false;
  let aiModel = null;
  if (suggestions.length && allowsAiSuggestions(viewer.id)) {
    const review = await reviewCandidates({
      task: 'duplicate-and-connection-review',
      pairs: suggestions.map((s) => ({
        id: s.key,
        recordA: summarizeForAi(s.a),
        recordB: summarizeForAi(s.b),
        ruleScore: s.score,
        agreeingEvidence: s.evidence.filter((e) => e.value >= 0.7).map((e) => e.factor),
        conflicts: s.conflicts,
      })),
    });

    if (review) {
      aiUsed = true;
      aiModel = review.model;
      const byId = new Map(review.reviews.map((r) => [r.id, r]));
      suggestions = suggestions.map((s) => {
        const r = byId.get(s.key);
        if (!r) return s;
        return {
          ...s,
          aiVerdict: r.verdict,
          aiConfidence: typeof r.confidence === 'number' ? r.confidence : null,
          rationale: r.rationale ?? s.rationale,
          questions: Array.isArray(r.suggestedQuestions) ? r.suggestedQuestions.slice(0, 4) : [],
          source: 'ai',
        };
      });
      // The model may reorder, but it can never promote a suppressed pair:
      // the rule engine's conflict decisions stand.
      suggestions.sort((x, y) => (y.aiConfidence ?? y.score) - (x.aiConfidence ?? x.score));
    }
  }

  if (persist) persistSuggestions(suggestions, { aiUsed, aiModel });

  return {
    suggestions: suggestions.map(serializeSuggestion),
    aiUsed,
    scanned: persons.length,
    mode: aiStatus().mode,
    requiresHumanVerification: true,
  };
}

/** Only fields already visible to the acting user are sent to the model. */
function summarizeForAi(person) {
  const rel = relativeNames(person.id);
  return {
    name: person.display_name,
    gender: person.gender,
    birth: person.birth_date ?? (person.birth_year ? String(person.birth_year) : null),
    birthPrecision: person.birth_precision,
    birthPlace: person.birth_place,
    death: person.death_date,
    parents: rel.parents,
    spouses: rel.spouses,
    children: rel.children,
  };
}

function serializeSuggestion(s) {
  return {
    kind: s.kind,
    crossTree: s.crossTree ?? false,
    score: s.score,
    band: s.band,
    personA: { id: s.a.public_id, name: s.a.display_name, birth: s.a.birth_date, gender: s.a.gender },
    personB: { id: s.b.public_id, name: s.b.display_name, birth: s.b.birth_date, gender: s.b.gender },
    evidence: s.evidence,
    conflicts: s.conflicts,
    rationale: s.rationale,
    aiVerdict: s.aiVerdict ?? null,
    aiConfidence: s.aiConfidence ?? null,
    questions: s.questions ?? [],
    source: s.source ?? 'rule',
    status: 'possible',
    requiresHumanVerification: true,
  };
}

/** Writes suggestions as 'possible'. Never higher -- only a human can go further. */
function persistSuggestions(suggestions, { aiUsed, aiModel }) {
  transaction(() => {
    for (const s of suggestions) {
      const existing = get(
        `SELECT id, status FROM match_suggestions
         WHERE person_a_id = ? AND person_b_id = ? AND kind = ?`,
        s.a.id, s.b.id, s.kind
      );

      // A decision a human already made is never overwritten by a rescan.
      if (existing && ['accepted', 'rejected', 'dismissed'].includes(existing.status)) continue;

      const evidenceJson = JSON.stringify({ factors: s.evidence, conflicts: s.conflicts });

      if (existing) {
        run(
          `UPDATE match_suggestions
           SET score = ?, band = ?, evidence = ?, rationale = ?, source = ?, ai_model = ?
           WHERE id = ?`,
          s.score, s.band, evidenceJson, s.rationale,
          aiUsed ? 'ai' : 'rule', aiUsed ? aiModel : null, existing.id
        );
      } else {
        run(
          `INSERT INTO match_suggestions
             (public_id, kind, person_a_id, person_b_id, score, band, evidence, rationale, source, ai_model, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'possible')`,
          newPublicId(), s.kind, s.a.id, s.b.id, s.score, s.band,
          evidenceJson, s.rationale, aiUsed ? 'ai' : 'rule', aiUsed ? aiModel : null
        );
      }
    }
  });
}

// ------------------------------------------------- structural suggestions ---

/**
 * Gaps the existing data implies but nobody has recorded. These are structural
 * observations, not guesses about identity, so they are reported separately
 * from possible matches.
 */
export function suggestMissingLinks(viewer, { limit = 30 } = {}) {
  const graph = loadGraph({ statuses: ['verified', 'unverified'] });
  const persons = all(
    `SELECT * FROM persons WHERE created_by_user_id = ? AND merged_into_id IS NULL`,
    viewer.id
  );
  const byId = new Map(persons.map((p) => [p.id, p]));
  const out = [];

  for (const person of persons) {
    const fam = immediateFamily(graph, person.id);

    // A child with exactly one recorded parent.
    if (fam.children.length > 0 && fam.parents.length === 1) {
      out.push({
        type: 'missing-parent',
        severity: 'info',
        personId: person.public_id,
        personName: person.display_name,
        message: `${person.display_name} has one parent recorded. Adding the second parent improves relationship discovery on that side of the family.`,
        evidence: [`${fam.parents.length} parent recorded`, `${fam.children.length} child/children recorded`],
        action: 'add-parent',
      });
    }

    // Two people share children but have no marriage/partnership edge.
    for (const childEdge of fam.children) {
      const childParents = all(
        `SELECT from_person_id FROM relationships
         WHERE to_person_id = ? AND type = 'parent' AND status IN ('verified','unverified')`,
        childEdge.to
      ).map((r) => r.from_person_id);

      for (const coParent of childParents) {
        if (coParent === person.id || coParent < person.id) continue;
        const hasSpouseEdge = (graph.adj.get(person.id) ?? []).some(
          (e) => e.dir === 'spouse' && e.to === coParent
        );
        if (hasSpouseEdge) continue;
        const other = byId.get(coParent) ?? get(`SELECT * FROM persons WHERE id = ?`, coParent);
        if (!other) continue;
        out.push({
          type: 'missing-partnership',
          severity: 'info',
          personId: person.public_id,
          personName: person.display_name,
          relatedId: other.public_id,
          relatedName: other.display_name,
          message: `${person.display_name} and ${other.display_name} share a child but no partnership is recorded between them.`,
          evidence: [`Shared child: ${get(`SELECT display_name FROM persons WHERE id = ?`, childEdge.to)?.display_name ?? 'unknown'}`],
          action: 'add-spouse',
        });
      }
    }

    // Dates that cannot be right.
    const birthYear = person.birth_year ?? yearOf(person.birth_date);
    for (const parentEdge of fam.parents) {
      const parent = byId.get(parentEdge.to) ?? get(`SELECT * FROM persons WHERE id = ?`, parentEdge.to);
      if (!parent) continue;
      const parentYear = parent.birth_year ?? yearOf(parent.birth_date);
      if (birthYear === null || parentYear === null) continue;
      const gap = birthYear - parentYear;
      if (gap < 12) {
        out.push({
          type: 'date-conflict',
          severity: 'warning',
          personId: person.public_id,
          personName: person.display_name,
          relatedId: parent.public_id,
          relatedName: parent.display_name,
          message: `${parent.display_name} is recorded as a parent of ${person.display_name} but is only ${gap} year(s) older. One of the dates is probably wrong.`,
          evidence: [`Parent born ${parentYear}`, `Child born ${birthYear}`],
          action: 'review-dates',
        });
      } else if (gap > 70) {
        out.push({
          type: 'date-conflict',
          severity: 'warning',
          personId: person.public_id,
          personName: person.display_name,
          relatedId: parent.public_id,
          relatedName: parent.display_name,
          message: `${parent.display_name} would have been ${gap} at the birth of ${person.display_name}. Worth checking.`,
          evidence: [`Parent born ${parentYear}`, `Child born ${birthYear}`],
          action: 'review-dates',
        });
      }
    }
  }

  // De-duplicate and cap.
  const seen = new Set();
  const unique = [];
  for (const item of out) {
    const key = `${item.type}:${item.personId}:${item.relatedId ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...item, requiresHumanVerification: true });
    if (unique.length >= limit) break;
  }
  return unique;
}

/**
 * Suggests which other registered trees are most worth comparing against,
 * ranked by shared surnames and overlapping birth-year windows. Used to point
 * the user at likely connections without exposing any private record.
 */
export function suggestTreesToExplore(viewer, { limit = 8 } = {}) {
  const mine = all(
    `SELECT DISTINCT family_name FROM persons
     WHERE created_by_user_id = ? AND family_name IS NOT NULL AND family_name <> ''`,
    viewer.id
  ).map((r) => r.family_name);

  if (!mine.length) return [];

  const placeholders = mine.map(() => '?').join(',');
  const rows = all(
    `SELECT u.id, u.public_id, u.display_name,
            COUNT(DISTINCT p.family_name) AS shared_surnames,
            COUNT(p.id) AS matching_people
     FROM persons p
     JOIN users u ON u.id = p.created_by_user_id
     LEFT JOIN privacy_settings ps ON ps.user_id = u.id
     WHERE p.family_name IN (${placeholders})
       AND p.created_by_user_id <> ?
       AND p.merged_into_id IS NULL
       AND u.status = 'active'
       AND COALESCE(ps.allow_match_discovery, 1) = 1
       AND COALESCE(ps.show_in_directory, 1) = 1
     GROUP BY u.id
     ORDER BY shared_surnames DESC, matching_people DESC
     LIMIT ?`,
    ...mine, viewer.id, limit
  );

  return rows.map((r) => ({
    userId: r.public_id,
    displayName: r.display_name,
    sharedSurnames: r.shared_surnames,
    matchingPeople: r.matching_people,
    message: `${r.display_name}'s tree contains ${r.matching_people} person(s) with ${r.shared_surnames} surname(s) you also record.`,
    requiresHumanVerification: true,
  }));
}

/**
 * Explains a discovered relationship path in plain language, flagging any
 * unverified edge it depends on. Advisory text only.
 */
export function explainPath(description, commonAncestorNames = []) {
  const parts = [];

  if (description.isBiological) {
    parts.push(`This is a blood relationship: every step follows a parent-child link.`);
  } else if (description.viaMarriage) {
    parts.push(
      `This connection passes through a marriage, so it is a relationship by marriage rather than by blood.`
    );
  }
  if (description.category === 'adoptive') {
    parts.push('The path includes an adoptive link, which is a legal family relationship.');
  }
  if (description.category === 'step') {
    parts.push('The path includes a step-relationship.');
  }
  if (commonAncestorNames.length) {
    parts.push(`The branches meet at ${commonAncestorNames.join(' and ')}.`);
  }
  if (!description.fullyVerified) {
    const unverified = description.chain.filter((c) => c.status !== 'verified').length;
    parts.push(
      `${unverified} step(s) on this path have not been verified yet, so the connection is provisional until they are confirmed.`
    );
  } else {
    parts.push('Every step on this path has been human-verified.');
  }
  return parts.join(' ');
}

export { aiStatus };
