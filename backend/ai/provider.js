/**
 * AI provider abstraction.
 *
 * Two modes, selected by `AI_ENABLED`:
 *
 *   false (default)  Local deterministic heuristics. No network calls, no API
 *                    key, works offline. Every suggestion still carries an
 *                    evidence list and still requires human verification.
 *
 *   true             The same heuristics run first, then the Claude API is
 *                    asked to review the shortlist and write the rationale.
 *
 * HARD CONSTRAINTS (enforced by the callers in `suggest.js` and the routes):
 *   - The model is given ONLY the evidence already computed by the rule engine.
 *   - The model's reply can change ranking and wording. It cannot create,
 *     verify or delete a relationship, and it cannot raise a suggestion's
 *     status past 'possible'.
 *   - A failed or slow API call degrades to the heuristic result. The feature
 *     never blocks the application.
 */
import config from '../config.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

export function aiStatus() {
  const configured = Boolean(config.ai.apiKey);
  return {
    enabled: config.ai.enabled && configured,
    configured,
    mode: config.ai.enabled && configured ? 'model-assisted' : 'local-heuristics',
    model: config.ai.enabled && configured ? config.ai.model : null,
    provider: config.ai.provider,
    note:
      config.ai.enabled && configured
        ? 'Claude reviews the shortlist produced by the rule engine and writes the explanation. It cannot create or verify relationships.'
        : 'Running on local deterministic heuristics. Set AI_ENABLED=true and provide ANTHROPIC_API_KEY to add model-assisted review.',
  };
}

/**
 * The system prompt states the safety rules the product depends on. It is kept
 * here rather than inline so it is reviewable in one place.
 */
const SYSTEM_PROMPT = `You assist a genealogy application that connects family trees.

You are given candidate pairs of person records together with evidence that a
deterministic rule engine has already computed. Your job is to review them.

Rules you must follow:
1. You SUGGEST only. You never confirm identity or relationships. A human
   reviewer makes every final decision.
2. Base your judgement only on the evidence supplied. Do not invent facts,
   dates, places or relatives that are not in the input.
3. Treat conflicting evidence as decisive. Different exact dates of birth, or
   different recorded genders, mean the records are very likely different
   people, however similar the names are.
4. A shared name on its own is weak evidence. Many unrelated people share a
   name. Say so plainly when that is all there is.
5. Be brief and concrete. One or two sentences per pair, naming the specific
   evidence you relied on.

Reply with JSON only, matching this shape:
{"reviews":[{"id":"<candidate id>","confidence":<0..1>,"verdict":"likely-same|uncertain|likely-different","rationale":"<one or two sentences>","suggestedQuestions":["<what a human should check>"]}]}`;

/**
 * Calls the Claude Messages API. Returns null on any failure so the caller can
 * fall back to heuristics.
 */
export async function reviewCandidates(payload) {
  if (!config.ai.enabled || !config.ai.apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ai.timeoutMs);

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.ai.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: config.ai.model,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Review these candidate pairs.\n\n${JSON.stringify(payload, null, 2)}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.warn(`[ai] provider returned ${response.status}; falling back to heuristics`);
      return null;
    }

    const data = await response.json();
    const text = (data.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const parsed = safeParseJson(text);
    if (!parsed?.reviews) return null;

    return {
      model: data.model ?? config.ai.model,
      reviews: parsed.reviews,
      usage: data.usage ?? null,
    };
  } catch (err) {
    if (err.name === 'AbortError') console.warn('[ai] provider timed out; falling back to heuristics');
    else console.warn(`[ai] provider error: ${err.message}; falling back to heuristics`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Models sometimes wrap JSON in prose or a code fence; recover it. */
function safeParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try { return JSON.parse(fenced[1]); } catch { /* fall through */ }
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* give up */ }
    }
    return null;
  }
}

export { SYSTEM_PROMPT };
