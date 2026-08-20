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

async function main() {
  await testVisualisation();
  await testGlossaryImport();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nfeature test crashed:', err);
  process.exit(1);
});
