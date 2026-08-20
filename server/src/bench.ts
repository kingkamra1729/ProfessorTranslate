/**
 * Times candidate models on a realistic generation, not a one-token ping.
 *
 *   npx tsx src/bench.ts
 *
 * The reasoning-path work - drafting a diagram spec, extracting a glossary -
 * generates hundreds to thousands of tokens. A model that answers "ping"
 * instantly can still take minutes to produce that, which is exactly the
 * failure this is here to measure rather than guess at.
 */
import { chat } from './providers/featherless.js';

const CANDIDATES = [
  'Qwen/Qwen3-30B-A3B-Instruct-2507',
  'Qwen/Qwen3-Next-80B-A3B-Instruct',
  'Qwen/Qwen3.5-27B',
  'Qwen/Qwen3-235B-A22B',
  'mistralai/Mistral-Large-Instruct-2411',
];

const PROMPT = [
  'Reply with ONE JSON object and nothing else:',
  '{ "visualise": boolean, "kind": string, "title": string, "expression": string,',
  '  "query": string, "altText": string, "reason": string }',
  '',
  '"expression" must be valid Wolfram Language that evaluates to a graphic.',
].join('\n');

const INPUT =
  'Show me a damped oscillation, e to the minus x over 4 times sine of 3x, from 0 to 20';

async function time(model: string) {
  const started = Date.now();
  try {
    const out = await chat(
      [
        { role: 'system', content: PROMPT },
        { role: 'user', content: INPUT },
      ],
      { model, maxTokens: 400, temperature: 0.1, timeoutMs: 120_000 },
    );
    const ms = Date.now() - started;
    const oneLine = out.replace(/\s+/g, ' ').slice(0, 110);
    console.log(`  ${String(ms).padStart(7)}ms  ${model}`);
    console.log(`            ${oneLine}`);
  } catch (err) {
    const ms = Date.now() - started;
    console.log(
      `  ${String(ms).padStart(7)}ms  ${model}  [FAILED] ${
        err instanceof Error ? err.message.slice(0, 90) : err
      }`,
    );
  }
}

async function main() {
  console.log('\nTiming a ~400 token structured generation\n');
  for (const model of CANDIDATES) {
    await time(model);
  }
  console.log('');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
