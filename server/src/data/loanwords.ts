import type { GlossaryTerm } from '@suvidha/shared';

/**
 * Everyday English words that stay English in Indian classroom speech.
 *
 * Asking the model for natural code-mixing works, but not reliably: the same
 * sentence comes back with "graph" one run and "ग्राफ" the next. Transliteration
 * is not wrong exactly - a Hindi voice reads ग्राफ as "graph" - but it leaves
 * the student reading a spelling they will never see in the textbook, and it
 * makes the voice split non-deterministic.
 *
 * So these are protected by the same sentinel mechanism as technical terms.
 * The model never receives them and therefore cannot render them at all, which
 * turns a matter of persuasion into a matter of fact.
 *
 * They are NOT technical terms and are deliberately marked differently:
 * `source: 'loanword'` keeps them out of the teal highlighting, which means
 * "textbook vocabulary you are meant to learn". "zero" is not that. It just
 * needs to survive.
 *
 * The list is short on purpose. Every entry is a word that an Indian lecturer
 * says in English while speaking Hindi or Bengali; anything debatable is left
 * out, because wrongly protecting a common word leaves it untranslated in every
 * sentence it appears in, which is the failure this product exists to prevent.
 */

/**
 * Nouns and adjectives only. No verbs.
 *
 * A masked word is invisible to the model, which means the model cannot inflect
 * it to fit the sentence. For a noun that costs nothing. For a verb it produces
 * "shifts हो जाता है", where a lecturer would say "shift हो जाता है" - or, better
 * still, would have used the Hindi verb: "अगर हम frequency बढ़ाते हैं" is more
 * natural than "frequency को increase करें", and the model gets there on its own
 * once "increase" is left available to translate.
 *
 * So verbs stay out. Protection is for words whose form never changes.
 */
const WORDS = [
  // Quantity and measurement
  'zero', 'energy', 'force', 'speed', 'mass', 'value', 'unit',
  'positive', 'negative', 'average',
  // Geometry and plotting
  'graph', 'point', 'line', 'curve', 'angle', 'direction', 'axis', 'area',
  'volume', 'slope', 'scale',
  // Structure and reasoning
  'system', 'example', 'simple', 'independent', 'constant', 'variable',
  'formula', 'equation', 'result', 'condition', 'property',
];

/**
 * Regular plurals.
 *
 * Derived rather than listed so a new entry above cannot be half-covered. Only
 * plurals: participles would reintroduce the verb problem described above.
 */
function forms(word: string): string[] {
  const out = new Set<string>();
  if (/(s|x|z|ch|sh)$/.test(word)) out.add(`${word}es`);
  else if (/[^aeiou]y$/.test(word)) out.add(`${word.slice(0, -1)}ies`);
  else out.add(`${word}s`);
  out.delete(word);
  return [...out];
}

export const LOANWORDS: GlossaryTerm[] = WORDS.map((word, i) => ({
  id: `loan-${i}`,
  term: word,
  aliases: forms(word),
  source: 'loanword',
}));

/** True when a hit came from this list rather than the lecture's glossary. */
export function isLoanword(term: GlossaryTerm): boolean {
  return term.source === 'loanword';
}
