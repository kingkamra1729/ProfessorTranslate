/**
 * Exercises the two features that need a live third-party call and therefore
 * cannot be covered by the offline suites: Wolfram diagram rendering and
 * Firecrawl glossary import.
 *
 *   npx tsx src/features.test.ts
 *
 * Both spend credits, so this is a separate command rather than part of
 * `npm test`.
 */
import { buildMatcher, maskTerms } from './pipeline/glossary.js';
import { renderVisual, requestVisual } from './pipeline/visualize.js';
import { buildGlossaryFromSource } from './pipeline/auto-glossary.js';
import { scoutTerms } from './pipeline/term-scout.js';
import { mergePacks } from './data/glossary-packs.js';
import { translateUtterance } from './pipeline/translate.js';
import { isWolframConfigured } from './providers/wolfram.js';
import { isFirecrawlConfigured } from './providers/firecrawl.js';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) {
      console.log('       ', String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400));
    }
  }
}

async function testVisualisation() {
  console.log('\nvisualisation — draft, approve, render');

  if (!isWolframConfigured()) {
    console.log('  (skipped: no Wolfram credentials)');
    return;
  }

  // 1. A professor asks for a diagram in plain speech.
  const draft = await requestVisual(
    'Show me a damped oscillation, e to the minus x over 4 times sine of 3x, from 0 to 20',
    'FEATURES',
  );

  check('drafted a spec from natural speech', Boolean(draft.id && draft.title), draft.title);
  check('spec starts as a proposal, not published', draft.status === 'proposed', draft.status);
  check('spec carries a spoken description for blind students',
    Boolean(draft.altText.en && draft.altText.en.length > 10), draft.altText.en);
  if (draft.expression) console.log(`       expression: ${draft.expression}`);

  // 2. The professor approves it, which is when rendering happens.
  const rendered = await renderVisual(draft, ['hi', 'bn'], 'en');

  check('approved spec renders an image', Boolean(rendered.rendered?.startsWith('data:image/')),
    rendered.error ?? rendered.rendered?.slice(0, 40));

  if (rendered.rendered) {
    const kb = Math.round((rendered.rendered.length * 0.75) / 1024);
    console.log(`       image: ${kb} kB`);
  }

  // 3. Accessibility: the description must exist in the students' languages.
  check('description translated to Hindi', Boolean(rendered.altText.hi), rendered.altText.hi);
  check('description translated to Bengali', Boolean(rendered.altText.bn), rendered.altText.bn);
  if (rendered.altText.hi) console.log(`       hi: ${rendered.altText.hi}`);
}

async function testGlossaryImport() {
  console.log('\nglossary import — Firecrawl + extraction');

  if (!isFirecrawlConfigured()) {
    console.log('  (skipped: no Firecrawl key)');
    return;
  }

  const url = 'https://en.wikipedia.org/wiki/Simple_harmonic_motion';
  console.log(`       scraping ${url}`);

  let terms;
  try {
    terms = await buildGlossaryFromSource({ url, subject: 'Physics — oscillations' });
  } catch (err) {
    check('scraped and extracted terms', false, err instanceof Error ? err.message : String(err));
    return;
  }

  check('extracted a usable number of terms', terms.length >= 8, terms.length);
  check('terms carry aliases for speech-recognition mishearings',
    terms.some((t) => t.aliases.length > 0),
    terms.slice(0, 3).map((t) => ({ term: t.term, aliases: t.aliases })));

  const names = terms.map((t) => t.term.toLowerCase());
  check('found subject vocabulary, not generic academic words',
    names.some((n) => /amplitude|frequenc|oscillat|harmonic|restoring|damp|period/.test(n)),
    names.slice(0, 12));
  check('excluded generic academic filler',
    !names.some((n) => ['introduction', 'chapter', 'example', 'exercise'].includes(n)),
    names.filter((n) => ['introduction', 'chapter', 'example', 'exercise'].includes(n)));

  console.log(`       sample: ${terms.slice(0, 10).map((t) => t.term).join(', ')}`);

  if (terms.length === 0) {
    check('cannot verify protection without any extracted terms', false);
    return;
  }

  // The point of importing is protection, so prove the imported terms protect.
  const matcher = buildMatcher(terms);
  const spoken = `The ${terms[0].term} determines how the system behaves over time.`;
  const { hits } = maskTerms(spoken, matcher);
  check(`imported term "${terms[0].term}" is protected in live speech`, hits.length >= 1,
    hits.map((h) => h.surface));

  const tr = await translateUtterance({
    utteranceId: 'features',
    text: spoken,
    from: 'en',
    to: 'hi',
    matcher,
  });
  const termRuns = tr.runs.filter((r) => r.isTerm).map((r) => r.text.trim());
  check('and survives translation untouched', termRuns.includes(terms[0].term), {
    expected: terms[0].term,
    got: termRuns,
    text: tr.text,
  });
  console.log(`       hi: ${tr.text}`);
}

async function testTermScout() {
  console.log('\nterm scout — catching vocabulary the glossary missed');

  // A linear-algebra glossary, deliberately missing the terms this lecture uses.
  const glossary = mergePacks(['linear-algebra']);

  const passage = [
    'Today we are going to look at the Gram-Schmidt process for building an orthonormal basis.',
    'You start with any set of vectors and you subtract off the projections one at a time.',
    'What you end up with is a set where every vector is perpendicular to the others.',
    'This is the same idea behind the QR decomposition, which we will use next week.',
    'The spring on the door is quite loud today, so speak up if you cannot hear me.',
  ].join(' ');

  const found = await scoutTerms({ text: passage, glossary });
  const names = found.map((f) => f.term.toLowerCase());
  console.log(`       suggested: ${found.map((f) => f.term).join(', ') || '(none)'}`);

  check('found technical vocabulary missing from the glossary', found.length > 0, names);
  check('caught at least one of Gram-Schmidt / QR decomposition / orthonormal',
    names.some((n) => /gram|schmidt|qr|orthonormal|projection/.test(n)), names);

  // The asymmetry that matters: a wrongly protected common word is left
  // untranslated in every sentence it appears in, for the rest of the lecture.
  check('did NOT protect the ordinary word "spring"', !names.includes('spring'), names);
  check('did NOT protect ordinary words generally',
    !names.some((n) => ['door', 'set', 'idea', 'week', 'time', 'system'].includes(n)), names);

  check('suggestions carry the sentence they were heard in',
    found.every((f) => f.heardIn.length > 0), found.map((f) => f.heardIn));
  check('suggestions only contain terms actually spoken',
    found.every((f) => passage.toLowerCase().includes(f.term.toLowerCase())), names);

  // Nothing new to find when the glossary already covers the passage.
  const covered = await scoutTerms({
    text: 'The eigenvalue of the matrix tells us how the eigenvector is scaled by the linear transformation. The determinant is zero here.',
    glossary,
  });
  check('stays quiet when the glossary already covers the speech', covered.length === 0,
    covered.map((c) => c.term));
}

async function main() {
  await testVisualisation();
  await testGlossaryImport();
  await testTermScout();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nfeature test crashed:', err);
  process.exit(1);
});
