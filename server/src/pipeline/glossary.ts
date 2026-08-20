import type { GlossaryTerm, LangCode, SpeechRun } from '@suvidha/shared';

/**
 * Term protection.
 *
 * The pedagogical rule this file enforces: a student should finish the lecture
 * able to read the textbook. That means the vocabulary they will meet in the
 * textbook, the exam and the job interview has to reach their ears unchanged.
 * Translating "eigenvalue" into a coined Hindi compound would make the sentence
 * easier and the degree harder.
 *
 * So before a sentence goes anywhere near a translation model, every known term
 * is lifted out and replaced with a sentinel. The model translates the
 * connective tissue between the sentinels and never sees the terms at all - it
 * cannot translate what it was never given.
 */

/** A sentinel the model is instructed never to alter. */
const SENTINEL_OPEN = '⟦'; // MATHEMATICAL LEFT WHITE SQUARE BRACKET
const SENTINEL_CLOSE = '⟧';

export function sentinel(i: number): string {
  return `${SENTINEL_OPEN}${i}${SENTINEL_CLOSE}`;
}

/** Matches a sentinel, tolerating whitespace the model may have introduced. */
const SENTINEL_RE = new RegExp(`${SENTINEL_OPEN}\\s*(\\d+)\\s*${SENTINEL_CLOSE}`, 'g');

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

/**
 * Speech recognition is wildly inconsistent about technical vocabulary. The
 * same spoken word arrives as "eigenvalue", "eigen value", "Eigen-value" or
 * "eigen  value" depending on the acoustic model's mood. Normalising away case,
 * punctuation and hyphenation lets one glossary entry catch all of them.
 */
function normalizeToken(token: string): string {
  return token
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks so accented forms match their bare equivalents.
    .replace(/[̀-ͯ]/g, '')
    // Drop anything that is not a letter or digit in any script.
    .replace(/[^\p{L}\p{N}]/gu, '');
}

interface Token {
  raw: string;
  norm: string;
  start: number;
  end: number;
}

/** Splits text into word tokens, remembering where each came from. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  // A "word" is a run of letters and digits, plus the joiners that appear
  // *inside* technical vocabulary - "node.js", "big-o", "eigen-value".
  //
  // Those joiners are deliberately not allowed in final position. If they were,
  // "the matrix." would tokenise as `matrix.` and the trailing full stop would
  // be captured as part of the protected term, then spliced into the middle of
  // the translated sentence - stranding punctuation and making the English
  // voice pronounce a sentence break that is not there.
  const re = /[\p{L}\p{N}](?:[\p{L}\p{N}’'\-_.]*[\p{L}\p{N}])?/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const norm = normalizeToken(m[0]);
    if (!norm) continue;
    tokens.push({ raw: m[0], norm, start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

/* ------------------------------------------------------------------ *
 * Matcher
 * ------------------------------------------------------------------ */

export interface TermMatcher {
  /** Normalised multi-word phrase -> term. */
  spaced: Map<string, GlossaryTerm>;
  /** Same phrase with separators removed, bridging "eigen value"/"eigenvalue". */
  collapsed: Map<string, GlossaryTerm>;
  /** Longest alias length in tokens, used to bound the scan window. */
  maxTokens: number;
}

export function buildMatcher(terms: GlossaryTerm[]): TermMatcher {
  const spaced = new Map<string, GlossaryTerm>();
  const collapsed = new Map<string, GlossaryTerm>();
  let maxTokens = 1;

  for (const term of terms) {
    for (const surface of [term.term, ...term.aliases]) {
      const parts = tokenize(surface).map((t) => t.norm);
      if (parts.length === 0) continue;
      maxTokens = Math.max(maxTokens, parts.length);

      const spacedKey = parts.join(' ');
      // First writer wins, so an explicit `term` is never shadowed by some
      // other entry's alias.
      if (!spaced.has(spacedKey)) spaced.set(spacedKey, term);

      const collapsedKey = parts.join('');
      if (!collapsed.has(collapsedKey)) collapsed.set(collapsedKey, term);
    }
  }

  return { spaced, collapsed, maxTokens };
}

/* ------------------------------------------------------------------ *
 * Masking
 * ------------------------------------------------------------------ */

export interface TermHit {
  /** Index of the sentinel that replaced this occurrence. */
  slot: number;
  term: GlossaryTerm;
  /** The text exactly as the professor said it, which is what we restore. */
  surface: string;
}

export interface MaskResult {
  /** Text with every known term replaced by a sentinel. */
  masked: string;
  hits: TermHit[];
}

/**
 * Replaces every glossary term in `text` with a numbered sentinel.
 *
 * Longest match wins, so "partial differential equation" is protected as a
 * single unit rather than being shredded into "partial", "differential" and
 * "equation" - three terms that mean something quite different apart.
 */
export function maskTerms(text: string, matcher: TermMatcher): MaskResult {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { masked: text, hits: [] };

  const hits: TermHit[] = [];
  const pieces: string[] = [];
  let cursor = 0; // position in the original string
  let i = 0; // position in the token array

  while (i < tokens.length) {
    let matched: { term: GlossaryTerm; span: number } | null = null;

    const window = Math.min(matcher.maxTokens, tokens.length - i);
    for (let n = window; n >= 1; n--) {
      const slice = tokens.slice(i, i + n);
      const key = slice.map((t) => t.norm).join(' ');
      const term = matcher.spaced.get(key) ?? matcher.collapsed.get(key.replace(/ /g, ''));
      if (term) {
        matched = { term, span: n };
        break;
      }
    }

    if (!matched) {
      i++;
      continue;
    }

    const first = tokens[i];
    const last = tokens[i + matched.span - 1];

    // Emit the untouched text preceding the term, then the sentinel.
    pieces.push(text.slice(cursor, first.start));
    pieces.push(sentinel(hits.length));
    hits.push({
      slot: hits.length,
      term: matched.term,
      surface: text.slice(first.start, last.end),
    });

    cursor = last.end;
    i += matched.span;
  }

  pieces.push(text.slice(cursor));
  return { masked: pieces.join(''), hits };
}

/* ------------------------------------------------------------------ *
 * Unmasking - and the run split that makes preservation audible
 * ------------------------------------------------------------------ */

export interface UnmaskResult {
  /** Translated text with the original terms spliced back in. */
  text: string;
  /** The same content split by language, ready for multi-voice synthesis. */
  runs: SpeechRun[];
  /** Sentinels the model dropped. A non-empty list means trouble. */
  missing: number[];
}

/**
 * Restores terms into a translated string and, in the same pass, produces the
 * per-language run split used for speech synthesis.
 *
 * Doing both at once is deliberate. The sentinel positions are the only place
 * where we know with certainty which characters are term and which are
 * explanation. Recovering that boundary afterwards, from the finished string,
 * would mean guessing - and a wrong guess sends a Hindi voice at a Latin word.
 */
export function unmaskTerms(
  translated: string,
  hits: TermHit[],
  targetLang: LangCode,
  instructionLang: LangCode,
): UnmaskResult {
  const runs: SpeechRun[] = [];
  const out: string[] = [];
  const seen = new Set<number>();

  let cursor = 0;
  SENTINEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  const pushRun = (text: string, lang: LangCode, isTerm: boolean) => {
    if (!text) return;
    const prev = runs[runs.length - 1];
    // Merge adjacent runs of the same kind, so the synthesiser is not handed a
    // long tail of one-word utterances each carrying its own start-up delay.
    if (prev && prev.lang === lang && prev.isTerm === isTerm) {
      prev.text += text;
      return;
    }
    runs.push({ lang, text, isTerm });
  };

  while ((m = SENTINEL_RE.exec(translated)) !== null) {
    const slot = Number(m[1]);
    const hit = hits.find((h) => h.slot === slot);

    const before = translated.slice(cursor, m.index);
    out.push(before);
    pushRun(before, targetLang, false);

    if (hit) {
      seen.add(slot);
      out.push(hit.surface);
      pushRun(hit.surface, instructionLang, true);
    }
    // A sentinel with no matching hit means the model invented one. Dropping it
    // silently beats surfacing bracket noise to the student.

    cursor = m.index + m[0].length;
  }

  const tail = translated.slice(cursor);
  out.push(tail);
  pushRun(tail, targetLang, false);

  const missing = hits.filter((h) => !seen.has(h.slot)).map((h) => h.slot);

  return { text: out.join(''), runs, missing };
}

/**
 * Last-resort repair for a translation that lost its sentinels.
 *
 * Rather than discard the translation - which would leave the student with
 * silence - the dropped terms are appended as a short trailing clause. An
 * awkward sentence still carries the term; a missing sentence carries nothing.
 */
export function appendDroppedTerms(
  result: UnmaskResult,
  hits: TermHit[],
  instructionLang: LangCode,
): UnmaskResult {
  if (result.missing.length === 0) return result;

  const dropped = result.missing
    .map((slot) => hits.find((h) => h.slot === slot)?.surface)
    .filter((s): s is string => Boolean(s));

  if (dropped.length === 0) return result;

  const suffix = ` (${dropped.join(', ')})`;
  return {
    text: result.text + suffix,
    runs: [...result.runs, { lang: instructionLang, text: suffix, isTerm: true }],
    missing: result.missing,
  };
}

/**
 * Splits plain untranslated text into runs, protecting known terms.
 *
 * Used by the fallback engine and by the "no translation needed" path, where a
 * student listening in the language of instruction still benefits from having
 * terms marked for the subtitle view.
 */
export function runsFromPlainText(
  text: string,
  matcher: TermMatcher,
  lang: LangCode,
  instructionLang: LangCode,
): SpeechRun[] {
  const { masked, hits } = maskTerms(text, matcher);
  return unmaskTerms(masked, hits, lang, instructionLang).runs;
}
