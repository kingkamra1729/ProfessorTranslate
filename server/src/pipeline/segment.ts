/**
 * Semantic chunking for live speech.
 *
 * Speech recognition hands back a "final" result whenever the speaker pauses,
 * which has nothing to do with where meaning ends. A lecturer who talks for
 * forty seconds without breathing produces one enormous final result; one who
 * hesitates mid-clause produces three fragments.
 *
 * Both hurt. A long chunk means the student waits for the whole thing to be
 * translated before hearing any of it, and the translation model does worse on
 * a run-on. A fragment means the model translates half a thought.
 *
 * So the stream is re-cut on linguistic boundaries rather than on breathing:
 *
 *   1. Terminal punctuation  . ! ? । ॥   - always a boundary.
 *   2. Clause punctuation    , ; : — –   - a boundary once the chunk has enough
 *                                          substance to stand on its own.
 *   3. Conjunctions          because, but, and, so …
 *                                        - a boundary before the conjunction,
 *                                          under the length rules below.
 *   4. A pause in the audio               - flushed by the caller via `flush()`,
 *                                          driven by voice activity detection.
 *   5. Length                            - a backstop, so a speaker who uses no
 *                                          punctuation at all still gets cut.
 *
 * The point of cutting early is latency: the sooner a phrase is a complete
 * thought, the sooner it can be streamed to the model and the sooner the first
 * translated word reaches the student.
 */

/** Beyond this many characters we stop waiting for any boundary at all. */
const CLAUSE_FLUSH_THRESHOLD = 140;

/** Below this, a trailing fragment is held back for the next chunk. */
const MIN_CHUNK = 12;

/**
 * The shortest chunk worth cutting at a comma or a strong conjunction.
 *
 * Cutting is not free. Hindi and Bengali are verb-final, so the model needs the
 * whole clause to order the sentence correctly, and a three-word fragment
 * translates into something a student has to reassemble themselves. This is the
 * point below which an early cut costs more comprehension than it saves
 * latency.
 */
const MIN_SEMANTIC_CHARS = 28;

/**
 * The length at which a *weak* conjunction becomes a boundary.
 *
 * "and", "or" and "so" join noun phrases at least as often as they join
 * clauses - "eigenvalues and eigenvectors" is one idea, not two - so treating
 * them as boundaries everywhere would shred exactly the phrases this product
 * exists to keep intact. They only earn a cut once the chunk is long enough
 * that it is certainly a run-on rather than a compound noun.
 */
const WEAK_CONJUNCTION_MIN_CHARS = 60;

/**
 * A sentence ends at terminal punctuation followed by whitespace *or by the end
 * of the input*.
 *
 * The end-of-input alternative is load-bearing. Recognition hands us a final
 * result the moment the speaker pauses, and that result almost always ends
 * exactly at a full stop with nothing after it. Requiring trailing whitespace
 * would leave every such sentence sitting in the buffer until the professor's
 * next breath - so the class would hear each sentence one sentence late, which
 * is the single most damaging thing this pipeline could do.
 *
 * Includes the Devanagari danda (।) and double danda (॥), since the language of
 * instruction is not always English.
 */
const SENTENCE_END = /[.!?।॥]+["'”’)]*(?:\s+|$)/g;

/** Comma, semicolon, colon and dashes: a clause has closed. */
const CLAUSE_PUNCTUATION = /[,;:—–]\s+/g;

/**
 * Conjunctions that almost always join two clauses rather than two nouns.
 *
 * A cut lands *before* the word, so the conjunction opens the next chunk and
 * the reader keeps the connective that tells them how the two halves relate.
 */
const STRONG_CONJUNCTIONS = [
  'because',
  'but',
  'however',
  'therefore',
  'whereas',
  'although',
  'unless',
  'which means',
  'that means',
  'in other words',
  'so that',
  'and then',
  'so then',
  'which is why',
];

/** Conjunctions that join nouns as readily as clauses. See the constant above. */
const WEAK_CONJUNCTIONS = ['and', 'or', 'so', 'if', 'when', 'then', 'while'];

function conjunctionPattern(words: string[]): RegExp {
  // Required leading whitespace is what keeps "band" from matching "and".
  return new RegExp(`\\s+(?:${words.join('|')})\\s+`, 'gi');
}

const STRONG_CONJUNCTION_RE = conjunctionPattern(STRONG_CONJUNCTIONS);
const WEAK_CONJUNCTION_RE = conjunctionPattern(WEAK_CONJUNCTIONS);

/** Where a chunk may be cut, and how much text must precede the cut. */
interface Boundary {
  /** Index in `text` at which the next chunk begins. */
  at: number;
  minChars: number;
}

/**
 * Every candidate boundary in `text`, in position order.
 *
 * Collected in one pass per boundary class rather than by walking character by
 * character, because the regex engine is dramatically faster than a hand-rolled
 * scanner and this runs on every recognition result of every lecture.
 */
function boundaries(text: string): Boundary[] {
  const out: Boundary[] = [];

  const collect = (re: RegExp, minChars: number, cutBefore: boolean) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      // Cutting *before* a conjunction keeps the connective with the clause it
      // introduces; cutting *after* punctuation keeps the mark with the clause
      // it closes.
      out.push({ at: cutBefore ? m.index : m.index + m[0].length, minChars });
      // A zero-width match would spin here; regexes above all consume at least
      // one character, but the guard costs nothing and outlives this file.
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  };

  collect(SENTENCE_END, MIN_CHUNK, false);
  collect(CLAUSE_PUNCTUATION, MIN_SEMANTIC_CHARS, false);
  collect(STRONG_CONJUNCTION_RE, MIN_SEMANTIC_CHARS, true);
  collect(WEAK_CONJUNCTION_RE, WEAK_CONJUNCTION_MIN_CHARS, true);

  return out.sort((a, b) => a.at - b.at);
}

/**
 * Splits text into units suitable for translation.
 *
 * Returns the complete units plus whatever tail was too short to be worth
 * sending on its own. The caller carries the tail forward.
 */
export function segment(text: string): { chunks: string[]; remainder: string } {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return { chunks: [], remainder: '' };

  const chunks: string[] = [];
  const candidates = boundaries(clean);

  // `cursor` is where the current chunk starts. A boundary is taken only when
  // the text since `cursor` is long enough to satisfy that boundary's own
  // threshold, which is what stops a comma after two words from cutting.
  let cursor = 0;

  for (const boundary of candidates) {
    if (boundary.at <= cursor) continue;
    const candidate = clean.slice(cursor, boundary.at).trim();
    if (candidate.length < boundary.minChars) continue;

    chunks.push(candidate);
    cursor = boundary.at;
  }

  let rest = clean.slice(cursor).trim();

  // Backstop: no boundary of any kind, and the speaker is still going. Cut at
  // the last word break so a forced split at least lands between words.
  while (rest.length > CLAUSE_FLUSH_THRESHOLD) {
    const cutAt = lastWordBreakBefore(rest, CLAUSE_FLUSH_THRESHOLD);
    if (cutAt <= 0) break;
    const chunk = rest.slice(0, cutAt).trim();
    if (!chunk) break;
    chunks.push(chunk);
    rest = rest.slice(cutAt).trimStart();
  }

  return { chunks, remainder: rest };
}

/** The last space at or before `limit`, so a forced cut never splits a word. */
function lastWordBreakBefore(text: string, limit: number): number {
  const space = text.slice(0, limit).lastIndexOf(' ');
  return space > MIN_CHUNK ? space : -1;
}

/**
 * Accumulates recognition results and emits translation-ready chunks.
 *
 * One instance per professor connection. Interim results are held loosely -
 * they are revised constantly and translating them would waste calls and
 * produce jitter - while final results are appended and re-segmented.
 */
export class UtteranceBuffer {
  private pending = '';

  /**
   * Adds a final recognition result. Returns chunks ready to translate.
   */
  push(finalText: string): string[] {
    const combined = `${this.pending} ${finalText}`.trim();
    const { chunks, remainder } = segment(combined);
    this.pending = remainder;

    // A remainder that has stopped growing is dealt with by `flush()`, which
    // the room calls when voice activity detection reports the speaker has
    // actually stopped.
    return chunks;
  }

  /**
   * Emits whatever is held back, regardless of length.
   *
   * Called when the audio goes quiet and when the lecture ends. A trailing
   * clause left in the buffer is worse than a short one sent: it does not
   * merely arrive late, it is prepended to the next sentence and garbles that
   * one too.
   */
  flush(): string[] {
    const tail = this.pending.trim();
    this.pending = '';
    return tail ? [tail] : [];
  }

  /** True when nothing is waiting. */
  get isEmpty(): boolean {
    return this.pending.trim().length === 0;
  }

  peek(): string {
    return this.pending;
  }
}
