/**
 * Drives a continuous lecture and watches for the failures a short probe hides.
 *
 *   npx tsx src/sustained.test.ts [url] [--pace 1.0] [--langs hi,fr]
 *
 * Single-sentence measurements say the pipeline is fast. Reports from a real
 * lecture say it lags, repeats, and skips lines. Both can be true: a per-
 * sentence cost slightly above the rate speech arrives looks fine once and
 * compounds without limit over forty minutes.
 *
 * So this speaks at a realistic pace, without waiting for each translation, and
 * measures what only shows up under sustained load:
 *
 *   - whether lag GROWS, which is the difference between slow and falling behind
 *   - whether any spoken line never comes back at all
 *   - how many times each line is redrawn before it settles
 */
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '@suvidha/shared';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const positional = process.argv[2];
const BASE =
  positional && !positional.startsWith('--')
    ? positional
    : (process.env.SUVIDHA_URL ?? 'http://localhost:8787');
const PACE = Number(arg('pace', '1')) || 1;
const LANGS = arg('langs', 'hi').split(',').filter(Boolean) as Array<'hi' | 'bn' | 'fr' | 'en'>;
/**
 * How speech is chunked.
 *
 * 'sentences' sends one tidy final per sentence, which is what a test writes
 * and not what a microphone produces. 'fragments' breaks each sentence at
 * pauses, with no trailing punctuation - which is what Chrome actually delivers
 * when someone thinks mid-sentence.
 */
const STYLE = arg('style', 'sentences');

/** A continuous stretch of lecture, the way one is actually delivered. */
const LECTURE = [
  'Right, so today we are going to talk about simple harmonic motion.',
  'Think about a mass hanging on a spring, just sitting there at rest.',
  'Now you pull it down a little bit and you let it go.',
  'What happens is the spring pulls it back towards the middle.',
  'That pull is what we call the restoring force.',
  'And the important thing is that the further you stretch it, the harder it pulls back.',
  'That single fact is what makes the motion a sine wave.',
  'The amplitude tells us how far the mass travels from the centre.',
  'The frequency tells us how many times it goes back and forth each second.',
  'Now in the real world this does not continue forever.',
  'Air resistance takes energy out of the system, and we call that damping.',
  'With damping the amplitude gets smaller on every swing until the mass stops.',
  'But something interesting happens if we push the system at just the right rate.',
  'If we match the natural frequency, the amplitude grows enormously.',
  'That is resonance, and it is why soldiers break step crossing a bridge.',
  'Let us look at the equation that describes all of this.',
  'We have a second order differential equation relating acceleration to displacement.',
  'The solution is a sine wave whose frequency depends on the spring constant and the mass.',
];

/**
 * How long a sentence takes to say.
 *
 * Around 140 words a minute, with a longer gap after a full stop. Speaking is
 * not paced by how fast the translator can keep up, which is exactly the point.
 */
function speakingTime(line: string): number {
  const words = line.split(/\s+/).length;
  return (((words / 140) * 60_000 + 600) * (0.9 + Math.random() * 0.2)) / PACE;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(): Promise<WebSocket> {
  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`);
  await new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  return ws;
}

function pct(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))];
}

async function main() {
  console.log(`\n${BASE}  ·  ${LECTURE.length} sentences  ·  pace ${PACE}x  ·  ${LANGS.join(', ')}\n`);

  const created = (await (
    await fetch(`${BASE}/api/lectures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Sustained load',
        course: 'LOAD',
        instructionLang: 'en',
        packIds: ['physics-mechanics', 'calculus'],
        extraTerms: [],
      }),
    })
  ).json()) as { lecture: { id: string } };

  const prof = await connect();
  prof.on('message', (raw) => {
    try {
      const m = JSON.parse(String(raw)) as ServerMessage;
      if (m.type === 'viz') vizProposals++;
      if (m.type === 'term-suggestions') termSuggestions += m.suggestions.length;
    } catch {
      /* ignore */
    }
  });
  const send = (ws: WebSocket, m: ClientMessage) => ws.send(JSON.stringify(m));
  send(prof, { type: 'prof:join', lectureId: created.lecture.id });

  // One student per language, as in a real room.
  const students = new Map<string, WebSocket>();
  const spokenAt = new Map<string, number>();
  const finalUtterances: Array<{ id: string; text: string; t: number }> = [];
  const translatedAt = new Map<string, number>();
  const partialCounts = new Map<string, number>();
  const lagByIndex: number[] = [];
  let vizProposals = 0;
  let termSuggestions = 0;

  for (const lang of LANGS) {
    const ws = await connect();
    ws.on('message', (raw) => {
      let m: ServerMessage;
      try {
        m = JSON.parse(String(raw)) as ServerMessage;
      } catch {
        return;
      }
      if (m.type === 'utterance' && m.utterance.final) {
        if (!finalUtterances.some((u) => u.id === m.utterance.id)) {
          // `t` is when the professor said it, in lecture time. Comparing
          // against that survives the server splitting one recognition result
          // into several utterances, which text matching did not.
          finalUtterances.push({ id: m.utterance.id, text: m.utterance.text, t: m.utterance.t });
        }
      }
      if (m.type === 'translation-partial') {
        partialCounts.set(m.utteranceId, (partialCounts.get(m.utteranceId) ?? 0) + 1);
      }
      if (m.type === 'translation' && !translatedAt.has(m.translation.utteranceId)) {
        translatedAt.set(m.translation.utteranceId, Date.now());
      }
    });
    send(ws, { type: 'student:join', lectureId: created.lecture.id, lang });
    students.set(lang, ws);
  }

  await wait(700);

  // Speak without waiting for anything. This is the whole point: a lecturer
  // does not pause for the translator.
  const started = Date.now();
  for (const [i, line] of LECTURE.entries()) {
    process.stdout.write(`  ${String(i + 1).padStart(2)}/${LECTURE.length}\r`);

    if (STYLE === 'fragments') {
      // Recognition does not hand over tidy sentences. It hands over whatever
      // was said before the speaker paused to think, with no trailing
      // punctuation - so one sentence arrives as three or four pieces, each of
      // which the pipeline must decide whether to translate now or hold.
      const words = line.replace(/[.,]/g, '').split(' ');
      const pieces: string[] = [];
      let at = 0;
      while (at < words.length) {
        const take = 3 + Math.floor(Math.random() * 4);
        pieces.push(words.slice(at, at + take).join(' '));
        at += take;
      }

      // Time is spent saying the words, not pausing between them. A
      // mid-sentence hesitation is a few hundred milliseconds; treating it as
      // two seconds would make any buffering strategy look broken.
      const speaking = speakingTime(line);
      const gaps = pieces.length - 1;
      const hesitation = 250 + Math.random() * 350;
      const perPiece = Math.max(120, (speaking - gaps * hesitation) / pieces.length);

      for (const [pi, piece] of pieces.entries()) {
        const now = Date.now();
        spokenAt.set(piece, now);
        send(prof, { type: 'prof:utterance', text: piece, final: true, t: now - started });
        await wait(perPiece + (pi < gaps ? hesitation : 0));
      }

      // The pause the voice detector hears at the end of a sentence. Without
      // this the server has no way to distinguish "finished" from
      // "mid-thought", so omitting it would measure the pipeline with its
      // primary boundary signal disconnected.
      send(prof, { type: 'prof:pause', t: Date.now() - started });
    } else {
      const at = Date.now();
      spokenAt.set(line, at);
      send(prof, { type: 'prof:utterance', text: line, final: true, t: at - started });
      await wait(speakingTime(line));
    }
  }

  const spokenFor = Date.now() - started;
  console.log(`  spoke for ${(spokenFor / 1000).toFixed(1)}s; waiting up to 60s for the tail…`);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && translatedAt.size < finalUtterances.length) await wait(250);
  const settledAt = Date.now();

  /* ---- did every line come back? ------------------------------------ */
  console.log('\n  delivery');
  console.log(`    sentences spoken:            ${LECTURE.length}`);
  console.log(`    utterances the server made:  ${finalUtterances.length}`);
  console.log(`    translations received:       ${translatedAt.size}`);

  const missing = finalUtterances.filter((u) => !translatedAt.has(u.id));
  if (missing.length) {
    console.log(`    NEVER TRANSLATED:            ${missing.length}`);
    for (const m of missing.slice(0, 5)) console.log(`      - ${m.text.slice(0, 64)}`);
  } else {
    console.log('    every utterance was translated');
  }

  // Content integrity, at word level.
  //
  // Comparing sentences is the wrong unit: the server deliberately re-cuts
  // speech into its own chunks, so a sentence not appearing verbatim proves
  // nothing. What must not happen is a word going in and never coming out.
  const wordsIn = LECTURE.join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const wordsOut = finalUtterances
    .map((u) => u.text)
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  const outCounts = new Map<string, number>();
  for (const w of wordsOut) outCounts.set(w, (outCounts.get(w) ?? 0) + 1);

  const lost: string[] = [];
  for (const w of wordsIn) {
    const n = outCounts.get(w) ?? 0;
    if (n <= 0) lost.push(w);
    else outCounts.set(w, n - 1);
  }

  console.log(`    words spoken:                ${wordsIn.length}`);
  console.log(`    words echoed back:           ${wordsOut.length}`);
  if (lost.length) {
    console.log(`    WORDS LOST:                  ${lost.length} (${((lost.length / wordsIn.length) * 100).toFixed(1)}%)`);
    console.log(`      e.g. ${lost.slice(0, 14).join(' ')}`);
  } else {
    console.log('    no words lost');
  }

  /* ---- is lag growing? ----------------------------------------------- */
  console.log('\n  lag, in order spoken');
  for (const u of finalUtterances) {
    const arrived = translatedAt.get(u.id);
    if (!arrived) continue;
    lagByIndex.push(arrived - (started + u.t));
  }

  const firstThird = lagByIndex.slice(0, Math.ceil(lagByIndex.length / 3));
  const lastThird = lagByIndex.slice(-Math.ceil(lagByIndex.length / 3));
  const fmt = (xs: number[]) => `${(pct(xs, 50) / 1000).toFixed(2)}s median, ${(pct(xs, 90) / 1000).toFixed(2)}s p90`;

  console.log(`    first third:  ${fmt(firstThird)}`);
  console.log(`    last third:   ${fmt(lastThird)}`);
  const drift = pct(lastThird, 50) - pct(firstThird, 50);
  console.log(
    `    drift:        ${drift >= 0 ? '+' : ''}${(drift / 1000).toFixed(2)}s  ` +
      (drift > 1500 ? '<-- FALLING BEHIND' : 'stable'),
  );
  console.log(`    tail after last word: ${((settledAt - started - spokenFor) / 1000).toFixed(1)}s`);

  /* ---- how much redrawing? ------------------------------------------- */
  // Both of these run on background timers and stand down when the request
  // budget is busy, so a lecture is exactly the condition under which they can
  // silently never run at all.
  console.log('\n  background features');
  console.log(`    diagram proposals:  ${vizProposals}`);
  console.log(`    term suggestions:   ${termSuggestions}`);

  const counts = [...partialCounts.values()];
  const total = counts.reduce((a, b) => a + b, 0);
  console.log('\n  subtitle redraws');
  console.log(`    partial messages:  ${total}`);
  console.log(`    per line:          ${counts.length ? (total / counts.length).toFixed(1) : 0} average, ${Math.max(0, ...counts)} worst`);

  send(prof, { type: 'prof:end' });
  await wait(800);
  prof.close();
  for (const ws of students.values()) ws.close();
  console.log('');
  process.exit(0);
}

main().catch((err) => {
  console.error('sustained probe failed:', err);
  process.exit(1);
});
