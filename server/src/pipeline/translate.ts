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
  voiceEmbeddedLatin,
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
 * Every character here is re-read by the model on every sentence of every
 * lecture, and time-to-first-token scales with prompt length - an earlier
 * 1560-character version of this cost 1209ms before the first word appeared
 * against 586ms for a 353-character one. So nothing is included that does not
 * change the output.
 *
 * What earns its place is register guidance and worked examples. Rules about
 * formatting turned out to be free to delete; instructions about *how the
 * language is spoken* did not, because getting that wrong produces a
 * translation the student has to decode rather than understand.
 */
function systemPrompt(from: LangCode, to: LangCode): string {
  const source = LANGUAGES[from];
  const target = LANGUAGES[to];

  return [
    `Interpret ${source.name} lecture speech into spoken ${target.name}. Output only the ${target.name}.`,
    `⟦0⟧ ⟦1⟧ are technical terms: copy each one exactly, same digits, positioned where ${target.name} grammar wants it.`,
    'Translate only what was said - add no definitions or explanations of your own.',
    '',
    registerGuidance(to),
    '',
    'Examples:',
    ...examplesFor(to),
  ].join('\n');
}

/**
 * How the target language is actually spoken in a classroom.
 *
 * This is the difference between a translation a student understands and one
 * they have to decode. Formal Hindi renders "zero" as शून्य and "damping" as
 * अवमंदन - words that are correct, literary, and harder for the student than
 * the English they replaced. A translation that sends someone to a dictionary
 * has failed at the one job it had.
 *
 * Educated Indian speech code-mixes heavily and always has. A physics lecturer
 * says "अब देखते हैं कि determinant zero हो तो क्या होता है" - not a Sanskritised
 * rendering of it. Matching that register is not sloppiness; it is what
 * comprehension actually requires.
 */
function registerGuidance(to: LangCode): string {
  switch (to) {
    case 'hi':
      return [
        'REGISTER: everyday spoken Hindi as heard in an Indian classroom, not literary or Sanskritised Hindi.',
        'Code-mix naturally. Keep in English the words people genuinely say in English: zero, energy, force, speed, direction, independent, system, value, graph, point, line, angle, positive, negative, increase, decrease, simple, example, use, matrix, curve, area, volume, mass, time.',
        'Avoid शुद्ध हिन्दी coinages. Say zero not शून्य, energy not ऊर्जा, direction not दिशा, independent not स्वतंत्र, system not प्रणाली, frequency not आवृत्ति.',
        'Write English words in Latin script - graph, shift, zero - never transliterated into Devanagari as ग्राफ or शिफ्ट.',
        'Avoid the bookish आइए; prefer देखते हैं, करते हैं, समझते हैं - the way a teacher actually talks.',
      ].join('\n');
    case 'bn':
      return [
        'REGISTER: everyday spoken Bengali as heard in an Indian classroom, not literary or Sanskritised Bengali.',
        'Code-mix naturally. Keep in English the words people genuinely say in English: zero, energy, force, speed, direction, system, value, graph, point, line, angle, positive, negative, simple, example, matrix, curve, mass, time.',
        'Avoid heavy তৎসম vocabulary. Say zero not শূন্য, energy not শক্তি, direction not দিক, frequency not কম্পাঙ্ক.',
        'Write English words in Latin script - graph, shift, zero - never transliterated into Bengali script.',
      ].join('\n');
    case 'fr':
      return [
        'REGISTER: natural spoken French as a lecturer talks to a class, not written academic prose.',
        'Use everyday phrasing - on regarde, on voit, ça veut dire - rather than formal constructions.',
        'French does not code-mix with English the way Hindi does, so translate ordinary words normally; only the ⟦n⟧ terms stay English.',
      ].join('\n');
    default:
      return 'REGISTER: plain spoken English as a lecturer talks to a class.';
  }
}

/**
 * Worked examples, which pin down register far more effectively than rules.
 *
 * Chosen to demonstrate the three things that go wrong: placeholder
 * repositioning, everyday words staying English, and the difference between
 * how a teacher speaks and how a textbook is written.
 */
function examplesFor(to: LangCode): string[] {
  switch (to) {
    case 'hi':
      return [
        'So the ⟦0⟧ of this ⟦1⟧ stretches the ⟦2⟧. → तो इस ⟦1⟧ का ⟦0⟧ ⟦2⟧ को stretch करता है।',
        'Now let us see what happens when the ⟦0⟧ is zero. → अब देखते हैं कि ⟦0⟧ zero हो तो क्या होता है।',
        '⟦0⟧ takes energy out of the system, so the ⟦1⟧ keeps dropping. → ⟦0⟧ system से energy निकाल देता है, तो ⟦1⟧ कम होता जाता है।',
      ];
    case 'bn':
      return [
        'So the ⟦0⟧ of this ⟦1⟧ stretches the ⟦2⟧. → তাহলে এই ⟦1⟧-এর ⟦0⟧ ⟦2⟧-কে stretch করে।',
        'Now let us see what happens when the ⟦0⟧ is zero. → এবার দেখি ⟦0⟧ zero হলে কী হয়।',
        '⟦0⟧ takes energy out of the system, so the ⟦1⟧ keeps dropping. → ⟦0⟧ system থেকে energy বার করে দেয়, তাই ⟦1⟧ কমতে থাকে।',
      ];
    case 'fr':
      return [
        'So the ⟦0⟧ of this ⟦1⟧ stretches the ⟦2⟧. → Donc le ⟦0⟧ de cette ⟦1⟧ étire le ⟦2⟧.',
        'Now let us see what happens when the ⟦0⟧ is zero. → Maintenant regardons ce qui se passe quand le ⟦0⟧ vaut zéro.',
      ];
    default:
      return ['So the ⟦0⟧ of this ⟦1⟧ stretches the ⟦2⟧. → So the ⟦0⟧ of this ⟦1⟧ stretches the ⟦2⟧.'];
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
 * Partial delivery
 * ------------------------------------------------------------------ */

/**
 * Smallest gap between subtitle updates, in milliseconds.
 *
 * A streamed translation arrives as roughly forty fragments, and forwarding
 * each one repaints the student's subtitle forty times in a second and a half.
 * That is not "live", it is a flicker, and on a phone held at arm's length it
 * is genuinely hard to read. Around seven updates a second still feels like
 * text appearing as it is spoken, without the strobing.
 */
const PARTIAL_INTERVAL_MS = 150;

/**
 * Wraps the caller's partial handler so it is called at a readable rate.
 *
 * Rate-limited rather than batched: what matters is that the student sees text
 * arriving continuously, not that they see every token the model produced.
 */
function throttlePartials(
  onPartial: (text: string) => void,
  hits: Parameters<typeof unmaskPartial>[1],
): (fragment: string, soFar: string) => void {
  let lastSentAt = 0;
  let lastText = '';

  return (_fragment, soFar) => {
    const now = Date.now();
    if (now - lastSentAt < PARTIAL_INTERVAL_MS) return;

    const text = unmaskPartial(soFar, hits);
    // A fragment that only completed a sentinel produces no visible change.
    if (text === lastText) return;

    lastSentAt = now;
    lastText = text;
    onPartial(text);
  };
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
        ? await chatStream(messages, options, throttlePartials(input.onPartial, hits))
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
    // English words the model kept for natural code-mixing get an English
    // voice, so they are pronounced rather than transliterated by whichever
    // synthesiser the student happens to have.
    runs: voiceEmbeddedLatin(restored.runs, to, from),
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
