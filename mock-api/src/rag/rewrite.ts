import type { Language } from '../constants';
import { logger } from '../lib/logger';
import { detectPii } from './guard';
import { namesStandard } from './regex';
import type { LlmProvider } from './providers';

/**
 * Query rewriting (§5 step 2: "Rewrite to a standalone query using rolling summary
 * + last 4 turns (small model)").
 *
 * Retrieval sees the *rewritten* text; the user's own words are still what gets
 * persisted, what gets sent to the answer model, and what the PII guard already
 * examined. A rewrite is a search optimisation, never a reinterpretation of the
 * question, and it can only ever be dropped (falling back to the original) — never
 * escalated.
 *
 * It is skipped when it cannot help or must not be trusted:
 * no conversation history → nothing to resolve;
 * a mock provider → it would echo the input and pretend otherwise (R8);
 * a self-contained question → §9 says spend tokens where they change the answer.
 */

/** Static so provider-side prefix caching applies (§9). */
const REWRITE_SYSTEM_PROMPT = `You rewrite a follow-up question into one standalone search query for an Indian Standards knowledge base.
Rules: output exactly one line. Keep standard numbers, clause ids and material names verbatim. Resolve "it", "this", "that" from the conversation. Add no facts, no assumptions, no answer. If the question is already standalone, repeat it unchanged.`;

/** Words that only make sense with prior context, i.e. when a rewrite can help. */
const ANAPHORA = [
  /\b(it|its|this|that|these|those|they|them|there|the former|the latter|the same|both|either)\b/i,
  /\b(above|earlier|previous|last|second|first)\b.{0,20}\b(one|option|standard|clause|part)\b/i,
  /**
   * A turn that opens by continuing the last one. This shape matters more than it
   * looks: the clarification and follow-up chips this product shows ("What about the
   * tolerances?", "And the marking?") are clicked as the next message, so a rewrite
   * that only fires on pronouns would miss the follow-ups it exists for.
   */
  /^\s*(?:and|but|so|then|also|plus|well|ok|okay)\b/i,
  /^\s*(?:what|how|why|which|when|where|who)\s+(?:about|of|for)\b/i,
  /^\s*(?:tell me more|more|go on|continue|and\?|why\?)\s*[?.!]*\s*$/i,
  /(?:इसे|उसे|इसका|उसका|इसमें|उसमें|यह|वह|इन|उन|पिछला|पिछली|ऊपर|और|इसी|बताओ|क्या कहता है)/u,
];

/** Short enough that a rewrite is plausible, long enough that it is not a fragment. */
const MAX_REWRITTEN_LENGTH = 300;

export interface RewriteOutcome {
  /** What retrieval should use. Always non-empty. */
  query: string;
  method: 'passthrough' | 'model' | 'rejected';
  reason: string;
  promptTokens: number;
  completionTokens: number;
}

export function needsRewrite(question: string): boolean {
  const trimmed = question.trim();
  if (trimmed.length < 3) return false;
  // A question that already names a standard number is self-identifying: the
  // retrieval step can use it directly, and a rewrite could only add risk.
  if (namesStandard(trimmed)) return false;
  return ANAPHORA.some((re) => re.test(trimmed));
}

export async function rewriteToStandaloneQuery(opts: {
  provider: LlmProvider;
  question: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  language: Language;
  signal?: AbortSignal;
}): Promise<RewriteOutcome> {
  const noop = (method: RewriteOutcome['method'], reason: string): RewriteOutcome => ({
    query: opts.question,
    method,
    reason,
    promptTokens: 0,
    completionTokens: 0,
  });

  if (opts.history.length === 0) return noop('passthrough', 'No earlier turns to resolve.');
  if (opts.provider.isMock) return noop('passthrough', 'The configured provider is the offline mock, which cannot rewrite.');
  if (!needsRewrite(opts.question)) return noop('passthrough', 'The question is already self-contained.');

  const transcript = opts.history
    .slice(-4)
    .map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content.slice(0, 400)}`)
    .join('\n');

  let result;
  try {
    result = await opts.provider.generate({
      systemPrompt: REWRITE_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Conversation:\n${transcript}\n\nFollow-up question:\n${opts.question}` },
      ],
      maxOutputTokens: 80,
      temperature: 0,
      language: opts.language,
      intent: 'rewrite',
      model: 'small',
      signal: opts.signal,
    });
  } catch (err) {
    // A rewrite failure must never become the user's problem: retrieval simply uses
    // their own words, and the reason goes to the log for the eval harness.
    logger.warn('query rewrite failed; using the original question', { err });
    return noop('rejected', 'The rewrite call failed, so the original question was used.');
  }

  const candidate = result.text.replace(/\s+/g, ' ').replace(/^["'`]+|["'`]+$/g, '').trim();

  if (candidate.length === 0 || candidate.length > MAX_REWRITTEN_LENGTH) {
    return noop('rejected', 'The rewrite was empty or too long, so the original question was used.');
  }
  if (/\[S\d\]/i.test(candidate) || /<\/?(sources|user_input)>/i.test(candidate)) {
    return noop('rejected', 'The rewrite contained citation or delimiter markup and was discarded.');
  }
  if (detectPii(candidate).length > 0) {
    // The user's stored text was already redacted; a rewrite that manufactures
    // something PII-shaped is hallucinating and must not reach the index.
    return noop('rejected', 'The rewrite introduced personal-data-shaped text and was discarded.');
  }

  return {
    query: candidate,
    method: 'model',
    reason: 'Rewritten with the small model for retrieval only.',
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
  };
}
