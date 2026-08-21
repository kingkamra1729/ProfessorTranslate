# Devpost — "About the project"

Paste the content below the line into the Devpost field. It uses the standard Devpost
headings, so it will sit correctly alongside other submissions.

Written in the first person singular. If you are submitting as a team, swap "I" for "we"
throughout.

---

## Inspiration

I did not start from a dataset. I started from the people sitting around me.

My college takes students from every part of the country, and we arrive speaking different
mother tongues into the same lecture hall, where everything is delivered in English. I
watched classmates who had cleared the same entrance exam I had — who understood the subject
perfectly well — fall behind because of the language it arrived in. They would ask me
afterwards what the professor had said. Not what a word meant. What the *sentence* meant.

Then I saw the live interpretation used in parliament, where a speech reaches every member
in their own language as it is being spoken, and the question became obvious: **why does a
lecture hall not have this?**

But I also knew the naive version of this idea would make things worse. Point a translator
at a lecture and it renders *eigenvalue* as **अभिलक्षणिक मान** — a correct, literary
translation, and a word that appears in no textbook, no exam, and no job interview. The
student understands the sentence and then cannot answer the question. The sentence gets
easier and the degree gets harder.

That contradiction is the whole project. **Translate the explanation. Never translate the
vocabulary.**

## What it does

A professor speaks into their microphone. Every student in the room hears the lecture in
their own language through an earpiece, seconds behind — except the technical terms, which
reach them unchanged, in the language the course is taught in.

Given $A\mathbf{v} = \lambda\mathbf{v}$, a lecturer explaining what $\lambda$ actually means
might say:

> "So the eigenvalue of this matrix tells us how much the eigenvector is stretched."

A Hindi-speaking student hears:

> तो इस **matrix** का **eigenvalue** बताता है कि **eigenvector** कितना **stretch** होता है।

One sentence, two voices. A Hindi voice speaks the explanation; an English voice speaks the
terms. The student understands the sentence *and* still meets the word they will see in the
textbook.

It also renders diagrams from what the lecturer is describing (professor-approved before the
class sees them), gives every diagram a spoken description so a student who cannot see the
board hears what it shows, builds its glossary from an uploaded PDF of course notes, and
archives lectures as text so they can be replayed later in a language nobody chose that day.

## How I built it

**The core mechanism is subtraction, not instruction.** Before a sentence reaches the
translation model, every known technical term is lifted out and replaced with a sentinel:

```
"So the eigenvalue of this matrix tells us…"
        ↓  terms removed
"So the ⟦0⟧ of this ⟦1⟧ tells us…"
        ↓  the model translates only the connective tissue
"तो इस ⟦1⟧ का ⟦0⟧ बताता है…"
        ↓  terms restored, and the boundary recorded
"तो इस matrix का eigenvalue बताता है…"
```

The model is never *asked* to preserve the terms. It is never given them. It cannot
translate what it did not receive.

The same pass that restores a term records **where it landed in the translated sentence** —
the only moment when we know with certainty which characters are vocabulary and which are
explanation. That boundary drives two things at once: the highlighting in the subtitles, and
the voice switch in the audio. Recovering it later, from the finished string, would mean
guessing, and a wrong guess sends a Hindi voice at a Latin word.

**The stack:**

- **Featherless AI** (`Qwen/Qwen3-30B-A3B-Instruct-2507`) for every language task — live
  translation, glossary extraction, detecting missing terminology, drafting diagram specs.
  One model does all four.
- **Wolfram|Alpha** for rendering the mathematics.
- **Firecrawl** for turning a syllabus URL into glossary material.
- **Web Speech API** in the browser for both speech recognition and synthesis — free, no
  key, so a lecturer can walk into a hall and use this without anyone provisioning anything.
- **TypeScript, Node, WebSockets, React**, deployed as a single service on **Render**.

## Challenges I ran into

Almost every problem turned out to be something other than what it looked like.

**One sentence arrived as a growing stutter.** Students were seeing *"transverse energy
transverse energy transverse energy through and"*. It looked like a translation bug. It was
a misreading of the Web Speech API: `event.resultIndex` is the first result that *changed*,
not the first one you have not seen. Chrome fires the event repeatedly while revising a
phrase and keeps pointing at a result already delivered, so every fire re-emitted it. The
French translation was faithfully reproducing repetition that had arrived that way.

**8% of every lecture was silently disappearing.** My tests fed the system one tidy sentence
at a time. Real dictation delivers fragments with no punctuation, and my segmenter was
waiting for a full stop that never came — so the tail of a lecture sat in a buffer until the
professor pressed *End*. I only found it after writing a probe that speaks continuously the
way a microphone actually delivers speech. A single-sentence measurement had called the
pipeline fast while lectures were losing words.

**The translations were correct and useless.** Early Hindi output was literary: शून्य for
*zero*, अवमंदन for *damping*, आइए देखें for *let's see*. Every one is a correct dictionary
translation and the wrong choice — a student handed a Sanskritised coinage has been given a
word *harder* than the English it replaced. Real Indian classroom speech code-mixes heavily.
Fixing it meant asking for that register explicitly — and then, when the model complied only
inconsistently, protecting everyday English words with the same sentinel mechanism used for
technical terms, so the outcome stopped depending on persuasion.

**Bigger models were worse.** I assumed a larger model would produce better structured
output. On a 400-token generation, `Qwen3-235B-A22B` and `Qwen3.5-27B` spent their entire
token budget on internal reasoning and returned **empty strings**, while the 30B
mixture-of-experts model returned clean JSON in nine seconds. Bigger was not better; it was
empty.

**Half the latency was my own prompt.** Time-to-first-token scales with how much prompt the
model reads before generating, and mine was 1,560 characters of rules re-read on every
sentence of every lecture. Cutting it to 353 took time-to-first-token from 1209ms to
**586ms** with identical term preservation. Half the student's waiting time was being spent
on prose that changed nothing.

**A feature that had never once run.** Diagram suggestions and live term detection both
stand down when the request budget is busy — but the check demanded two free slots, and a
room with three languages has three translations in flight against a limit of four. The
condition was permanently true. The features were not broken and not slow; they were
unreachable. It was a one-character fix, and I only found it by counting proposals in a
load test.

**Silence that reports success.** `speechSynthesis` accepts an utterance in a language it
has no voice for, raises no error, fires no error event, and produces nothing. A student can
sit through a whole lecture in silence while the app shows every sign of working. This is
the failure mode I now consider most dangerous, and the app detects it explicitly and says
so.

## Accomplishments that I'm proud of

**The central promise is measured, not claimed.** Term preservation is the one property here
that is not deterministic — it depends on a model copying sentinel tokens through a sentence
it is rewriting. So I built a harness that runs the same translations repeatedly and reports
the loss rate. It currently reads **0% across 162 translations**, and it fails the build
above 3%.

| Measured | Result |
|---|---|
| Technical terms lost in translation | **0%** over 162 runs |
| Words lost from continuous fragmented speech | **0** of 222 |
| First translated word on the student's screen | **~600 ms** |
| Automated assertions | 100+ across eight suites |

I am also proud that the app **degrades honestly**. With no API key it falls through to
passthrough and says so on screen rather than passing untranslated text off as a
translation. When a device has no voice for a language, it says that too, in the loudest
element on the page. A tool that quietly does nothing is worse than one that admits it.

## What I learned

**Measure before fixing.** Every symptom in this project pointed at the wrong cause.
"Translation is bad" was a speech-recognition bug. "It's slow" was my own prompt length.
"Diagrams don't work" was an off-by-one in a rate limiter.

**Correct is not the same as useful.** The literary Hindi translations were accurate and
actively harmful. Judging output by whether it is *right* rather than whether it *helps* is
how you build something nobody can use.

**The dangerous failures are the ones that report success.** A missing voice, a rejected API
key, a buffer holding speech forever — none of these throw. They all look exactly like
working software from the outside.

**Write the test that reproduces reality, not the one that passes.** My suites tested clean
sentences because clean sentences are what a test author types. The moment I fed the system
what a microphone actually produces, an 8% word-loss bug appeared that had been there all
along.

## What's next for Suvidha

The honest answer is that this is a prototype and has not yet faced a real class.

- **Animated demonstrations.** Diagrams are static plots today. A wave that actually
  oscillates and a vector that actually rotates.
- **Generated video** for concepts that need more than a plot.
- **Definitions preserved like terms.** Right now only vocabulary is protected; a spoken
  definition still gets translated, and it should not be.
- **Reading a glossary off photographs of handwritten notes**, so it can be built from what
  is actually on the board.
- **More languages**, and instruction in languages other than English. The architecture is
  language-agnostic; adding one is a config entry plus a few example sentences.
- **Cloud speech recognition** as an option for noisy halls and strong accents.

The first real test is a live lecture with students who need it, and finding out how much of
this survives contact with a room.
