/**
 * Exercises semantic chunking.
 *
 * Run with:  npx tsx src/pipeline/segment.test.ts
 *
 * Two properties are being defended here, and they pull against each other.
 * Cutting early lowers latency, because a chunk cannot start translating until
 * it is a complete thought. Cutting too early raises it, because a fragment
 * translates badly into a verb-final language and the student has to reassemble
 * the sentence themselves. Every assertion below is one of those two edges.
 *
 * The invariant that must never break, whatever the boundaries do: the chunks
 * plus the remainder reconstruct the input. Dropping a clause is worse than any
 * chunking decision.
 */
import { segment, UtteranceBuffer } from './segment.js';

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

/** Chunks plus remainder must be the input again, modulo whitespace. */
function reconstructs(input: string): boolean {
  const { chunks, remainder } = segment(input);
  const rebuilt = [...chunks, remainder].join(' ').replace(/\s+/g, ' ').trim();
  return rebuilt === input.replace(/\s+/g, ' ').trim();
}

console.log('\nterminal punctuation');
{
  const { chunks, remainder } = segment(
    'So the eigenvalue tells us the stretch. Now look at the second one.',
  );
  check('a full stop ends a chunk', chunks.length === 2, { chunks, remainder });
  check('the mark stays with its own clause', chunks[0]?.endsWith('.') === true, chunks);
  check('nothing is left pending', remainder === '', remainder);
}

{
  const { chunks } = segment('What happens when it is zero? It collapses.');
  check('a question mark ends a chunk', chunks.length === 2, chunks);
}

{
  // The end-of-input alternative: recognition hands us a result that stops dead
  // at the full stop, with no trailing space. Requiring whitespace would leave
  // the whole sentence buffered until the professor's next breath.
  const { chunks, remainder } = segment('The determinant is zero.');
  check('a sentence ending at end-of-input is emitted', chunks.length === 1, { chunks, remainder });
}

console.log('\nclause punctuation');
{
  const { chunks } = segment(
    'When the determinant vanishes, the matrix has no inverse at all.',
  );
  check('a comma cuts a long enough clause', chunks.length === 2, chunks);
  check('the cut lands after the comma', chunks[0]?.endsWith(',') === true, chunks);
  check('the rest of the sentence follows as its own chunk', chunks[1]?.startsWith('the matrix') === true, chunks);
}

{
  // "So," is four characters. Cutting there buys a millisecond and costs the
  // model the whole sentence it needed to order the translation.
  const { chunks, remainder } = segment('So, the eigenvalue is two');
  check('a comma after two words does not cut', chunks.length === 0, { chunks, remainder });
}

console.log('\nconjunctions');
{
  const { chunks } = segment(
    'The system loses energy over time because damping takes it out of the oscillation',
  );
  check('a strong conjunction cuts', chunks.length === 1, chunks);
  check(
    'the conjunction opens the next chunk',
    !chunks[0]?.includes('because'),
    chunks,
  );
}

{
  const { chunks } = segment(
    'That is the definition we will use but the textbook writes it the other way round',
  );
  check('"but" cuts a long clause', chunks.length === 1, chunks);
}

{
  // The case that makes "and" dangerous: it joins two nouns far more often than
  // two clauses, and this phrase is one idea.
  const { chunks, remainder } = segment('Eigenvalues and eigenvectors are related');
  check('"and" inside a noun phrase does not cut', chunks.length === 0, { chunks, remainder });
}

{
  const long =
    'We start by computing the characteristic polynomial of the matrix and then we solve it for the roots';
  const { chunks } = segment(long);
  check('"and" does cut once the clause is long', chunks.length >= 1, chunks);
}

{
  // "band" contains "and". Matching it would cut mid-word and corrupt the text.
  const { chunks, remainder } = segment('The band structure of the crystal is periodic');
  check('a conjunction inside a word does not match', chunks.length === 0, {
    chunks,
    remainder,
  });
}

console.log('\nlength backstop');
{
  const runOn =
    'we take the vector then we apply the transformation to it repeatedly until the direction ' +
    'stops changing at which point what we are looking at is the dominant eigenvector of that ' +
    'transformation which is the thing the whole method depends on finding quickly';
  const { chunks, remainder } = segment(runOn);
  // The speaker is still going, so the tail stays buffered - but the run-on
  // must not have been handed to the model as one 250-character block.
  check('a run-on is broken up rather than sent whole', chunks.length + (remainder ? 1 : 0) >= 2, {
    chunks: chunks.map((c) => c.length),
    remainder: remainder.length,
  });
  check(
    'no chunk exceeds the flush threshold by much',
    chunks.every((c) => c.length <= 160),
    chunks.map((c) => c.length),
  );
  check(
    'a forced cut lands between words',
    chunks.every((c) => c === c.trim() && !c.endsWith('-')),
    chunks,
  );
}

console.log('\nnothing is ever lost');
{
  const inputs = [
    'So the eigenvalue tells us the stretch. Now look at the second one.',
    'When the determinant vanishes, the matrix has no inverse at all.',
    'The system loses energy because damping takes it out of the oscillation',
    'Eigenvalues and eigenvectors are related',
    'So, the eigenvalue is two',
    'अब देखते हैं कि determinant zero हो तो क्या होता है।',
    '   ',
    '',
  ];
  check(
    'chunks plus remainder reconstruct every input',
    inputs.every(reconstructs),
    inputs.filter((i) => !reconstructs(i)),
  );
}

console.log('\nthe danda');
{
  const { chunks } = segment('यह एक matrix है। इसका eigenvalue दो है।');
  check('a Devanagari danda ends a chunk', chunks.length === 2, chunks);
}

console.log('\nbuffer across recognition results');
{
  const buffer = new UtteranceBuffer();
  const first = buffer.push('So the eigenvalue tells us the stretch. Now look at');
  check('the complete sentence is emitted', first.length === 1, first);
  check('the trailing fragment is held', !buffer.isEmpty, buffer.peek());

  const second = buffer.push('the second one.');
  check('the held fragment is completed by the next result', second.length === 1, second);
  check(
    'the completed chunk contains both halves',
    second[0]?.includes('Now look at') === true && second[0]?.includes('second one') === true,
    second,
  );
  check('nothing is left over', buffer.isEmpty, buffer.peek());
}

{
  // The pause path. Without it this tail waits for speech that is not coming,
  // and is then prepended to whatever the professor says next.
  const buffer = new UtteranceBuffer();
  buffer.push('and that is the whole idea');
  check('an unterminated tail is buffered', !buffer.isEmpty, buffer.peek());

  const flushed = buffer.flush();
  check('a pause flushes the tail regardless of length', flushed.length === 1, flushed);
  check('the buffer is empty afterwards', buffer.isEmpty, buffer.peek());
}

{
  const buffer = new UtteranceBuffer();
  check('flushing an empty buffer emits nothing', buffer.flush().length === 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
