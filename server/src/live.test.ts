/**
 * End-to-end check of the live path against a running server.
 *
 * Start the server, then:  npx tsx src/live.test.ts
 *
 * Verifies that speech entering the professor's socket comes back out of a
 * student's socket, segmented, term-protected and addressed to the language
 * that student actually chose.
 */
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '@suvidha/shared';

const BASE = process.env.SUVIDHA_URL ?? 'http://localhost:8787';
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log('       ', JSON.stringify(detail, null, 2).slice(0, 600));
  }
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function send(ws: WebSocket, msg: ClientMessage): void {
  ws.send(JSON.stringify(msg));
}

/** Collects every server message a socket receives, for later assertion. */
function collect(ws: WebSocket): ServerMessage[] {
  const seen: ServerMessage[] = [];
  ws.on('message', (raw) => {
    try {
      seen.push(JSON.parse(String(raw)) as ServerMessage);
    } catch {
      /* ignore */
    }
  });
  return seen;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits until a condition holds, or gives up.
 *
 * Fixed sleeps were fine when translation was a no-op, but a real model call
 * takes one to three seconds and two languages are dispatched concurrently, so
 * a hardcoded 2500ms turns this suite into a coin flip that fails on a slow
 * network and passes on a fast one. Polling makes the test wait exactly as long
 * as it needs to and no longer.
 */
async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 30_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(120);
  }
  console.log(`       (timed out after ${timeoutMs}ms waiting for: ${label})`);
  return false;
}

async function main() {
  console.log('\ncreating lecture');
  const createRes = await fetch(`${BASE}/api/lectures`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Eigenvalues and eigenvectors',
      course: 'MA201',
      instructor: 'Dr. Rao',
      instructionLang: 'en',
      packIds: ['linear-algebra', 'calculus'],
      extraTerms: ['Rayleigh quotient'],
    }),
  });
  const created = (await createRes.json()) as {
    lecture: { id: string };
    glossary: Array<{ term: string }>;
  };

  check('lecture created with a room code', /^[A-Z0-9]{6}$/.test(created.lecture.id), created.lecture);
  check('glossary merged from both packs', created.glossary.length >= 30, created.glossary.length);
  check(
    'manually added term is present and ranked first',
    created.glossary[0]?.term === 'Rayleigh quotient',
    created.glossary.slice(0, 3).map((t) => t.term),
  );

  const code = created.lecture.id;

  console.log('\njoining sockets');
  const prof = await connect();
  const profSeen = collect(prof);
  send(prof, { type: 'prof:join', lectureId: code });

  const hindi = await connect();
  const hindiSeen = collect(hindi);
  send(hindi, { type: 'student:join', lectureId: code, lang: 'hi' });

  const french = await connect();
  const frenchSeen = collect(french);
  send(french, { type: 'student:join', lectureId: code, lang: 'fr' });

  await wait(400);

  check('professor received a join confirmation', profSeen.some((m) => m.type === 'joined'), profSeen[0]);
  check('student received the glossary on join',
    hindiSeen.some((m) => m.type === 'joined' && m.glossary.length > 0));

  const counts = [...profSeen].reverse().find((m) => m.type === 'listeners');
  check('professor sees two listeners', counts?.type === 'listeners' && counts.total === 2, counts);
  check('listener counts are broken down by language',
    counts?.type === 'listeners' && counts.counts.hi === 1 && counts.counts.fr === 1, counts);

  console.log('\nspeaking');
  // Two sentences in one recognition result: the segmenter must split them.
  send(prof, {
    type: 'prof:utterance',
    final: true,
    t: 1000,
    text:
      'So the eigenvalue of this matrix tells us how much the eigenvector gets stretched. ' +
      'Now let us look at what happens when the determinant is zero.',
  });

  await waitFor(
    'both students to receive 2 translations each',
    () =>
      hindiSeen.filter((m) => m.type === 'translation').length >= 2 &&
      frenchSeen.filter((m) => m.type === 'translation').length >= 2,
  );

  const hindiUtterances = hindiSeen.filter((m) => m.type === 'utterance' && m.utterance.final);
  check('one recognition result became two utterances', hindiUtterances.length === 2,
    hindiUtterances.map((m) => (m.type === 'utterance' ? m.utterance.text : '')));

  const hindiTranslations = hindiSeen.filter((m) => m.type === 'translation');
  const frenchTranslations = frenchSeen.filter((m) => m.type === 'translation');

  check('Hindi student received translations', hindiTranslations.length === 2, hindiTranslations.length);
  check('French student received translations', frenchTranslations.length === 2, frenchTranslations.length);

  check('Hindi student received only Hindi',
    hindiTranslations.every((m) => m.type === 'translation' && m.translation.lang === 'hi'));
  check('French student received only French',
    frenchTranslations.every((m) => m.type === 'translation' && m.translation.lang === 'fr'));

  const first = hindiTranslations[0];
  if (first?.type === 'translation') {
    const tr = first.translation;
    const termRuns = tr.runs.filter((r) => r.isTerm);
    check('protected terms survive as runs', termRuns.length === 3, tr.runs);
    check('term runs are tagged for an English voice',
      termRuns.every((r) => r.lang === 'en'), termRuns);
    // Compared as a set, deliberately.
    //
    // The source order is eigenvalue, matrix, eigenvector - but Hindi puts the
    // possessor first, so a correct translation says "इस matrix का eigenvalue"
    // and the runs come back reordered. Runs follow the *translation's* word
    // order, which is the whole point: they drive which voice speaks which
    // span, and that has to match the sentence the student actually hears.
    // Asserting source order here would be asserting a bug.
    const expected = ['eigenvalue', 'matrix', 'eigenvector'];
    const got = termRuns.map((r) => r.text.trim());
    check('term runs carry the exact spoken surface forms, in translated order',
      got.length === expected.length && expected.every((t) => got.includes(t)),
      got);
    check('runs reconstruct the subtitle text exactly',
      tr.runs.map((r) => r.text).join('') === tr.text, { runs: tr.runs, text: tr.text });
    check('latency is reported', typeof tr.latencyMs === 'number', tr.latencyMs);
    console.log(`       engine=${tr.engine} latency=${tr.latencyMs}ms`);
    console.log(`       text: ${tr.text}`);
  } else {
    check('a Hindi translation arrived', false, hindiSeen);
  }

  console.log('\nswitching language mid-lecture');
  send(french, { type: 'student:set-lang', lang: 'bn' });
  await wait(300);
  frenchSeen.length = 0;

  send(prof, { type: 'prof:utterance', final: true, t: 5000, text: 'The rank of the matrix is two.' });
  await waitFor(
    'the switched student to receive a translation',
    () => frenchSeen.filter((m) => m.type === 'translation').length > 0,
  );

  const afterSwitch = frenchSeen.filter((m) => m.type === 'translation');
  check('student now receives the newly chosen language',
    afterSwitch.length > 0 && afterSwitch.every((m) => m.type === 'translation' && m.translation.lang === 'bn'),
    afterSwitch.map((m) => (m.type === 'translation' ? m.translation.lang : '')));

  console.log('\nending lecture');
  send(prof, { type: 'prof:end' });
  await waitFor(
    'the lecture-ended broadcast',
    () => hindiSeen.some((m) => m.type === 'lecture-ended'),
    15_000,
  );
  // The archive is written after in-flight translations settle.
  await wait(600);

  check('students were told the lecture ended', hindiSeen.some((m) => m.type === 'lecture-ended'));

  const recRes = await fetch(`${BASE}/api/recordings/${code}`);
  check('recording was archived', recRes.ok, recRes.status);
  if (recRes.ok) {
    const rec = (await recRes.json()) as {
      utterances: unknown[];
      translations: Record<string, unknown[]>;
      glossary: unknown[];
    };
    check('archive holds the transcript', rec.utterances.length === 3, rec.utterances.length);
    check('archive holds translations', Object.keys(rec.translations).length === 3,
      Object.keys(rec.translations).length);
    check('archive holds the glossary that was active', rec.glossary.length >= 30, rec.glossary.length);
  }

  prof.close();
  hindi.close();
  french.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nlive test crashed:', err);
  process.exit(1);
});
