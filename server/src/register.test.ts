/**
 * Measures whether translations sound like a person or like a textbook.
 *
 *   npx tsx src/register.test.ts [runs]
 *
 * Term preservation was already measurable. Register was not, and it turned out
 * to matter just as much: a student handed "अवमंदन" for "damping", or "शून्य"
 * for "zero", has been given a word that is correct, literary, and harder than
 * the English it replaced. The translation technically succeeded and the
 * student still did not understand the lecture.
 *
 * Real Indian classroom speech code-mixes heavily. This checks the output
 * against that reality: literary coinages should be absent, everyday English
 * words should survive, and the protected terms should still be intact.
 */
import { buildMatcher } from './pipeline/glossary.js';
import { clearTranslationCache, translateUtterance } from './pipeline/translate.js';
import { mergePacks } from './data/glossary-packs.js';
import type { LangCode } from '@suvidha/shared';

const RUNS = Number(process.argv[2]) || 3;

interface Case {
  text: string;
  packs: string[];
  /** Terms that must survive untranslated. */
  terms: string[];
  /**
   * Words a real lecturer would leave in English. Not every one has to appear -
   * phrasing varies - but a translation containing none of them has almost
   * certainly reached for the literary register.
   */
  expectEnglish: string[];
}

const CASES: Case[] = [
  {
    text: 'Now let us see what happens when the determinant is zero.',
    packs: ['linear-algebra'],
    terms: ['determinant'],
    expectEnglish: ['zero'],
  },
  {
    text: 'Damping removes energy from the system, so the amplitude keeps dropping.',
    packs: ['physics-mechanics'],
    terms: ['damping', 'amplitude'],
    expectEnglish: ['energy', 'system'],
  },
  {
    text: 'The rank tells you how many independent directions survive in the matrix.',
    packs: ['linear-algebra'],
    terms: ['rank', 'matrix'],
    expectEnglish: ['independent', 'direction'],
  },
  {
    text: 'If we increase the frequency, the graph shifts to the right.',
    packs: ['physics-mechanics'],
    terms: ['frequency'],
    expectEnglish: ['graph'],
  },
];

/**
 * Literary or Sanskritised renderings of words a lecturer says in English.
 *
 * Each of these is a correct dictionary translation and the wrong choice for a
 * student who is already struggling with the lecture.
 */
const TOO_FORMAL: Partial<Record<LangCode, Array<{ word: string; instead: string }>>> = {
  hi: [
    { word: 'शून्य', instead: 'zero' },
    { word: 'ऊर्जा', instead: 'energy' },
    { word: 'प्रणाली', instead: 'system' },
    { word: 'आवृत्ति', instead: 'frequency' },
    { word: 'अवमंदन', instead: 'damping' },
    { word: 'आयाम', instead: 'amplitude' },
    { word: 'आलेख', instead: 'graph' },
    { word: 'सारणिक', instead: 'determinant' },
    { word: 'आव्यूह', instead: 'matrix' },
    { word: 'कोटि', instead: 'rank' },
    { word: 'आइए', instead: 'देखते हैं' },
  ],
  bn: [
    { word: 'শূন্য', instead: 'zero' },
    { word: 'শক্তি', instead: 'energy' },
    { word: 'কম্পাঙ্ক', instead: 'frequency' },
    { word: 'বিস্তার', instead: 'amplitude' },
    { word: 'নির্ণায়ক', instead: 'determinant' },
    { word: 'লেখচিত্র', instead: 'graph' },
  ],
};

let checks = 0;
let failures = 0;

function report(name: string, ok: boolean, detail?: string) {
  checks++;
  if (ok) {
    console.log(`    ok   ${name}`);
  } else {
    failures++;
    console.log(`    FAIL ${name}`);
    if (detail) console.log(`         ${detail}`);
  }
}

async function main() {
  console.log(`\nRegister check over ${RUNS} run(s)\n`);

  for (const lang of ['hi', 'bn'] as const) {
    console.log(`  ${lang}`);
    const formal = TOO_FORMAL[lang] ?? [];

    for (const testCase of CASES) {
      const matcher = buildMatcher(mergePacks(testCase.packs));
      let sample = '';
      let formalHits: string[] = [];
      let englishHits = 0;
      let termsIntact = 0;

      for (let run = 0; run < RUNS; run++) {
        clearTranslationCache();
        const tr = await translateUtterance({
          utteranceId: `reg-${run}`,
          text: testCase.text,
          from: 'en',
          to: lang,
          matcher,
        });
        if (run === 0) sample = tr.text;

        const lower = tr.text.toLowerCase();
        for (const f of formal) {
          if (tr.text.includes(f.word) && !formalHits.includes(f.word)) formalHits.push(f.word);
        }
        if (testCase.expectEnglish.some((w) => lower.includes(w.toLowerCase()))) englishHits++;

        const runTerms = tr.runs.filter((r) => r.isTerm).map((r) => r.text.trim().toLowerCase());
        if (testCase.terms.every((t) => runTerms.some((r) => r.includes(t.toLowerCase())))) {
          termsIntact++;
        }
      }

      console.log(`    "${testCase.text.slice(0, 52)}…"`);
      console.log(`       ${sample}`);

      report(
        'no literary coinage where English is spoken',
        formalHits.length === 0,
        formalHits.length ? `found ${formalHits.map((w) => {
          const f = formal.find((x) => x.word === w);
          return `${w} (should be "${f?.instead}")`;
        }).join(', ')}` : undefined,
      );
      report(
        'everyday English words kept in English',
        englishHits > 0,
        englishHits === 0 ? `expected one of: ${testCase.expectEnglish.join(', ')}` : undefined,
      );
      report('protected terms still intact', termsIntact === RUNS, `${termsIntact}/${RUNS} runs`);
    }
    console.log('');
  }

  console.log(`  ${checks - failures}/${checks} checks passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
