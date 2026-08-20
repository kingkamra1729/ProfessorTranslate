/**
 * Exercises the term-protection engine end to end.
 *
 * Run with:  npx tsx src/pipeline/glossary.test.ts
 *
 * These assertions encode the product's central promise: a term the professor
 * said in English reaches the student's ear in English, in an English voice,
 * no matter what the translation model does to the sentence around it.
 */
import {
  buildMatcher,
  maskTerms,
  unmaskTerms,
  appendDroppedTerms,
  sentinel,
  voiceEmbeddedLatin,
} from './glossary.js';
import { mergePacks } from '../data/glossary-packs.js';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log('       ', JSON.stringify(detail));
  }
}

const matcher = buildMatcher(mergePacks(['linear-algebra', 'calculus', 'cs-algorithms']));

console.log('\nmaskTerms');
{
  const src = 'So the eigenvalue of this matrix tells us how much the eigenvector is stretched.';
  const { masked, hits } = maskTerms(src, matcher);
  check('replaces three terms with sentinels', hits.length === 3, { masked, hits: hits.map(h => h.surface) });
  check('sentinels are numbered in order', masked.includes(sentinel(0)) && masked.includes(sentinel(2)), masked);
  check('surrounding words survive', masked.includes('tells us how much'), masked);
  check('original surface forms retained', hits.map((h) => h.surface).join('|') === 'eigenvalue|matrix|eigenvector', hits.map(h => h.surface));
}

{
  // ASR mangling: spaced, mis-cased, and a homophone alias.
  const src = 'Now the Eigen value changes when we write the sudo code.';
  const { hits } = maskTerms(src, matcher);
  check('catches "Eigen value" (spaced + capitalised)', hits.some((h) => h.term.term === 'eigenvalue'), hits.map(h => h.surface));
  check('catches "sudo code" (ASR homophone)', hits.some((h) => h.term.term === 'pseudocode'), hits.map(h => h.surface));
}

{
  // Longest match must win, otherwise this becomes three unrelated terms.
  const src = 'This is a partial differential equation.';
  const { hits } = maskTerms(src, matcher);
  check('longest match wins over constituent words', hits.length === 1 && hits[0].term.term === 'partial differential equation', hits.map(h => h.term.term));
}

{
  const src = 'Consider the interesting properties of light and colour.';
  const { masked, hits } = maskTerms(src, matcher);
  check('no false positives on ordinary prose', hits.length === 0 && masked === src, { masked, hits: hits.map(h => h.surface) });
}

console.log('\nunmaskTerms + run split');
{
  const src = 'The eigenvalue of the matrix is two.';
  const { masked, hits } = maskTerms(src, matcher);
  // Simulate what a translation model returns: Hindi prose, sentinels intact.
  const modelOutput = `इस ${sentinel(1)} का ${sentinel(0)} दो है।`;
  const result = unmaskTerms(modelOutput, hits, 'hi', 'en');

  check('terms restored into translated text', result.text === 'इस matrix का eigenvalue दो है।', result.text);
  check('no sentinels dropped', result.missing.length === 0, result.missing);

  const termRuns = result.runs.filter((r) => r.isTerm);
  check('term runs tagged as instruction language', termRuns.every((r) => r.lang === 'en'), result.runs);
  check('term runs carry the English surface forms', termRuns.map((r) => r.text).join('|') === 'matrix|eigenvalue', termRuns.map(r => r.text));
  check('explanation runs tagged as target language', result.runs.filter((r) => !r.isTerm).every((r) => r.lang === 'hi'), result.runs);
  check('runs concatenate back to the full text', result.runs.map((r) => r.text).join('') === result.text, result.runs.map(r => r.text));
}

{
  // Reordering: Hindi puts the possessor first. Runs must follow the
  // translation's word order, not the source's.
  const src = 'The derivative of the matrix.';
  const { hits } = maskTerms(src, matcher);
  const modelOutput = `${sentinel(1)} का ${sentinel(0)}`;
  const result = unmaskTerms(modelOutput, hits, 'hi', 'en');
  check('run order follows the translation, not the source', result.runs.filter(r => r.isTerm).map((r) => r.text).join('|') === 'matrix|derivative', result.runs.map(r => r.text));
}

console.log('\ndegraded model output');
{
  const src = 'The eigenvalue and the determinant.';
  const { hits } = maskTerms(src, matcher);
  // Model dropped sentinel 1 entirely - a real and common failure.
  const modelOutput = `${sentinel(0)} और वह संख्या।`;
  const result = unmaskTerms(modelOutput, hits, 'hi', 'en');
  check('detects the dropped sentinel', result.missing.length === 1 && result.missing[0] === 1, result.missing);

  const repaired = appendDroppedTerms(result, hits, 'en');
  check('repair appends the lost term rather than losing it', repaired.text.includes('determinant'), repaired.text);

  const repairedTermRuns = repaired.runs.filter((r) => r.isTerm);
  check('recovered term is its own run, spoken in the instruction language',
    repairedTermRuns.some((r) => r.text === 'determinant' && r.lang === 'en'),
    repaired.runs.map(r => `${r.lang}:${r.isTerm}:${r.text}`));
  check('brackets are explanation, not part of the term run',
    repairedTermRuns.every((r) => !/[()]/.test(r.text)), repairedTermRuns);
  check('repaired runs still reconstruct the text exactly',
    repaired.runs.map((r) => r.text).join('') === repaired.text,
    { joined: repaired.runs.map(r => r.text).join(''), text: repaired.text });
}

{
  const src = 'The matrix.';
  const { hits } = maskTerms(src, matcher);
  // Model added whitespace inside the sentinel - LLMs do this constantly.
  const result = unmaskTerms('यह ⟦ 0 ⟧ है।', hits, 'hi', 'en');
  check('tolerates whitespace inside sentinels', result.text === 'यह matrix है।', result.text);
}

{
  const src = 'The matrix.';
  const { hits } = maskTerms(src, matcher);
  // Model hallucinated a sentinel that was never sent.
  const result = unmaskTerms(`यह ${sentinel(0)} और ${sentinel(7)} है।`, hits, 'hi', 'en');
  check('drops hallucinated sentinels instead of showing brackets', !result.text.includes('⟦'), result.text);
}

console.log('\nrun merging');
{
  const src = 'A matrix is a grid.';
  const { hits } = maskTerms(src, matcher);
  const result = unmaskTerms(`एक ${sentinel(0)} एक जाल है और यह उपयोगी है।`, hits, 'hi', 'en');
  const hiRuns = result.runs.filter((r) => r.lang === 'hi');
  check('adjacent same-language runs are merged', hiRuns.length === 2, result.runs.map(r => `${r.lang}:${r.text}`));
}

{
  // Models sometimes emit two sentinels with nothing between them. The empty
  // gap must not cause the two terms to be fused into one run.
  const src = 'The eigenvalue and matrix are related.';
  const { hits } = maskTerms(src, matcher);
  const result = unmaskTerms(`${sentinel(0)}${sentinel(1)} संबंधित हैं।`, hits, 'hi', 'en');
  const termRuns = result.runs.filter((r) => r.isTerm);
  check('adjacent sentinels stay separate runs', termRuns.length === 2, result.runs.map(r => `${r.lang}:${r.isTerm}:${r.text}`));
  check('adjacent terms are not fused into one word',
    termRuns.map((r) => r.text).join('|') === 'eigenvalue|matrix', termRuns.map(r => r.text));
  check('no run reads as a fused non-word',
    !result.runs.some((r) => r.text.includes('eigenvaluematrix')), result.text);
}

console.log('\ncode-mixed loanwords');
{
  // Natural classroom Hindi keeps English words. They must be voiced in
  // English rather than handed to a Hindi voice as Latin text, whose
  // pronunciation then depends on whichever synthesiser the student's device
  // happens to have.
  const runs = voiceEmbeddedLatin(
    [
      { lang: 'hi', text: 'अगर हम ', isTerm: false },
      { lang: 'en', text: 'frequency', isTerm: true },
      { lang: 'hi', text: ' बढ़ाते हैं, तो graph दाईं तरफ shift होता है।', isTerm: false },
    ],
    'hi',
    'en',
  );

  const english = runs.filter((r) => r.lang === 'en').map((r) => r.text);
  check('embedded English words get an English voice',
    english.includes('graph') && english.includes('shift'),
    runs.map((r) => `${r.lang}:${r.text}`));
  check('the protected term keeps its term flag',
    runs.some((r) => r.text === 'frequency' && r.isTerm),
    runs.filter((r) => r.isTerm).map((r) => r.text));
  // isTerm drives the teal highlighting, which means "textbook vocabulary".
  // An ordinary loanword must not dilute that signal.
  check('loanwords are voiced in English but not marked as terms',
    runs.filter((r) => r.isTerm).length === 1,
    runs.filter((r) => r.isTerm).map((r) => r.text));
  check('Hindi runs contain no Latin words',
    runs.filter((r) => r.lang === 'hi').every((r) => !/[A-Za-z]{2,}/.test(r.text)),
    runs.filter((r) => r.lang === 'hi').map((r) => r.text));
  check('reassembling the runs reproduces the sentence exactly',
    runs.map((r) => r.text).join('') ===
      'अगर हम frequency बढ़ाते हैं, तो graph दाईं तरफ shift होता है।',
    runs.map((r) => r.text).join(''));
}

{
  // French is written in Latin script, so an English word is indistinguishable
  // from its surroundings; splitting would put an English voice on ordinary
  // French words.
  const runs = voiceEmbeddedLatin(
    [{ lang: 'fr', text: 'Donc la courbe monte vers la droite.', isTerm: false }],
    'fr',
    'en',
  );
  check('Latin-script targets are left alone', runs.length === 1 && runs[0].lang === 'fr', runs);
}

{
  const runs = voiceEmbeddedLatin(
    [{ lang: 'hi', text: 'यह x और y के बीच है।', isTerm: false }],
    'hi',
    'en',
  );
  check('single-letter variable names are voiced in English',
    runs.filter((r) => r.lang === 'en').map((r) => r.text).join('|') === 'x|y',
    runs.map((r) => `${r.lang}:${r.text}`));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
