# Suvidha · सुविधा

**Live lecture translation that refuses to translate the vocabulary.**

Live demo → https://professortranslate.onrender.com
Repository → https://github.com/kingkamra1729/ProfessorTranslate

---

## Where this came from

I did not start from a dataset. I started from the people sitting around me.

My college takes students from every part of the country, and we arrive speaking different
mother tongues into the same lecture hall, where everything is delivered in English. I
watched classmates who had cleared the same entrance exam I had — who understood the subject
perfectly well — fall behind because of the language it arrived in. They would ask me
afterwards what the professor had said. Not what a word meant. What the *sentence* meant.

Then I saw the live interpretation used in parliament, where a speech reaches every member
in their own language as it is being given, and the question became obvious: why does a
lecture hall not have this?

## Who this is for

**Any student sitting in a lecture delivered in someone else's language.**

I saw this in India, but nothing about the problem is Indian. It is the exchange student in
Berlin, the refugee finishing a degree in a country they arrived in last year, the
engineering student anywhere whose textbooks are in English and whose thinking is not.

Wherever education is delivered in a language of prestige rather than a language of home,
the same students fall behind for the same reason — and it is never because the material was
beyond them.

The system is built language-agnostically. It runs today in English, Hindi, Bengali and
French; adding another is one entry in a config file plus a handful of example sentences to
pin the register.

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

## Everything it does

### Working now

- **Live translation to an earpiece.** The professor speaks; each student hears their own
  language, seconds behind.
- **Technical terms never translated** — in the subtitles and in the audio, spoken by a
  second voice.
- **Every student picks their own language,** switchable mid-sentence, in one shared lecture.
- **Subtitles on screen** with protected vocabulary marked, alongside what the professor
  actually said.
- **Diagrams from the lecture itself.** Wolfram renders the plot a lecturer is describing —
  published only once the professor approves it, because an unreviewed generated diagram on
  two hundred screens teaches the wrong thing very efficiently.
- **Spoken descriptions of every diagram,** translated the same way, so a student who cannot
  see the board hears what it shows.
- **Recorded lectures,** archived as text rather than audio — so they replay in a language
  nobody chose that day, at any speed, or through a screen reader.
- **Course files build the glossary.** Upload a PDF of last year's notes, or point it at a
  syllabus URL.
- **A pre-flight check** that tells a professor whether the room's hardware can actually do
  this, before the class arrives.

### Designed, not yet built

- **Animated demonstrations.** Diagrams are static plots today. A wave that actually
  oscillates and a vector that actually rotates is the next thing to build.
- **Generated video** for concepts that need more than a plot, for students following on a
  computer rather than a phone.
- **Definitions preserved like terms.** Right now only the vocabulary is protected; a spoken
  definition is still translated, and it should not be.
- **Extraction from photographs of handwritten notes,** so a glossary can be built from what
  is actually on the board.
- **More languages,** and instruction in languages other than English.
- **Cloud speech recognition** as an option for noisy halls and strong accents, behind the
  same interface as the browser one.
- **Recordings that survive a redeploy,** which today they do not.

## What is real

Everything in *Working now* runs. Nothing is mocked.

| | |
|---|---|
| Term preservation | **0% loss**, 162 translations, `npm run test:reliability` |
| First translated word on screen | **~600 ms** |
| Words lost from continuous speech | **0** — 222 in, 222 out, `npm run test:sustained` |
| Automated checks | 100+ assertions across 8 suites |

The one thing we did not build is speech. Recognition and synthesis run in the browser,
free and without a key, because a lecturer should be able to walk into a hall and use this
without anyone having provisioned anything.

**This is a prototype, not a product.** It was built in a week and has not yet faced a
real class. The pipeline is measured and the numbers above are real, but a mistranslated
sentence costs a student more than no translation would.

**Known limit, stated plainly:** a device with no Hindi voice installed produces silence.
The app detects this and says so rather than failing quietly — open `/check` on any device
to see. Phones almost always have the voices; Windows laptops often do not.
