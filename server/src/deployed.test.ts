/**
 * Confirms the server-side behaviour of recent fixes on a live deployment.
 *
 *   npx tsx src/deployed.test.ts https://your-app.onrender.com
 *
 * A matching bundle hash proves the frontend is current, but the server runs
 * from source and its fixes are invisible from outside unless exercised. This
 * asks the deployment to demonstrate each one.
 */
import WebSocket from 'ws';
import type { ClientMessage, ServerMessage } from '@suvidha/shared';

const BASE = process.argv[2] ?? process.env.SUVIDHA_URL ?? 'http://localhost:8787';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log('       ', JSON.stringify(detail).slice(0, 300));
  }
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

async function main() {
  console.log(`\nverifying ${BASE}\n`);

  const created = (await (
    await fetch(`${BASE}/api/lectures`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Deployment check',
        course: 'CHECK',
        instructionLang: 'en',
        packIds: ['linear-algebra'],
        extraTerms: [],
      }),
    })
  ).json()) as { lecture: { id: string } };
  const code = created.lecture.id;

  const prof = await connect();
  const student = await connect();
  const seen: ServerMessage[] = [];
  student.on('message', (raw) => {
    try {
      seen.push(JSON.parse(String(raw)) as ServerMessage);
    } catch {
      /* ignore */
    }
  });

  const send = (ws: WebSocket, m: ClientMessage) => ws.send(JSON.stringify(m));
  send(prof, { type: 'prof:join', lectureId: code });
  send(student, { type: 'student:join', lectureId: code, lang: 'hi' });
  await wait(600);

  /* ---- streaming partials -------------------------------------------- */
  console.log('streaming');
  const line = 'The eigenvalue of this matrix is exactly two.';
  send(prof, { type: 'prof:utterance', text: line, final: true, t: 0 });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !seen.some((m) => m.type === 'translation')) await wait(100);

  const partials = seen.filter((m) => m.type === 'translation-partial');
  check('subtitle text streams before the line is complete', partials.length > 0, partials.length);
  if (partials.length > 1) {
    const first = partials[0];
    const last = partials[partials.length - 1];
    check(
      'partials grow as the translation generates',
      first.type === 'translation-partial' &&
        last.type === 'translation-partial' &&
        last.text.length > first.text.length,
      { first: first.type === 'translation-partial' ? first.text : '', count: partials.length },
    );
  }

  /* ---- duplicate speech ---------------------------------------------- */
  console.log('\nduplicate speech guard');
  const before = seen.filter((m) => m.type === 'utterance' && m.utterance.final).length;
  const repeated = 'Now consider the determinant of that same matrix.';
  send(prof, { type: 'prof:utterance', text: repeated, final: true, t: 1 });
  await wait(400);
  send(prof, { type: 'prof:utterance', text: repeated, final: true, t: 2 });
  await wait(2500);

  const after = seen.filter((m) => m.type === 'utterance' && m.utterance.final).length;
  check('the same sentence sent twice produces one utterance', after - before === 1, {
    before,
    after,
  });

  /* ---- file upload ---------------------------------------------------- */
  console.log('\ncourse file upload');
  const notes = Buffer.from(
    'Lecture notes. The restoring force obeys Hooke law. Damping reduces the amplitude ' +
      'of simple harmonic motion, and at resonance the driven amplitude peaks.',
    'utf8',
  ).toString('base64');

  const upload = (await (
    await fetch(`${BASE}/api/glossary/build`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject: 'Physics', file: { name: 'notes.md', base64: notes } }),
    })
  ).json()) as { terms?: Array<{ term: string }>; info?: { sourceKind: string }; error?: string };

  check('upload endpoint accepts a file', !upload.error, upload.error);
  check('terms extracted from the uploaded file', (upload.terms?.length ?? 0) >= 4, upload.terms?.length);
  check('reported as a file source', upload.info?.sourceKind === 'file', upload.info);
  if (upload.terms?.length) {
    console.log(`       ${upload.terms.slice(0, 6).map((t) => t.term).join(', ')}`);
  }

  /* ---- stale room retirement ------------------------------------------ */
  console.log('\nabandoned lectures');
  const live = (await (await fetch(`${BASE}/api/lectures`)).json()) as Array<{ id: string }>;
  check('this lecture is listed while a professor is connected',
    live.some((l) => l.id === code), live.map((l) => l.id));

  send(prof, { type: 'prof:end' });
  await wait(1500);

  const after2 = (await (await fetch(`${BASE}/api/lectures`)).json()) as Array<{ id: string }>;
  check('an ended lecture leaves the live list', !after2.some((l) => l.id === code),
    after2.map((l) => l.id));

  prof.close();
  student.close();
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('deployment check crashed:', err);
  process.exit(1);
});
