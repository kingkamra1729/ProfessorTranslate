/**
 * Sentence segmentation for live speech.
 *
 * Speech recognition hands back a "final" result whenever the speaker pauses,
 * which has nothing to do with where sentences end. A lecturer who talks for
 * forty seconds without breathing produces one enormous final result; one who
 * hesitates mid-clause produces three fragments.
 *
 * Both hurt. A long chunk means the student waits for the whole thing to be
 * translated before hearing any of it, and the translation model does worse on
 * a run-on. A fragment means the model translates half a thought.
 *
 * So we re-cut the stream on sentence boundaries, and flush long clauses early
 * when no sentence boundary is coming.
 */

/** Beyond this many characters we stop waiting for a full stop. */
const CLAUSE_FLUSH_THRESHOLD = 140;

/** Below this, a trailing fragment is held back for the next chunk. */
const MIN_CHUNK = 12;

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
const SENTENCE_END = /([.!?।॥]+["'”’)]*(?:\s+|$))/;
const CLAUSE_BREAK = /([,;:—–]\s+|\s+(?:and then|so then|which means|because|therefore|however|but then)\s+)/i;

/**
 * Splits text into units suitable for translation.
 *
 * Returns the complete units plus whatever tail was too short to be worth
 * sending on its own. The caller carries the tail forward.
 */
export function segment(text: string): { chunks: string[]; remainder: string } {
  const chunks: string[] = [];
  let rest = text.replace(/\s+/g, ' ').trimStart();

  // First pass: split on real sentence boundaries.
  for (;;) {
    const m = SENTENCE_END.exec(rest);
    if (!m || m.index === undefined) break;
    const cut = m.index + m[0].length;
    const chunk = rest.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut);
  }

  // Second pass: the remainder has no full stop in it. If it has grown long
  // enough that waiting would be audible, cut it at the last clause break.
  while (rest.length > CLAUSE_FLUSH_THRESHOLD) {
    const cutAt = lastClauseBreakBefore(rest, CLAUSE_FLUSH_THRESHOLD);
    if (cutAt <= 0) break;
    const chunk = rest.slice(0, cutAt).trim();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cutAt).trimStart();
  }

  return { chunks, remainder: rest.trim() };
}

/**
 * Finds the latest clause break at or before `limit`, so a forced cut lands
 * somewhere a listener would accept rather than mid-noun-phrase.
 */
function lastClauseBreakBefore(text: string, limit: number): number {
  const window = text.slice(0, limit);
  let best = -1;
  const re = new RegExp(CLAUSE_BREAK.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) {
    best = m.index + m[0].length;
  }
  // No clause break at all - fall back to the last word boundary so we at
  // least avoid splitting a word in half.
  if (best < 0) {
    const space = window.lastIndexOf(' ');
    best = space > MIN_CHUNK ? space : -1;
  }
  return best;
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

    // A remainder that has stopped growing is dealt with by `flush()`, called
    // when recognition goes quiet.
    return chunks;
  }

  /**
   * Emits whatever is held back, regardless of length.
   *
   * Called when the professor stops speaking or ends the lecture, so a trailing
   * clause is not silently dropped.
   */
  flush(): string[] {
    const tail = this.pending.trim();
    this.pending = '';
    return tail.length >= MIN_CHUNK ? [tail] : tail ? [tail] : [];
  }

  /** True when nothing is waiting. */
  get isEmpty(): boolean {
    return this.pending.trim().length === 0;
  }

  peek(): string {
    return this.pending;
  }
}
