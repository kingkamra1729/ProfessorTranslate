/**
 * Finds what actually drives translation latency.
 *
 *   npx tsx src/latency-lab.ts
 *
 * The measured bottleneck is not generation speed but time-to-first-token, and
 * that scales with how much prompt the model has to read before it can start.
 * The live system prompt is several hundred tokens of rules and a worked
 * example, paid on every single sentence of every lecture.
 *
 * This compares prompt lengths and models on the same sentences so the choice
 * is made from numbers rather than intuition.
 */
import { config } from './config.js';

const KEY = config.featherless.apiKey;

const SENTENCES = [
  'So the ⟦0⟧ of this ⟦1⟧ tells us how much the ⟦2⟧ gets stretched.',
  'Now let us look at what happens when the ⟦0⟧ is zero.',
  'The ⟦0⟧ of a ⟦1⟧ is the number of linearly independent columns.',
];

/** The prompt the app ships today, reproduced for measurement. */
const LONG = [
  'You are a live interpreter in a university lecture hall. You render the professor\'s English speech into Hindi (हिन्दी) in real time, for students who are following the lecture through an earpiece.',
  '',
  'RULES',
  '',
  '1. Output ONLY the Hindi translation. No preamble, no quotation marks, no notes, no romanisation, no alternatives in brackets.',
  '',
  '2. The input contains placeholders that look like ⟦0⟧, ⟦1⟧, ⟦2⟧. Each stands for a technical term that MUST NOT be translated. Copy every placeholder into your output exactly as written, with the same digit. Never translate one, never delete one, never renumber one, never add one that was not in the input. Place each placeholder wherever Hindi grammar requires it - the word order of your sentence should be natural Hindi, not a copy of the English order.',
  '',
  '3. Translate the explanation only. Do NOT add definitions, examples, clarifications or context that the professor did not say. If the professor\'s sentence is incomplete or trails off, translate the incomplete sentence. You are interpreting, not teaching.',
  '',
  '4. Use spoken lecture register: the natural, clear Hindi a teacher would actually say aloud to a class. Not formal written prose, not literary vocabulary.',
  '',
  '5. Keep the translation close to the length of the original. This is spoken live and a long rendering will run past the professor\'s next sentence.',
  '',
  '6. Numbers, symbols, variable names and units stay as they are.',
  '',
  'EXAMPLE',
  'Input:  So the ⟦0⟧ of this ⟦1⟧ tells us how much the ⟦2⟧ gets stretched.',
  'Output: तो इस ⟦1⟧ का ⟦0⟧ हमें बताता है कि ⟦2⟧ कितना खिंचता है।',
].join('\n');

/** A compressed prompt carrying the same constraints. */
const SHORT = [
  'Interpret English lecture speech into spoken Hindi. Output only the Hindi.',
  '⟦0⟧ ⟦1⟧ are technical terms: copy each exactly, same digits, placed where Hindi grammar wants it.',
  'Translate only what was said - add nothing. Keep it short and natural, as spoken to a class.',
  'Example: So the ⟦0⟧ of this ⟦1⟧ stretches the ⟦2⟧. → तो इस ⟦1⟧ का ⟦0⟧ ⟦2⟧ को खींचता है।',
].join('\n');

interface Result {
  ttft: number;
  total: number;
  text: string;
}

async function timed(model: string, system: string, user: string): Promise<Result | null> {
  const t0 = Date.now();
  let ttft = -1;
  let text = '';

  try {
    const res = await fetch(`${config.featherless.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: 0.2,
        max_tokens: 200,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok || !res.body) return null;

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const d = j.choices?.[0]?.delta?.content;
          if (d) {
            if (ttft < 0) ttft = Date.now() - t0;
            text += d;
          }
        } catch {
          /* keep-alive line */
        }
      }
    }
    return { ttft: ttft < 0 ? Date.now() - t0 : ttft, total: Date.now() - t0, text: text.trim() };
  } catch {
    return null;
  }
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** True when all placeholders present in the input survived into the output. */
function intact(input: string, output: string): boolean {
  const wanted = [...input.matchAll(/⟦(\d+)⟧/g)].map((m) => m[1]);
  return wanted.every((d) => output.includes(`⟦${d}⟧`));
}

async function trial(label: string, model: string, system: string) {
  const ttfts: number[] = [];
  const totals: number[] = [];
  let kept = 0;

  for (const sentence of SENTENCES) {
    const r = await timed(model, system, sentence);
    if (!r) {
      console.log(`  ${label.padEnd(38)} FAILED`);
      return;
    }
    ttfts.push(r.ttft);
    totals.push(r.total);
    if (intact(sentence, r.text)) kept++;
  }

  console.log(
    `  ${label.padEnd(38)} ttft ${String(median(ttfts)).padStart(5)}ms   total ${String(median(totals)).padStart(5)}ms   terms kept ${kept}/${SENTENCES.length}`,
  );
}

async function main() {
  console.log(`\nprompt length: long=${LONG.length} chars, short=${SHORT.length} chars\n`);

  await trial('30B-A3B  long prompt (current)', 'Qwen/Qwen3-30B-A3B-Instruct-2507', LONG);
  await trial('30B-A3B  short prompt', 'Qwen/Qwen3-30B-A3B-Instruct-2507', SHORT);
  await trial('Qwen3.5-9B  short prompt', 'Qwen/Qwen3.5-9B', SHORT);
  await trial('Qwen3.5-4B  short prompt', 'Qwen/Qwen3.5-4B', SHORT);
  await trial('Qwen3.5-27B short prompt', 'Qwen/Qwen3.5-27B', SHORT);
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
