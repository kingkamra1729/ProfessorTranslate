/**
 * Reproduces the way Chrome actually reports speech results.
 *
 *   npx tsx src/lib/asr.test.ts
 *
 * The Web Speech API cannot be driven from a test, so this drives the
 * Recognizer with a fake that replays the event sequence Chrome really
 * produces - including the part that caused a live lecture to arrive as
 * "transverse energy transverse energy transverse energy through and".
 *
 * The trap is `event.resultIndex`. It is documented as where new content
 * begins, and is widely assumed to mean "the first thing you have not seen".
 * It is neither: it is the first result that *changed*, and Chrome keeps
 * pointing at a finalised result while it revises what follows.
 */
import { Recognizer } from './asr.js';

// This file runs under tsx in Node, not in the browser bundle, but it lives in
// the web workspace whose tsconfig has no Node types. Declaring the one member
// used is cheaper and clearer than a second tsconfig.
declare const process: { exit(code: number): never };

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log('       ', JSON.stringify(detail));
  }
}

/* ------------------------------------------------------------------ *
 * A fake SpeechRecognition
 * ------------------------------------------------------------------ */

interface FakeResult {
  transcript: string;
  isFinal: boolean;
}

class FakeRecognition {
  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;

  static instances: FakeRecognition[] = [];

  constructor() {
    FakeRecognition.instances.push(this);
  }

  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }

  start(): void {
    this.onstart?.();
  }
  stop(): void {
    this.onend?.();
  }
  abort(): void {
    this.onend?.();
  }

  /** Delivers one `onresult` event exactly as the browser shapes it. */
  fire(resultIndex: number, results: FakeResult[]): void {
    const list = results.map((r) => ({
      0: { transcript: r.transcript, confidence: 0.9 },
      length: 1,
      isFinal: r.isFinal,
      item: (i: number) => ({ transcript: r.transcript, confidence: 0.9 }),
    }));
    this.onresult?.({
      resultIndex,
      results: Object.assign(list, { length: list.length, item: (i: number) => list[i] }),
    });
  }
}

function install() {
  FakeRecognition.instances = [];
  (globalThis as Record<string, unknown>).window = globalThis;
  (globalThis as Record<string, unknown>).SpeechRecognition = FakeRecognition;
}

function collect(): { finals: string[]; interims: string[]; rec: Recognizer } {
  const finals: string[] = [];
  const interims: string[] = [];
  const rec = new Recognizer('en', {
    onResult: (text, isFinal) => (isFinal ? finals.push(text) : interims.push(text)),
  });
  rec.start();
  return { finals, interims, rec };
}

/* ------------------------------------------------------------------ *
 * Cases
 * ------------------------------------------------------------------ */

install();

console.log('\nthe reported bug');
{
  const { finals, rec } = collect();
  const r = FakeRecognition.instances[0];

  // Chrome revising one phrase, then finalising it - and then continuing to
  // report resultIndex 0 while the next phrase is being heard.
  r.fire(0, [{ transcript: 'transverse energy', isFinal: false }]);
  r.fire(0, [{ transcript: 'transverse energy', isFinal: true }]);
  r.fire(0, [
    { transcript: 'transverse energy', isFinal: true },
    { transcript: ' through', isFinal: false },
  ]);
  r.fire(0, [
    { transcript: 'transverse energy', isFinal: true },
    { transcript: ' through and', isFinal: false },
  ]);
  r.fire(1, [
    { transcript: 'transverse energy', isFinal: true },
    { transcript: ' through and', isFinal: true },
  ]);

  check('a finalised phrase is delivered exactly once', finals.length === 2, finals);
  // Each final is trimmed, so the leading space on the second fragment is gone.
  check('no repetition in the delivered finals',
    finals.join('|') === 'transverse energy|through and', finals);
  rec.dispose();
}

console.log('\nordinary sequences still work');
{
  const { finals, interims, rec } = collect();
  const r = FakeRecognition.instances[FakeRecognition.instances.length - 1];

  r.fire(0, [{ transcript: 'the eigenvalue', isFinal: false }]);
  r.fire(0, [{ transcript: 'the eigenvalue of this matrix', isFinal: false }]);
  r.fire(0, [{ transcript: 'the eigenvalue of this matrix', isFinal: true }]);
  r.fire(1, [
    { transcript: 'the eigenvalue of this matrix', isFinal: true },
    { transcript: 'is two', isFinal: true },
  ]);

  check('every distinct final is delivered', finals.length === 2, finals);
  check('finals are in spoken order',
    finals.join('|') === 'the eigenvalue of this matrix|is two', finals);
  check('interim revisions are reported for the live caption', interims.length === 2, interims);
  rec.dispose();
}

console.log('\nrepeated content');
{
  const { finals, rec } = collect();
  const r = FakeRecognition.instances[FakeRecognition.instances.length - 1];

  // The same text finalised twice at different indices: a duplicate, not a
  // lecturer repeating themselves - the browser produced both from one phrase.
  r.fire(0, [{ transcript: 'the determinant is zero', isFinal: true }]);
  r.fire(1, [
    { transcript: 'the determinant is zero', isFinal: true },
    { transcript: 'the determinant is zero', isFinal: true },
  ]);

  check('identical consecutive finals are not repeated', finals.length === 1, finals);
  rec.dispose();
}

console.log('\nafter a restart');
{
  const { finals, rec } = collect();
  const first = FakeRecognition.instances[FakeRecognition.instances.length - 1];

  first.fire(0, [{ transcript: 'and this is why', isFinal: true }]);
  check('first session delivered', finals.length === 1, finals);

  // Chrome ends the session on a pause; a fresh one starts with fresh indices
  // and sometimes repeats the tail of the previous session. The respawn is on a
  // short timer, so the test has to wait for it rather than assume it is
  // synchronous.
  first.onend?.();
  await new Promise((r) => setTimeout(r, 400));

  const restarted = FakeRecognition.instances[FakeRecognition.instances.length - 1];
  if (restarted && restarted !== first) {
    restarted.fire(0, [{ transcript: 'and this is why', isFinal: true }]);
    check('the repeated tail after a restart is dropped', finals.length === 1, finals);
    restarted.fire(1, [
      { transcript: 'and this is why', isFinal: true },
      { transcript: 'we diagonalize', isFinal: true },
    ]);
    check('genuinely new speech after a restart still arrives', finals.length === 2, finals);
  } else {
    check('recogniser respawned after the session ended', false, 'no new instance');
  }
  rec.dispose();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
