/**
 * Breaks down where the delay before a student sees a line actually goes.
 *
 *   npx tsx src/latency.test.ts [url]
 *
 * "It feels slow" is not actionable. The path from a spoken word to a
 * translated line on a phone has five stages and they are not equally
 * expensive, so this measures each one separately against a running server
 * rather than guessing which to optimise.
 */
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '@suvidha/shared';

const BASE = process.argv[2] ?? process.env.SUVIDHA_URL ?? 'http://localhost:8787';

const SENTENCES = [
  'So the eigenvalue of this matrix tells us how much the eigenvector gets stretched.',
  'Now let us look at what happens when the determinant is zero.',
  'The rank of a matrix is the number of linearly independent columns.',
  'We can find the null space by solving the homogeneous system.',
  'This is why diagonalization makes repeated multiplication cheap.',
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))];
}

function stats(label: string, xs: number[]) {
  if (xs.length === 0) {
    console.log(`  ${label.padEnd(34)} (no samples)`);
    return;
  }
  const mean = Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  console.log(
    `  ${label.padEnd(34)} median ${String(pct(xs, 50)).padStart(5)}ms   mean ${String(mean).padStart(5)}ms   p90 ${String(pct(xs, 90)).padStart(5)}ms`,
  );
}

async function main() {
  console.log(`\nMeasuring against ${BASE}\n`);

  const created = (await (
    await fetch(`${BASE}/api/lectures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Latency probe',
        course: 'PROBE',
        instructionLang: 'en',
        packIds: ['linear-algebra'],
        extraTerms: [],
      }),
    })
  ).json()) as { lecture: { id: string } };

  const code = created.lecture.id;
  const wsUrl = `${BASE.replace(/^http/, 'ws')}/ws`;

  const prof = new WebSocket(wsUrl);
  await new Promise<void>((r, j) => {
    prof.once('open', () => r());
    prof.once('error', j);
  });

  const student = new WebSocket(wsUrl);
  await new Promise<void>((r, j) => {
    student.once('open', () => r());
    student.once('error', j);
  });

  // Round-trip time for a trivial message, to separate network from model.
  const pings: number[] = [];
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await new Promise<void>((resolve) => {
      const onMsg = (raw: WebSocket.RawData) => {
        const m = JSON.parse(String(raw)) as ServerMessage;
        if (m.type === 'pong') {
          prof.off('message', onMsg);
          resolve();
        }
      };
      prof.on('message', onMsg);
      prof.send(JSON.stringify({ type: 'ping' } satisfies ClientMessage));
    });
    pings.push(Date.now() - t0);
    await wait(120);
  }

  const send = (ws: WebSocket, m: ClientMessage) => ws.send(JSON.stringify(m));
  send(prof, { type: 'prof:join', lectureId: code });
  send(student, { type: 'student:join', lectureId: code, lang: 'hi' });
  await wait(500);

  const toEcho: number[] = [];      // spoken -> caption on the student's screen
  const toFirstWord: number[] = []; // spoken -> first translated word visible
  const toTranslation: number[] = []; // spoken -> translated line
  const serverSide: number[] = [];    // what the server itself measured

  for (const sentence of SENTENCES) {
    let echoed = false;
    let firstPartial = false;
    const spokenAt = Date.now();

    const done = new Promise<void>((resolve) => {
      const onMsg = (raw: WebSocket.RawData) => {
        const m = JSON.parse(String(raw)) as ServerMessage;
        if (m.type === 'utterance' && m.utterance.final && !echoed) {
          echoed = true;
          toEcho.push(Date.now() - spokenAt);
        }
        if (m.type === 'translation-partial' && !firstPartial) {
          firstPartial = true;
          toFirstWord.push(Date.now() - spokenAt);
        }
        if (m.type === 'translation') {
          toTranslation.push(Date.now() - spokenAt);
          serverSide.push(m.translation.latencyMs);
          student.off('message', onMsg);
          resolve();
        }
      };
      student.on('message', onMsg);
    });

    send(prof, { type: 'prof:utterance', text: sentence, final: true, t: 0 });
    await done;
    await wait(400);
  }

  console.log('  stage breakdown\n');
  stats('websocket round trip (ping)', pings);
  stats('spoken -> caption appears', toEcho);
  stats('spoken -> FIRST TRANSLATED WORD', toFirstWord);
  stats('spoken -> translated line complete', toTranslation);
  stats('  of which: model + pipeline', serverSide);

  const transport = pct(toTranslation, 50) - pct(serverSide, 50);
  console.log('');
  console.log(`  transport + queueing overhead: ~${transport}ms`);
  console.log(`  the caption appears ${pct(toTranslation, 50) - pct(toEcho, 50)}ms before the translation`);
  console.log('');

  send(prof, { type: 'prof:end' });
  await wait(800);
  prof.close();
  student.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('latency probe failed:', err);
  process.exit(1);
});
