/**
 * End-to-end check that missing-term suggestions reach a professor's socket.
 *
 *   npx tsx src/scout-e2e.test.ts
 *
 * The scout itself is covered by features.test.ts. This covers the wiring: the
 * timer, the gate deferral, the room state, and the WebSocket message - the
 * parts that a unit test of the prompt cannot reach.
 */
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '@suvidha/shared';

const BASE = process.env.SUVIDHA_URL ?? 'http://localhost:8787';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log('       ', JSON.stringify(detail).slice(0, 400));
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // A physics lecture with a calculus glossary: every physics term is exposed.
  const created = (await (
    await fetch(`${BASE}/api/lectures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Simple harmonic motion',
        course: 'PH102',
        instructionLang: 'en',
        packIds: ['calculus'],
        extraTerms: [],
      }),
    })
  ).json()) as { lecture: { id: string }; glossary: unknown[] };

  const code = created.lecture.id;
  console.log(`\nlecture ${code}, glossary has ${created.glossary.length} calculus terms`);
  console.log('speaking physics, which none of them cover\n');

  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`);
  const seen: ServerMessage[] = [];
  ws.on('message', (raw) => {
    try {
      seen.push(JSON.parse(String(raw)) as ServerMessage);
    } catch {
      /* ignore */
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
  send({ type: 'prof:join', lectureId: code });
  await wait(300);

  const lines = [
    'Today we are looking at simple harmonic motion, which shows up everywhere in physics.',
    'Imagine a mass hanging on a spring. You pull it down and let it go.',
    'The spring pulls it back towards the middle. That pull is the restoring force.',
    'The further you stretch it, the harder the spring pulls back.',
    'The amplitude tells us how far the mass travels from the centre.',
    'Air resistance takes energy out of the system, and we call this damping.',
    'If we match the natural frequency, the amplitude grows enormously. That is resonance.',
  ];
  for (const line of lines) {
    send({ type: 'prof:utterance', text: line, final: true, t: 0 });
    await wait(250);
  }

  // The scout runs on a 12-second timer and defers when the request budget is
  // busy, so allow a couple of cycles.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (seen.some((m) => m.type === 'term-suggestions')) break;
    await wait(1000);
  }

  const msg = seen.find((m) => m.type === 'term-suggestions');
  check('professor received term suggestions over the socket', Boolean(msg));

  if (msg?.type === 'term-suggestions') {
    const names = msg.suggestions.map((s) => s.term.toLowerCase());
    console.log(`       suggested: ${msg.suggestions.map((s) => s.term).join(', ')}`);

    check('suggested physics vocabulary the glossary lacked',
      names.some((n) => /harmonic|restoring|amplitude|damping|resonance|frequency/.test(n)), names);
    check('every suggestion carries the sentence it was heard in',
      msg.suggestions.every((s) => s.heardIn.length > 0), msg.suggestions.map((s) => s.heardIn));

    // Accepting must protect the term for the remainder of the lecture.
    send({ type: 'prof:accept-terms', terms: msg.suggestions });
    await wait(500);

    const glossaryUpdate = [...seen].reverse().find((m) => m.type === 'glossary');
    check('accepting updates the live glossary', Boolean(glossaryUpdate));

    if (glossaryUpdate?.type === 'glossary') {
      const nowKnown = glossaryUpdate.glossary.map((t) => t.term.toLowerCase());
      check('accepted terms are now in the glossary',
        names.every((n) => nowKnown.includes(n)),
        { accepted: names, glossaryHead: nowKnown.slice(0, 8) });
      check('the original pack terms survived the update',
        nowKnown.includes('derivative'), nowKnown.slice(0, 12));
    }
  }

  send({ type: 'prof:end' });
  await wait(800);
  ws.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('scout e2e crashed:', err);
  process.exit(1);
});
