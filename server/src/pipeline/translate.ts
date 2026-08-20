import { LANGUAGES, type LangCode, type Translation } from '@suvidha/shared';
import { chatWithRetry, isConfigured, type ChatMessage } from '../providers/featherless.js';
import {
  appendDroppedTerms,
  maskTerms,
  runsFromPlainText,
  unmaskTerms,
  type TermMatcher,
} from './glossary.js';

/**
 * Live interpretation.
 *
 * The contract with the professor is narrow and worth stating precisely,
 * because it is what separates this from pointing Google Translate at a
 * lecture:
 *
 *   - The *explanation* is translated. The sentence a lecturer improvises to
 *     make an idea land is exactly the sentence a second-language student
 *     misses, and it is the sentence with the least to lose in translation.
 *   - The *terms* are not translated. They are removed before the model runs
 *     and put back afterwards, so the model has no opportunity to render them.
 *   - Nothing is *added*. No definitions, no clarifications, no helpful
 *     asides. If the professor did not say it, the student does not hear it.
 *     A translator that explains is a translator that is now teaching, and it
 *     is not qualified to.
 */

/* ------------------------------------------------------------------ *
 * Prompt
 * ------------------------------------------------------------------ */

function systemPrompt(from: LangCode, to: LangCode): string {
  const source = LANGUAGES[from];
  const target = LANGUAGES[to];

  return [
    `You are a live interpreter in a university lecture hall. You render the professor's ${source.name} speech into ${target.name} (${target.nativeName}) in real time, for students who are following the lecture through an earpiece.`,
    '',
    'RULES',
    '',
    `1. Output ONLY the ${target.name} translation. No preamble, no quotation marks, no notes, no romanisation, no alternatives in brackets.`,
    '',
    `2. The input contains placeholders that look like ⟦0⟧, ⟦1⟧, ⟦2⟧. Each stands for a technical term that MUST NOT be translated. Copy every placeholder into your output exactly as written, with the same digit. Never translate one, never delete one, never renumber one, never add one that was not in the input. Place each placeholder wherever ${target.name} grammar requires it - the word order of your sentence should be natural ${target.name}, not a copy of the ${source.name} order.`,
    '',
    `3. Translate the explanation only. Do NOT add definitions, examples, clarifications or context that the professor did not say. If the professor's sentence is incomplete or trails off, translate the incomplete sentence. You are interpreting, not teaching.`,
    '',
    `4. Use spoken lecture register: the natural, clear ${target.name} a teacher would actually say aloud to a class. Not formal written prose, not literary vocabulary.`,
    '',
    `5. Keep the translation close to the length of the original. This is spoken live and a long rendering will run past the professor's next sentence.`,
    '',
    `6. Numbers, symbols, variable names and units stay as they are.`,
    '',
    'EXAMPLE',
    `Input:  So the ⟦0⟧ of this ⟦1⟧ tells us how much the ⟦2⟧ gets stretched.`,
    `Output: ${exampleFor(to)}`,
  ].join('\n');
}

/**
 * A worked example in the actual target language, which does more to pin down
 * register and placeholder handling than another paragraph of instructions.
 */
function exampleFor(to: LangCode): string {
  switch (to) {
    case 'hi':
      return 'तो इस ⟦1⟧ का ⟦0⟧ हमें बताता है कि ⟦2⟧ कितना खिंचता है।';
    case 'bn':
      return 'তাহলে এই ⟦1⟧-এর ⟦0⟧ আমাদের বলে দেয় ⟦2⟧ কতটা প্রসারিত হয়।';
    case 'fr':
      return 'Donc la ⟦0⟧ de cette ⟦1⟧ nous dit de combien le ⟦2⟧ est étiré.';
    default:
      return 'So the ⟦0⟧ of this ⟦1⟧ tells us how much the ⟦2⟧ gets stretched.';
  }
}

/* ------------------------------------------------------------------ *
 * Output hygiene
 * ------------------------------------------------------------------ */

/**
 * Small models like to be helpful. They wrap output in quotes, prefix it with
 * "Translation:", or append a parenthetical note about a word choice. None of
 * that should reach a student's ear, and all of it is cheap to strip.
 */
function cleanModelOutput(raw: string): string {
  let out = raw.trim();

  // Strip a leading label in any of our languages.
  out = out.replace(/^(translation|traduction|अनुवाद|অনুবাদ)\s*[:：-]\s*/i, '');

  // Strip symmetric wrapping quotes.
  const pairs: Array<[string, string]> = [
    ['"', '"'], ["'", "'"], ['«', '»'], ['“', '”'], ['‘', '’'],
  ];
  for (const [open, close] of pairs) {
    if (out.startsWith(open) && out.endsWith(close) && out.length > 2) {
      out = out.slice(open.length, -close.length).trim();
      break;
    }
  }

  // Some models emit a chain-of-thought block before the answer.
  out = out.replace(/^<think>[\s\S]*?<\/think>\s*/i, '').trim();

  // Collapse the newlines a model sometimes uses to offer alternatives; keep
  // only the first line, which is the actual translation.
  const firstLine = out.split(/\n{2,}/)[0].trim();
  if (firstLine) out = firstLine;

  return out;
}

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

/**
 * Lectures repeat themselves - "does that make sense", "so what we have here
 * is", the restatement of a definition three times in five minutes. Caching on
 * the masked text means those repeats cost nothing and, more usefully, arrive
 * instantly.
 */
const CACHE_LIMIT = 500;
const cache = new Map<string, { text: string; ts: number }>();

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  // Refresh recency for a rough LRU.
  cache.delete(key);
  cache.set(key, hit);
  return hit.text;
}

function cacheSet(key: string, text: string): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { text, ts: Date.now() });
}

export function clearTranslationCache(): void {
  cache.clear();
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

export interface TranslateInput {
  utteranceId: string;
  text: string;
  from: LangCode;
  to: LangCode;
  matcher: TermMatcher;
}

/**
 * Translates one utterance, preserving glossary terms.
 *
 * Never throws. A lecture in progress cannot pause for an API error, so every
 * failure path degrades to passthrough: the student sees and hears the original
 * ${source} sentence, tagged `engine: 'fallback'` so the UI can say so plainly
 * rather than passing off untranslated text as a translation.
 */
export async function translateUtterance(input: TranslateInput): Promise<Translation> {
  const started = Date.now();
  const { utteranceId, text, from, to, matcher } = input;

  // Listening in the language of instruction: nothing to translate, but the
  // terms are still marked so the subtitle view can highlight them.
  if (from === to) {
    return {
      utteranceId,
      lang: to,
      text,
      runs: runsFromPlainText(text, matcher, to, from),
      latencyMs: Date.now() - started,
      engine: 'fallback',
    };
  }

  const { masked, hits } = maskTerms(text, matcher);

  const passthrough = (): Translation => ({
    utteranceId,
    lang: to,
    text,
    runs: runsFromPlainText(text, matcher, from, from),
    latencyMs: Date.now() - started,
    engine: 'fallback',
  });

  if (!isConfigured()) return passthrough();

  // A sentence that is nothing but a protected term needs no model call.
  if (masked.replace(/⟦\d+⟧/g, '').trim().length === 0) {
    const restored = unmaskTerms(masked, hits, to, from);
    return {
      utteranceId,
      lang: to,
      text: restored.text,
      runs: restored.runs,
      latencyMs: Date.now() - started,
      engine: 'fallback',
    };
  }

  const cacheKey = `${from}>${to}:${masked}`;
  const cached = cacheGet(cacheKey);

  let modelOutput: string;
  if (cached !== undefined) {
    modelOutput = cached;
  } else {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(from, to) },
      { role: 'user', content: masked },
    ];
    try {
      modelOutput = cleanModelOutput(
        await chatWithRetry(messages, {
          temperature: 0.2,
          // Generous relative to the input, since Devanagari and Bengali
          // tokenise far less efficiently than Latin script.
          maxTokens: Math.max(160, masked.length * 3),
        }),
      );
      if (!modelOutput) return passthrough();
      cacheSet(cacheKey, modelOutput);
    } catch (err) {
      console.warn(
        `[translate] ${from}->${to} failed, falling back to passthrough:`,
        err instanceof Error ? err.message : err,
      );
      return passthrough();
    }
  }

  let restored = unmaskTerms(modelOutput, hits, to, from);
  if (restored.missing.length > 0) {
    console.warn(
      `[translate] model dropped ${restored.missing.length} placeholder(s) for ${to}; repairing`,
    );
    restored = appendDroppedTerms(restored, hits, from);
  }

  return {
    utteranceId,
    lang: to,
    text: restored.text,
    runs: restored.runs,
    latencyMs: Date.now() - started,
    engine: 'llm',
  };
}

/**
 * Fans one utterance out to every language a room is listening in.
 *
 * The calls run concurrently: a student listening in French should not wait on
 * the Bengali rendering finishing first.
 */
export async function translateToMany(
  base: Omit<TranslateInput, 'to'>,
  targets: LangCode[],
): Promise<Translation[]> {
  return Promise.all(targets.map((to) => translateUtterance({ ...base, to })));
}
