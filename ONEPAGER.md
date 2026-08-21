# Suvidha · सुविधा

**Live lecture translation that refuses to translate the vocabulary.**

Live demo → https://professortranslate.onrender.com
Repository → https://github.com/kingkamra1729/ProfessorTranslate

---

## Who this is for

A first-year engineering student in an Indian college who thinks in Hindi or Bengali.

They passed the entrance exam. They can read the textbook, slowly, with a dictionary. But
the lecture is delivered in English at speaking pace, and by the time they have decoded one
sentence the professor is three sentences further on. They are not failing because the
material is hard. They are failing because it is arriving in a language they are still
translating in their head.

This is not a hypothetical user. It is most of a classroom, in most colleges in India.

## The barrier we are removing

Not the terminology. **The explanation.**

A student can look up *eigenvalue*. What they cannot look up is the sentence the lecturer
improvised to make it land — *"so it tells you how much the vector gets stretched"* — the
aside that connected it to last week, the *"think about why that must be true."* That
sentence is never written down. It exists for four seconds and then it is gone.

And the obvious fix makes things worse. Point a translator at a lecture and it renders
*eigenvalue* as **अभिलक्षणिक मान** — correct, literary, and a word that appears in no
textbook, no exam, and no job interview. The student now understands the sentence and
cannot answer the question. The sentence got easier and the degree got harder.

## What we built

Suvidha translates the explanation and refuses to touch the terms.

```
Professor:  "So the eigenvalue of this matrix tells us how much the eigenvector is stretched."

Student:    "तो इस matrix का eigenvalue बताता है कि eigenvector कितना stretch होता है।"
             └─ Hindi voice ─┘  └ English ┘         └── Hindi ──┘ └── English ──┘
```

The student understands the sentence **and** still meets `eigenvalue` — in the subtitles,
and in an English voice in their earbud.

## How it works

**The terms are removed before the model ever sees the sentence.** Each one is replaced by a
sentinel, the model translates the connective tissue between the sentinels, and the terms
are spliced back afterwards. It is not asked nicely to preserve them; it is never given
them. Measured at **0% term loss across 162 translations**.

**The same pass records where each term landed**, which is the only moment we know with
certainty which characters are term and which are explanation. That boundary drives two
things at once: the highlighting in the subtitles, and a **second voice** — a Hindi voice
for the explanation, an English voice for the terms, inside one sentence. That is what makes
the rule audible rather than merely visible.

**It speaks the way people actually speak.** Real Indian classroom speech code-mixes: *"अब
देखते हैं कि determinant zero हो तो क्या होता है"* — not a Sanskritised rendering of it. A
translation that sends a student to a dictionary has failed at the one job it had.

**It catches its own gaps.** The glossary is the single point of failure, so the system
listens for subject vocabulary it does not yet protect and offers it to the professor
mid-lecture. Accepting one protects it for the rest of the class.

## Two things it also does

**Diagrams.** A lecturer saying *"so this decays and then oscillates"* is describing a
picture the class cannot see. Wolfram renders it — but only after the professor approves it,
because an unreviewed generated diagram on two hundred screens is a way to teach the wrong
thing very efficiently.

**It works for students who cannot see the board.** Every diagram carries a spoken
description, translated by the same term-preserving path. Recordings are archived as *text*,
not audio — so they can be re-voiced later in a language nobody chose during the lecture, at
any speed, or read by a screen reader.

## What is real

Everything above runs. Nothing is mocked.

| | |
|---|---|
| Term preservation | **0% loss**, 162 translations, `npm run test:reliability` |
| First translated word on screen | **~600 ms** |
| Words lost from continuous speech | **0** — 222 in, 222 out, `npm run test:sustained` |
| Automated checks | 100+ assertions across 8 suites |

The one thing we did not build is speech. Recognition and synthesis run in the browser,
free and without a key, because a lecturer should be able to walk into a hall and use this
without anyone having provisioned anything.

**Known limit, stated plainly:** a device with no Hindi voice installed produces silence.
The app detects this and says so rather than failing quietly — open `/check` on any device
to see. Phones almost always have the voices; Windows laptops often do not.
