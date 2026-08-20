/**
 * Lecture simulator.
 *
 * Plays a scripted lecture into a room as though a professor were speaking it,
 * at realistic speaking pace.
 *
 * This exists for three reasons, in ascending order of importance:
 *   - It lets the student UI be developed without anyone talking into a laptop.
 *   - It makes the demo reproducible, so the same sentences land the same way
 *     every run.
 *   - It means a flaky hall microphone, or a room too loud for recognition,
 *     cannot take the demo down.
 *
 * Usage:
 *   npx tsx src/simulate.ts <CODE> [--pace 1.0] [--script linear-algebra]
 *   npx tsx src/simulate.ts --new          (creates a room and prints the code)
 */
import WebSocket from 'ws';
import type { ClientMessage } from '@suvidha/shared';

const BASE = process.env.SUVIDHA_URL ?? 'http://localhost:8787';

interface Script {
  id: string;
  title: string;
  course: string;
  packIds: string[];
  extraTerms: string[];
  lines: string[];
}

const SCRIPTS: Script[] = [
  {
    id: 'linear-algebra',
    title: 'Eigenvalues and eigenvectors',
    course: 'MA201',
    packIds: ['linear-algebra', 'calculus'],
    extraTerms: ['Rayleigh quotient'],
    lines: [
      'Good morning everyone, today we are going to talk about eigenvalues and eigenvectors.',
      'Now, a matrix is really just a machine that takes a vector and moves it somewhere else.',
      'Most of the time the vector gets rotated and stretched at the same time.',
      'But for some special vectors, something much simpler happens.',
      'The matrix does not rotate them at all. It only stretches or shrinks them.',
      'Those special vectors are what we call the eigenvector of the matrix.',
      'And the amount by which each one is stretched is the eigenvalue.',
      'So if the eigenvalue is two, the eigenvector becomes twice as long, pointing the same way.',
      'If the eigenvalue is negative, the vector flips around and points backwards.',
      'Now let us look at how we actually find them.',
      'We need the determinant of A minus lambda times the identity matrix to be zero.',
      'This gives us a polynomial, and its roots are exactly the eigenvalues we are looking for.',
      'Once we have an eigenvalue, we substitute it back to find the null space.',
      'Any vector in that null space is an eigenvector for that eigenvalue.',
      'Notice that this only works when the matrix is square. Think about why that must be true.',
      'In the next class we will use this to do diagonalization, which makes everything much easier.',
    ],
  },
  {
    id: 'physics',
    title: 'Simple harmonic motion',
    course: 'PH102',
    packIds: ['physics-mechanics', 'calculus'],
    extraTerms: ['restoring force', 'phase angle'],
    lines: [
      'Today we are looking at simple harmonic motion, which shows up everywhere in physics.',
      'Imagine a mass hanging on a spring. You pull it down and let it go.',
      'The spring pulls it back towards the middle. That pull is the restoring force.',
      'The further you stretch it, the harder the spring pulls back.',
      'That single fact is what makes the motion a sine wave rather than anything else.',
      'The amplitude tells us how far the mass travels from the centre.',
      'The frequency tells us how many times it goes back and forth each second.',
      'Now, in the real world the motion does not continue forever.',
      'Air resistance and friction take energy out of the system. We call this damping.',
      'With damping, the amplitude gets smaller on every swing until the mass stops.',
      'But something interesting happens if we push the system at just the right rate.',
      'If we match the natural frequency, the amplitude grows enormously. That is resonance.',
      'This is why soldiers break step when they cross a bridge.',
    ],
  },
  {
    id: 'cs',
    title: 'Dynamic programming',
    course: 'CS203',
    packIds: ['cs-algorithms'],
    extraTerms: ['optimal substructure', 'overlapping subproblems'],
    lines: [
      'Today we are going to look at dynamic programming, which sounds harder than it is.',
      'Let us start with recursion. Suppose we want the tenth Fibonacci number.',
      'The obvious recursive solution calls itself twice for every number.',
      'If you draw the recursion tree, you will see the same values computed again and again.',
      'That repetition is what makes the time complexity exponential.',
      'The fix is almost embarrassingly simple. We just write down each answer the first time.',
      'When we need it again, we look it up instead of computing it. This is memoization.',
      'Now the time complexity drops from exponential to linear.',
      'A problem is suitable for dynamic programming when it has two properties.',
      'First, optimal substructure: the best answer is built from best answers to smaller pieces.',
      'Second, overlapping subproblems: those smaller pieces repeat.',
      'If both hold, you can almost always turn a slow recursion into a fast algorithm.',
    ],
  },
];

/* ------------------------------------------------------------------ *
 * Pacing
 * ------------------------------------------------------------------ */

/**
 * A lecturer speaks at roughly 130-150 words a minute, and pauses longer at the
 * end of a thought than between clauses. Feeding lines in at a constant rate
 * makes the pipeline look better than it is, because the segmenter and the
 * translation queue both behave differently under bursty input - which is what
 * real speech is.
 */
function speakingDelay(line: string, pace: number): number {
  const words = line.split(/\s+/).length;
  const base = (words / 140) * 60_000;
  const pause = /[.!?]$/.test(line) ? 700 : 300;
  const jitter = 0.85 + Math.random() * 0.3;
  return ((base + pause) * jitter) / pace;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function createRoom(script: Script): Promise<string> {
  const res = await fetch(`${BASE}/api/lectures`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: script.title,
      course: script.course,
      instructor: 'Dr. Rao',
      instructionLang: 'en',
      packIds: script.packIds,
      extraTerms: script.extraTerms,
    }),
  });
  if (!res.ok) throw new Error(`Could not create lecture: ${res.status}`);
  const json = (await res.json()) as { lecture: { id: string } };
  return json.lecture.id;
}

async function main() {
  const scriptId = arg('script', 'linear-algebra')!;
  const script = SCRIPTS.find((s) => s.id === scriptId);
  if (!script) {
    console.error(`Unknown script "${scriptId}". Available: ${SCRIPTS.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  const pace = Number(arg('pace', '1')) || 1;
  const positional = process.argv[2];
  const wantsNew = process.argv.includes('--new') || !positional || positional.startsWith('--');

  const code = wantsNew ? await createRoom(script) : positional.toUpperCase();

  console.log(`\n  Lecture:  ${script.title}`);
  console.log(`  Code:     ${code}`);
  console.log(`  Students: ${BASE.replace('8787', '5174')}/listen/${code}`);
  console.log(`  Pace:     ${pace}x\n`);

  const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws`);
  const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  send({ type: 'prof:join', lectureId: code });
  await wait(300);

  const startedAt = Date.now();

  for (const [i, line] of script.lines.entries()) {
    // Interim results first, the way recognition actually delivers them: a
    // partial guess that gets revised, then a final. The student UI has to
    // handle that, so the simulator has to produce it.
    const words = line.split(' ');
    if (words.length > 6) {
      send({
        type: 'prof:utterance',
        text: words.slice(0, Math.ceil(words.length / 2)).join(' '),
        final: false,
        t: Date.now() - startedAt,
      });
      await wait(400 / pace);
    }

    send({ type: 'prof:utterance', text: line, final: true, t: Date.now() - startedAt });
    console.log(`  ${String(i + 1).padStart(2)}. ${line}`);

    await wait(speakingDelay(line, pace));
  }

  console.log('\n  Lecture finished. Ending and saving the recording…');
  send({ type: 'prof:end' });
  await wait(1500);
  ws.close();
  console.log(`  Replay at ${BASE.replace('8787', '5174')}/replay/${code}\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('simulator failed:', err);
  process.exit(1);
});
