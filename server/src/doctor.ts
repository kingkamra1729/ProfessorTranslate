/**
 * Diagnostics.
 *
 *   npm run doctor
 *
 * Checks that each configured service actually works, rather than that a key is
 * merely present. A key that is set but rejected, or a model id that no longer
 * exists on the provider, both look identical to "configured" from the outside
 * and produce silent passthrough at exactly the wrong moment - which is the
 * failure this is here to catch before a demo rather than during one.
 *
 * Never prints key values.
 */
import { config, describeConfig } from './config.js';
import { chat, isConfigured, listModels } from './providers/featherless.js';
import { isWolframConfigured, render } from './providers/wolfram.js';
import { isFirecrawlConfigured } from './providers/firecrawl.js';
import { buildMatcher } from './pipeline/glossary.js';
import { translateUtterance } from './pipeline/translate.js';
import { mergePacks } from './data/glossary-packs.js';

const OK = '  [32m✓[0m';
const BAD = '  [31m✗[0m';
const SKIP = '  [90m·[0m';

let failures = 0;

function ok(msg: string, detail?: string) {
  console.log(`${OK} ${msg}${detail ? `\n      ${detail}` : ''}`);
}
function bad(msg: string, detail?: string) {
  failures++;
  console.log(`${BAD} ${msg}${detail ? `\n      [31m${detail}[0m` : ''}`);
}
function skip(msg: string, detail?: string) {
  console.log(`${SKIP} ${msg}${detail ? `\n      [90m${detail}[0m` : ''}`);
}

function mask(key: string): string {
  if (!key) return '(empty)';
  if (key.length <= 8) return `${key.length} chars`;
  return `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)`;
}

async function checkFeatherless() {
  console.log('\n[1mTranslation — Featherless[0m');

  if (!isConfigured()) {
    bad(
      'FEATHERLESS_API_KEY is not set',
      'Translation will run in passthrough: students see the original text.\n      ' +
        'Add it to .env at the repo root, then re-run this.',
    );
    return;
  }

  ok(`Key loaded: ${mask(config.featherless.apiKey)}`);

  // 1. Does the key authenticate at all?
  const models = await listModels();
  if (models.length === 0) {
    bad(
      'Could not list models',
      'The key may be invalid, out of credit, or the network is blocked.',
    );
    return;
  }
  ok(`Key authenticates — ${models.length} models visible`);

  // 2. Does the configured model actually exist on this account?
  for (const [label, model] of [
    ['live model', config.featherless.model],
    ['reasoning model', config.featherless.reasoningModel],
  ] as const) {
    if (models.includes(model)) {
      ok(`${label} available: ${model}`);
    } else {
      const near = models.filter((m) => m.split('/')[0] === model.split('/')[0]).slice(0, 3);
      bad(
        `${label} NOT on this account: ${model}`,
        near.length > 0
          ? `Try one of: ${near.join(', ')}`
          : 'Pick a model id from https://featherless.ai/models',
      );
    }
  }

  // 3. Does a plain completion round-trip?
  try {
    const reply = await chat(
      [
        { role: 'system', content: 'Reply with exactly one word: OK' },
        { role: 'user', content: 'ping' },
      ],
      { maxTokens: 16, timeoutMs: 30_000 },
    );
    ok('Completion round-trip works', `model replied: ${JSON.stringify(reply.slice(0, 40))}`);
  } catch (err) {
    bad('Completion failed', err instanceof Error ? err.message : String(err));
    return;
  }

  // 4. The one that actually matters: does a real translation preserve terms?
  console.log('\n[1mTerm preservation — the core promise[0m');

  const matcher = buildMatcher(mergePacks(['linear-algebra']));
  const source = 'So the eigenvalue of this matrix tells us how much the eigenvector is stretched.';

  for (const to of ['hi', 'bn', 'fr'] as const) {
    const started = Date.now();
    const tr = await translateUtterance({
      utteranceId: 'doctor',
      text: source,
      from: 'en',
      to,
      matcher,
    });
    const elapsed = Date.now() - started;

    if (tr.engine === 'fallback') {
      bad(`${to}: fell back to passthrough`, 'The model call failed; see the warning above.');
      continue;
    }

    const termRuns = tr.runs.filter((r) => r.isTerm).map((r) => r.text.trim());
    const expected = ['eigenvalue', 'matrix', 'eigenvector'];
    const preserved = expected.every((t) => termRuns.includes(t));
    const englishVoiced = tr.runs.filter((r) => r.isTerm).every((r) => r.lang === 'en');

    if (preserved && englishVoiced) {
      ok(
        `${to}: all 3 terms preserved and voiced in English (${elapsed}ms)`,
        tr.text,
      );
    } else {
      bad(
        `${to}: term preservation failed`,
        `expected ${expected.join(', ')} — got ${termRuns.join(', ') || '(none)'}\n      ${tr.text}`,
      );
    }
  }
}

async function checkWolfram() {
  console.log('\n[1mVisualisation — Wolfram[0m');

  if (!isWolframConfigured()) {
    skip(
      'No Wolfram credentials',
      'Diagrams are optional. Set WOLFRAM_APP_ID, or deploy scripts/wolfram-deploy.wl\n      ' +
        'and set WOLFRAM_CLOUD_API_URL for the better route.',
    );
    return;
  }

  if (config.wolfram.appId) ok(`App ID loaded: ${mask(config.wolfram.appId)}`);
  if (config.wolfram.cloudApiUrl) ok(`Cloud API: ${config.wolfram.cloudApiUrl}`);

  try {
    const result = await render('Plot[Sin[x]/x, {x, -20, 20}]', 'plot sin(x)/x from -20 to 20');
    const kb = Math.round((result.dataUri.length * 0.75) / 1024);
    ok(`Rendered a test plot via ${result.source}`, `${kb} kB image returned`);
  } catch (err) {
    bad('Wolfram render failed', err instanceof Error ? err.message : String(err));
  }
}

function checkFirecrawl() {
  console.log('\n[1mGlossary import — Firecrawl[0m');
  if (!isFirecrawlConfigured()) {
    skip(
      'No FIRECRAWL_API_KEY',
      'Optional. Without it, paste course text instead of giving a URL.',
    );
    return;
  }
  ok(`Key loaded: ${mask(config.firecrawl.apiKey)}`);
  skip('Not calling it — a scrape costs credits. It will be exercised on first use.');
}

function checkSpeech() {
  console.log('\n[1mSpeech[0m');
  skip(
    'Speech runs in the browser, not here',
    'Recognition needs Chrome or Edge. Voice availability per language is checked\n      ' +
      'in the student view at join time and reported on screen.',
  );
}

async function main() {
  console.log('\n[1mSuvidha diagnostics[0m');
  console.log('[90m' + '─'.repeat(60) + '[0m');

  for (const s of describeConfig()) {
    console.log(`  ${s.enabled ? '✓' : '·'} ${s.name.padEnd(18)} ${s.detail}`);
  }

  await checkFeatherless();
  await checkWolfram();
  checkFirecrawl();
  checkSpeech();

  console.log('[90m' + '─'.repeat(60) + '[0m');
  if (failures === 0) {
    console.log('[32m  Everything configured is working.[0m\n');
  } else {
    console.log(`[31m  ${failures} check(s) failed — see above.[0m\n`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\ndoctor crashed:', err);
  process.exit(1);
});
