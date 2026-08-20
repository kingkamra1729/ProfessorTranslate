/**
 * Measures how reliably terms survive translation.
 *
 *   npx tsx src/reliability.test.ts [runs]
 *
 * Everything else in this project is deterministic and can be asserted once.
 * This cannot: term preservation depends on a language model copying sentinel
 * tokens through a sentence it is rewriting, and models occasionally drop one.
 * A single passing test says nothing useful about a property that fails one
 * time in twenty - and one time in twenty, across a forty-minute lecture, is
 * several mistranslated terms per class.
 *
 * So this runs the same translations repeatedly and reports the rate.
 */
import { buildMatcher } from './pipeline/glossary.js';
import { translateUtterance } from './pipeline/translate.js';
import { clearTranslationCache } from './pipeline/translate.js';
import { mergePacks } from './data/glossary-packs.js';
import type { LangCode } from '@suvidha/shared';

const RUNS = Number(process.argv[2]) || 12;

const CASES: Array<{ text: string; expect: string[]; packs: string[] }> = [
  {
    text: 'So the eigenvalue of this matrix tells us how much the eigenvector gets stretched.',
    expect: ['eigenvalue', 'matrix', 'eigenvector'],
    packs: ['linear-algebra'],
  },
  {
    text: 'We take the partial derivative and then apply the chain rule to the Jacobian.',
    expect: ['partial derivative', 'chain rule', 'Jacobian'],
    packs: ['calculus'],
  },
  {
    text: 'The time complexity of breadth first search on this graph is linear.',
    expect: ['time complexity', 'breadth first search', 'graph'],
    packs: ['cs-algorithms'],
  },
];

const LANGS: LangCode[] = ['hi', 'bn', 'fr'];

interface Tally {
  attempts: number;
  intact: number;
  repaired: number;
  lost: number;
  latencies: number[];
}

function blank(): Tally {
  return { attempts: 0, intact: 0, repaired: 0, lost: 0, latencies: [] };
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function main() {
  console.log(`\nTerm preservation over ${RUNS} runs x ${CASES.length} sentences x ${LANGS.length} languages`);
  console.log(`(${RUNS * CASES.length * LANGS.length} translations)\n`);

  const byLang = new Map<LangCode, Tally>(LANGS.map((l) => [l, blank()]));
  const failures: string[] = [];

  for (let run = 0; run < RUNS; run++) {
    // The cache would make every run after the first a no-op, which would
    // measure the cache rather than the model.
    clearTranslationCache();

    for (const testCase of CASES) {
      const matcher = buildMatcher(mergePacks(testCase.packs));

      await Promise.all(
        LANGS.map(async (to) => {
          const tally = byLang.get(to)!;
          const started = Date.now();

          const tr = await translateUtterance({
            utteranceId: `rel-${run}`,
            text: testCase.text,
            from: 'en',
            to,
            matcher,
          });

          tally.attempts++;
          tally.latencies.push(Date.now() - started);

          if (tr.engine === 'fallback') {
            tally.lost++;
            failures.push(`${to}: fell back to passthrough`);
            return;
          }

          const termRuns = tr.runs.filter((r) => r.isTerm).map((r) => r.text.trim());
          const allPresent = testCase.expect.every((t) =>
            termRuns.some((r) => r === t || r.includes(t)),
          );

          if (!allPresent) {
            tally.lost++;
            failures.push(
              `${to}: expected [${testCase.expect.join(', ')}] got [${termRuns.join(', ')}]\n      ${tr.text}`,
            );
            return;
          }

          // Present, but the repair path had to splice terms onto the end -
          // correct content, awkward sentence.
          const repaired = /\([^)]*\)\s*$/.test(tr.text) && termRuns.length > 0 &&
            tr.runs[tr.runs.length - 1]?.isTerm === true &&
            tr.runs.filter((r) => r.isTerm).length > testCase.expect.length - 1 &&
            tr.text.trimEnd().endsWith(')');

          if (repaired) tally.repaired++;
          else tally.intact++;
        }),
      );
    }
    process.stdout.write('.');
  }

  console.log('\n');
  console.log('  lang   attempts   intact   repaired   lost    median latency');
  console.log('  ' + '─'.repeat(62));

  let totalAttempts = 0;
  let totalLost = 0;

  for (const lang of LANGS) {
    const t = byLang.get(lang)!;
    totalAttempts += t.attempts;
    totalLost += t.lost;
    console.log(
      `  ${lang.padEnd(6)} ${String(t.attempts).padStart(8)}   ${pct(t.intact, t.attempts).padStart(6)}   ${pct(t.repaired, t.attempts).padStart(8)}   ${pct(t.lost, t.attempts).padStart(5)}   ${String(median(t.latencies)).padStart(6)}ms`,
    );
  }

  console.log('  ' + '─'.repeat(62));
  console.log(`  overall term-loss rate: ${pct(totalLost, totalAttempts)}\n`);

  if (failures.length > 0) {
    console.log(`  ${failures.length} failure(s), first few:`);
    for (const f of failures.slice(0, 5)) console.log(`    - ${f}`);
    console.log('');
  }

  // A loss rate above a few percent means several mistranslated terms per
  // lecture, which is the thing this product exists to prevent.
  const rate = totalAttempts === 0 ? 1 : totalLost / totalAttempts;
  console.log(rate <= 0.03 ? '  PASS (loss <= 3%)\n' : '  FAIL (loss > 3%)\n');
  process.exit(rate <= 0.03 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
