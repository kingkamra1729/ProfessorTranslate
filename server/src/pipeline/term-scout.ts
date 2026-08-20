import type { GlossaryTerm, TermSuggestion } from '@suvidha/shared';
import { chatWithRetry, gateStatus, isConfigured } from '../providers/featherless.js';
import { config } from '../config.js';
import { buildMatcher, maskTerms } from './glossary.js';

/**
 * Catching the vocabulary nobody listed.
 *
 * Everything else in this system is downstream of one fragile assumption: that
 * the glossary contains the terms the professor is about to say. Subject packs
 * and a syllabus import get most of the way, but every real lecture has
 * vocabulary that was never written down - a lecturer's preferred phrasing, a
 * term from last week's reading, the name of the theorem they are about to
 * prove. Each one is a word the translation model is free to render into
 * something the textbook does not use.
 *
 * So this watches what is actually being said and flags candidates the glossary
 * does not cover. It cannot fix the sentence already spoken. It can stop the
 * same term being mistranslated for the remaining forty minutes.
 *
 * Suggestions go to the professor, never straight into the glossary. The cost
 * of a wrong entry is real: protecting an ordinary word like "spring" or
 * "force" would leave it untranslated every time it is spoken, which is exactly
 * the comprehension failure this product exists to remove.
 */

const SCOUT_SYSTEM = [
  'You are given a passage of speech from a university lecture, and a list of technical terms that are already handled.',
  '',
  'Find subject-specific technical vocabulary in the passage that is NOT already handled.',
  '',
  'Reply with ONE JSON array and nothing else. No markdown fence, no commentary.',
  '',
  'Each element:',
  '{',
  '  "term": string,      // exactly as it appears in the passage',
  '  "aliases": string[], // ways speech recognition might mangle it when spoken',
  '  "reason": string     // under 12 words, why this is subject vocabulary',
  '}',
  '',
  'Rules:',
  '- Return an empty array [] if nothing qualifies. That is the common case and it is the right answer. Most lecture speech is ordinary language.',
  '- A term qualifies only if a student would meet it in the textbook, the exam, or a job interview for this subject.',
  '- Do NOT include ordinary words that happen to appear in a technical context. "spring", "force", "energy", "system", "value", "point", "line" and similar are ordinary words; protecting them would leave them untranslated and make the lecture HARDER to follow, which is the opposite of the goal.',
  '- Do NOT include anything already in the handled list, in any form.',
  '- Do NOT include names of people, places, or the lecturer.',
  '- At most 5 entries. Prefer precision over coverage.',
].join('\n');

function parseSuggestions(raw: string): Array<{ term?: string; aliases?: string[]; reason?: string }> {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  text = text.replace(/^<think>[\s\S]*?<\/think>\s*/i, '');
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Words that are never worth protecting, whatever a model says.
 *
 * The model is instructed to avoid these, and mostly does. This list is the
 * backstop, because the failure is asymmetric: a missed term costs one
 * mistranslated word, while a wrongly protected common word costs the student
 * that word in every sentence for the rest of the lecture.
 */
const NEVER_PROTECT = new Set([
  'system', 'value', 'point', 'line', 'time', 'number', 'problem', 'example',
  'question', 'answer', 'result', 'method', 'case', 'part', 'thing', 'idea',
  'way', 'change', 'form', 'state', 'set', 'group', 'order', 'level', 'step',
  'process', 'model', 'test', 'unit', 'rate', 'size', 'shape', 'side', 'end',
  'class', 'course', 'lecture', 'chapter', 'section', 'exam', 'student',
]);

export interface ScoutInput {
  /** Recent finalised speech. */
  text: string;
  glossary: GlossaryTerm[];
}

/**
 * Proposes glossary additions from recent speech.
 *
 * Returns an empty array whenever it is unsure, unavailable, or busy - the
 * professor is mid-lecture and a stream of low-quality suggestions is worse
 * than none.
 */
export async function scoutTerms(input: ScoutInput): Promise<TermSuggestion[]> {
  if (!isConfigured()) return [];
  if (input.text.trim().length < 100) return [];

  // Never compete with live translation for the plan's request budget.
  const gate = gateStatus();
  if (gate.waiting > 0 || gate.inFlight >= gate.limit - 1) return [];

  // Anything the glossary already catches is removed before the model sees the
  // passage, so it cannot waste its five slots re-suggesting known terms.
  const matcher = buildMatcher(input.glossary);
  const { masked } = maskTerms(input.text, matcher);
  const passage = masked.replace(/⟦\d+⟧/g, '[known]');

  const handled = input.glossary
    .slice(0, 120)
    .map((t) => t.term)
    .join(', ');

  let raw: string;
  try {
    raw = await chatWithRetry(
      [
        { role: 'system', content: SCOUT_SYSTEM },
        { role: 'user', content: `Already handled: ${handled}\n\nPassage:\n${passage}` },
      ],
      {
        model: config.featherless.reasoningModel,
        temperature: 0.1,
        maxTokens: 500,
        timeoutMs: config.featherless.slowTimeoutMs,
      },
    );
  } catch (err) {
    console.warn('[scout] failed:', err instanceof Error ? err.message : err);
    return [];
  }

  const existing = new Set<string>();
  for (const term of input.glossary) {
    existing.add(term.term.toLowerCase());
    for (const alias of term.aliases) existing.add(alias.toLowerCase());
  }

  const out: TermSuggestion[] = [];
  for (const item of parseSuggestions(raw)) {
    const term = String(item.term ?? '').trim();
    if (!term || term.length > 60) continue;

    const lower = term.toLowerCase();
    if (existing.has(lower)) continue;
    if (NEVER_PROTECT.has(lower)) continue;
    // A single short word is far more likely to be ordinary language than a
    // technical term; multi-word phrases are much safer bets.
    if (!term.includes(' ') && term.length < 5) continue;
    if (out.some((s) => s.term.toLowerCase() === lower)) continue;

    // Only suggest terms actually present in the passage. Models invent
    // plausible subject vocabulary that was never spoken.
    const heardIn = findSentence(input.text, term);
    if (!heardIn) continue;

    out.push({
      term,
      aliases: Array.isArray(item.aliases)
        ? item.aliases.map((a) => String(a).trim()).filter(Boolean).slice(0, 6)
        : [],
      reason: String(item.reason ?? '').slice(0, 90),
      heardIn,
    });
  }

  return out.slice(0, 5);
}

/** Returns the sentence containing `term`, so the professor can judge in context. */
function findSentence(text: string, term: string): string | null {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx < 0) return null;

  let start = text.lastIndexOf('.', idx);
  start = start < 0 ? 0 : start + 1;
  let end = text.indexOf('.', idx + term.length);
  end = end < 0 ? text.length : end + 1;

  return text.slice(start, end).trim();
}

/** Converts an accepted suggestion into a glossary entry. */
export function suggestionToTerm(suggestion: TermSuggestion, index: number): GlossaryTerm {
  return {
    id: `scout-${index}-${suggestion.term.slice(0, 12).replace(/\s+/g, '-')}`,
    term: suggestion.term,
    aliases: suggestion.aliases,
    source: 'auto',
  };
}
