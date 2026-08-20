import { LANGUAGES, type LangCode, type Translation } from '@suvidha/shared';
import {
  chatStream,
  chatWithRetry,
  isConfigured,
  type ChatMessage,
} from '../providers/featherless.js';
import {
  appendDroppedTerms,
  maskTerms,
  runsFromPlainText,
  unmaskPartial,
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

/**
 * The interpreter's instructions.
 *
 * Kept deliberately terse. This prompt is re-read by the model on every
 * sentence of every lecture, and time-to-first-token scales with how much
 * there is to read before generation can start - measured at 1209ms for a
 * 1560-character prompt against 586ms for a 353-character one, with identical
 * term-preservation results. Half the student's waiting time was spent on
 * prose that changed nothing.
 *
 * The worked example survives the cut because it carries more instruction per
 * token than any of the rules did: it demonstrates output-only formatting,
 * placeholder copying, and placeholder *reordering* in one line.
 */
function systemPrompt(from: LangCode, to: LangCode): string {
  const source = LANGUAGES[from];
  const target = LANGUAGES[to];

  return [
    `Interpret ${source.name} lecture speech into spoken ${target.name}. Output only the ${target.name}.`,
    `⟦0⟧ ⟦1⟧ are technical terms: copy each one exactly, same digits, positioned where ${target.name} grammar wants it.`,
    'Translate only what was said - add no definitions or explanations of your own.',
    'Keep it short and natural, as spoken aloud to a class. Numbers and symbols unchanged.',
    `Example: So the ⟦0⟧ of this ⟦1⟧ stretches the ⟦2⟧. → ${exampleFor(to)}`,
  ].join('\n');
}

/**
 * A worked example in the actual target language, which does more to pin down
 * register and placeholder handling than another paragraph of instructions.
 */
function exampleFor(to: LangCode): string {
  switch (to) {
    case 'hi':
      return 'तो इस ⟦1⟧ का ⟦0⟧ ⟦2⟧ को खींचता है।';
    case 'bn':
      return 'তাহলে এই ⟦1⟧-এর ⟦0⟧ ⟦2⟧-কে প্রসারিত করে।';
    case 'fr':
      return 'Donc la ⟦0⟧ de cette ⟦1⟧ étire le ⟦2⟧.';
    default:
      return 'So the ⟦0⟧ of this ⟦1⟧ stretches the ⟦2⟧.';
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
  /**
   * Called with subtitle text as the translation is generated.
   *
   * Providing this switches to a streaming request. The student starts reading
   * at the first token rather than the last, which on measurement is the
   * difference between roughly 0.6 and 1.8 seconds of staring at nothing.
   * Audio is unaffected - it still waits for the finished sentence.
   */
  onPartial?: (text: string) => void;
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
    // A cache hit is instant, so the partial and the final are the same thing.
    input.onPartial?.(unmaskPartial(modelOutput, hits));
  } else {
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt(from, to) },
      { role: 'user', content: masked },
    ];
    const options = {
      temperature: 0.2,
      // Generous relative to the input, since Devanagari and Bengali
      // tokenise far less efficiently than Latin script.
      maxTokens: Math.max(160, masked.length * 3),
    };
    try {
      const raw = input.onPartial
        ? await chatStream(messages, options, (_fragment, soFar) => {
            input.onPartial?.(unmaskPartial(soFar, hits));
          })
        : await chatWithRetry(messages, options);
      modelOutput = cleanModelOutput(raw);
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
