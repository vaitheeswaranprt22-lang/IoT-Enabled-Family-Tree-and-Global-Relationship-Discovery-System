/**
 * Name normalisation and string-similarity primitives.
 *
 * These feed the matching engine. They are deliberately conservative: the goal
 * is to surface a *candidate* for a human to judge, never to decide identity.
 */

/** Strips diacritics, punctuation and case. "Müller-Schmidt" -> "muller schmidt". */
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // combining marks
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Honorifics and suffixes that carry no identity information. */
const NOISE_TOKENS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'madam', 'rev',
  'jr', 'sr', 'ii', 'iii', 'iv', 'v',
]);

export function nameTokens(value) {
  return normalizeName(value)
    .split(' ')
    .filter((t) => t.length > 0 && !NOISE_TOKENS.has(t));
}

/**
 * Soundex phonetic key -- catches "Catherine"/"Kathryn" style spelling drift.
 * Used only as a *retrieval* filter; scoring is done by Jaro-Winkler.
 */
export function soundex(word) {
  const s = normalizeName(word).replace(/[^a-z]/g, '');
  if (!s) return '';
  const codes = { b: 1, f: 1, p: 1, v: 1,
    c: 2, g: 2, j: 2, k: 2, q: 2, s: 2, x: 2, z: 2,
    d: 3, t: 3, l: 4, m: 5, n: 5, r: 6 };

  const first = s[0];
  let last = codes[first] ?? 0;
  let out = first.toUpperCase();

  for (let i = 1; i < s.length && out.length < 4; i += 1) {
    const ch = s[i];
    const code = codes[ch] ?? 0;
    if (code !== 0 && code !== last) out += String(code);
    // h and w are transparent: they do not reset the "previous code" state.
    if (ch !== 'h' && ch !== 'w') last = code;
  }
  return out.padEnd(4, '0');
}

/** Phonetic key for a whole name (each token's soundex, joined). */
export function phoneticKey(value) {
  return nameTokens(value).map(soundex).join(' ');
}

/** Levenshtein edit distance with a row-swapping (O(min(n,m)) space) loop. */
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Jaro similarity, 0..1. */
export function jaro(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array(a.length).fill(false);
  const bMatched = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i += 1) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j += 1) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k += 1;
    if (a[i] !== b[k]) transpositions += 1;
    k += 1;
  }
  transpositions /= 2;

  return (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;
}

/**
 * Jaro-Winkler, 0..1. Boosts strings sharing a prefix, which suits personal
 * names where the first letters are the most reliably transcribed part.
 */
export function jaroWinkler(a, b, prefixScale = 0.1) {
  const j = jaro(a, b);
  if (j < 0.7) return j; // standard threshold: do not boost weak matches
  let prefix = 0;
  const max = Math.min(4, a.length, b.length);
  while (prefix < max && a[prefix] === b[prefix]) prefix += 1;
  return j + prefix * prefixScale * (1 - j);
}

/**
 * Compares two full names token-by-token, best-pairing each token.
 * Returns 0..1. Handles reordered names ("Anand Kumar" vs "Kumar Anand").
 */
export function nameSimilarity(nameA, nameB) {
  const a = nameTokens(nameA);
  const b = nameTokens(nameB);
  if (!a.length || !b.length) return 0;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const used = new Set();
  let total = 0;

  for (const token of shorter) {
    let best = 0;
    let bestIdx = -1;
    for (let i = 0; i < longer.length; i += 1) {
      if (used.has(i)) continue;
      const score = jaroWinkler(token, longer[i]);
      if (score > best) { best = score; bestIdx = i; }
    }
    if (bestIdx >= 0) used.add(bestIdx);
    total += best;
  }

  const meanBest = total / shorter.length;
  // Penalise a big difference in token count: "Ravi" vs "Ravi Kumar Sharma"
  // should not score as highly as a full two-token agreement.
  const lengthPenalty = shorter.length / longer.length;
  return meanBest * (0.75 + 0.25 * lengthPenalty);
}

/** Cheap pre-filter: do two names share any token or phonetic key? */
export function sharesToken(nameA, nameB) {
  const a = new Set(nameTokens(nameA));
  for (const token of nameTokens(nameB)) if (a.has(token)) return true;
  const pa = new Set(nameTokens(nameA).map(soundex));
  for (const token of nameTokens(nameB)) if (pa.has(soundex(token))) return true;
  return false;
}

/** Loose place comparison -- "Chennai, TN" vs "chennai tamil nadu". */
export function placeSimilarity(a, b) {
  if (!a || !b) return null;
  const ta = new Set(nameTokens(a));
  const tb = new Set(nameTokens(b));
  if (!ta.size || !tb.size) return null;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared += 1;
  return shared / Math.min(ta.size, tb.size);
}

/** Builds the display name stored on a person record. */
export function buildDisplayName({ givenName, middleName, familyName }) {
  return [givenName, middleName, familyName]
    .map((p) => (p ?? '').trim())
    .filter(Boolean)
    .join(' ');
}

/** Extracts a 4-digit year from an ISO date, or null. */
export function yearOf(isoDate) {
  if (!isoDate) return null;
  const y = Number.parseInt(String(isoDate).slice(0, 4), 10);
  return Number.isInteger(y) ? y : null;
}
