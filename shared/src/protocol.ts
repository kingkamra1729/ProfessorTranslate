import type { LangCode } from './languages.js';

/* ------------------------------------------------------------------ *
 * Glossary
 * ------------------------------------------------------------------ */

/**
 * A term that must survive translation untouched. "Eigenvalue" stays
 * "eigenvalue" whether the student is listening in Hindi, Bengali or French.
 */
export interface GlossaryTerm {
  id: string;
  /** Canonical surface form, as the professor would write it on the board. */
  term: string;
  /**
   * Other ways speech recognition might render it. ASR mangles jargon
   * constantly - "eigen value", "igen value", "Eigen-value" all mean the same
   * thing and all must be protected.
   */
  aliases: string[];
  /**
   * Optional short definition, shown in the student's term sidebar in their
   * own language. The *definition* may be translated; the *term* may not.
   */
  gloss?: Partial<Record<LangCode, string>>;
  source: 'manual' | 'imported' | 'auto';
}

/* ------------------------------------------------------------------ *
 * Speech runs - the heart of term preservation
 * ------------------------------------------------------------------ */

/**
 * A translated sentence is not spoken by a single voice. It is spoken as a
 * sequence of runs, each tagged with the language it must be pronounced in.
 *
 *   [hi] "तो इस "  [en] "matrix"  [hi] " का "  [en] "eigenvalue"  [hi] " हमें बताता है"
 *
 * A Hindi voice reading the Latin string "eigenvalue" produces something
 * unintelligible; an English voice reading it produces the word the professor
 * actually said. Splitting the utterance across two voices is what makes the
 * "terms stay in the language of instruction" rule audible rather than merely
 * visible in the subtitles.
 */
export interface SpeechRun {
  lang: LangCode;
  text: string;
  /** True when this run is a protected glossary term. */
  isTerm: boolean;
}

/* ------------------------------------------------------------------ *
 * Transcript
 * ------------------------------------------------------------------ */

/** One chunk of professor speech, in the language of instruction. */
export interface Utterance {
  id: string;
  lectureId: string;
  /** Milliseconds since lecture start. */
  t: number;
  /** Verbatim recognised text, language of instruction. */
  text: string;
  /** Terms detected in this utterance, by GlossaryTerm id. */
  termIds: string[];
  /** False while speech recognition is still revising this chunk. */
  final: boolean;
}

/** The rendering of one utterance into one comprehension language. */
export interface Translation {
  utteranceId: string;
  lang: LangCode;
  /** Full translated text with terms restored inline. Used for subtitles. */
  text: string;
  /** The same content split for multi-voice synthesis. Used for audio. */
  runs: SpeechRun[];
  /** Round-trip latency in ms, measured server side. Surfaced in the UI. */
  latencyMs: number;
  /** Which engine produced this, so the UI can be honest about quality. */
  engine: 'llm' | 'fallback';
}

/* ------------------------------------------------------------------ *
 * Visualisations
 * ------------------------------------------------------------------ */

export type VizKind =
  | 'function2d'    // y = f(x) over a range
  | 'parametric2d'  // (x(t), y(t))
  | 'surface3d'     // z = f(x,y)
  | 'vectorfield'   // physics / vector calculus
  | 'wolfram'       // arbitrary Wolfram Language graphic, rendered server side
  | 'formula';      // typeset expression only

/**
 * A visualisation the system proposes mid-lecture. Proposals are queued for
 * the professor to approve rather than pushed straight to students - an
 * unreviewed AI diagram on 200 screens during a lecture is a liability.
 */
export interface VizSpec {
  id: string;
  lectureId: string;
  kind: VizKind;
  /** Short label, in the language of instruction. */
  title: string;
  /** Wolfram Language expression, evaluated server side for image kinds. */
  expression?: string;
  /**
   * The same request phrased as a Wolfram|Alpha natural-language query.
   *
   * Kept alongside `expression` because the two rendering routes want different
   * input: a deployed Wolfram Cloud endpoint evaluates the expression, while
   * Alpha parses either but does better with a query it was designed for. The
   * title is not a substitute - it is a human label and Alpha rejects it.
   */
  query?: string;
  /** Plot domain, for the plotting kinds. */
  domain?: { xMin: number; xMax: number; yMin?: number; yMax?: number };
  /** Rendered result: a data URI (image) or LaTeX (formula). */
  rendered?: string;
  /**
   * Spoken description of the graphic, translated per language. This is the
   * accessibility payload - a student who cannot see the plot hears it
   * described instead of hearing nothing.
   */
  altText: Partial<Record<LangCode, string>>;
  /** Utterance that triggered the proposal, for replay alignment. */
  sourceUtteranceId?: string;
  status: 'proposed' | 'approved' | 'rejected' | 'error';
  error?: string;
}

/* ------------------------------------------------------------------ *
 * Lecture
 * ------------------------------------------------------------------ */

export interface LectureMeta {
  id: string;
  title: string;
  course: string;
  instructor: string;
  /** The language the professor is speaking. Terms are preserved in this. */
  instructionLang: LangCode;
  startedAt: number;
  endedAt?: number;
  /** Populated when the lecture is archived for replay. */
  utteranceCount?: number;
}

/** Everything needed to replay a lecture offline, including for a screen reader. */
export interface LectureRecording extends LectureMeta {
  utterances: Utterance[];
  translations: Record<string, Translation[]>;
  glossary: GlossaryTerm[];
  visuals: VizSpec[];
}

/* ------------------------------------------------------------------ *
 * WebSocket protocol
 * ------------------------------------------------------------------ */

/**
 * Terms the system noticed the professor using that are not yet protected.
 *
 * The glossary is the single point of failure in the whole design: a term that
 * is not in it is a term the model is free to translate. Packs and imports get
 * most of the way, but every lecture has vocabulary nobody thought to list -
 * and the moment it is spoken it is already too late for that sentence.
 */
export interface TermSuggestion {
  term: string;
  aliases: string[];
  /** Why the system thinks this is subject vocabulary. Shown to the professor. */
  reason: string;
  /** The sentence it was heard in, so the professor can judge in context. */
  heardIn: string;
}

/** Client -> server. */
export type ClientMessage =
  | { type: 'prof:join'; lectureId: string }
  | { type: 'prof:utterance'; text: string; final: boolean; t: number }
  | { type: 'prof:end' }
  | { type: 'prof:viz-decision'; vizId: string; approve: boolean }
  | { type: 'prof:request-viz'; prompt: string }
  | { type: 'prof:accept-terms'; terms: TermSuggestion[] }
  | { type: 'prof:dismiss-terms' }
  | { type: 'student:join'; lectureId: string; lang: LangCode }
  | { type: 'student:set-lang'; lang: LangCode }
  | { type: 'ping' };

/** Server -> client. */
export type ServerMessage =
  | { type: 'joined'; role: 'professor' | 'student'; lecture: LectureMeta; glossary: GlossaryTerm[] }
  | { type: 'error'; message: string }
  | { type: 'utterance'; utterance: Utterance }
  | { type: 'translation'; translation: Translation }
  | { type: 'viz'; viz: VizSpec }
  | { type: 'listeners'; counts: Partial<Record<LangCode, number>>; total: number }
  | { type: 'glossary'; glossary: GlossaryTerm[] }
  | { type: 'term-suggestions'; suggestions: TermSuggestion[] }
  | { type: 'lecture-ended'; lectureId: string }
  | { type: 'pong' };
