# Suvidha · सुविधा

**Live lecture translation that leaves the technical vocabulary alone.**

A student who thinks in Hindi, Bengali or French sits through a lecture delivered in
English. What they lose is not the terminology — they can look that up. What they lose is
the *explanation*: the sentence the lecturer improvised to make the idea land, the aside
that connected it to last week, the "think about why that must be true."

Suvidha translates that, and only that. Every technical term reaches the student's ear in
the language the course is taught in, in a voice that pronounces it correctly.

```
Professor:  "So the eigenvalue of this matrix tells us how much the eigenvector is stretched."

Student:    "तो इस matrix का eigenvalue हमें बताता है कि eigenvector कितना खिंचता है।"
             └── Hindi voice ──┘ └─ English voice ─┘
```

The student understands the sentence *and* still meets `eigenvalue` — the word that is in
the textbook, on the exam, and in the interview.

---

## Why this is not just translation

Point a general translator at a lecture and it will happily render "eigenvalue" as a coined
Hindi compound. The sentence gets easier and the degree gets harder: the student now knows
an idea by a name nobody else uses.

Suvidha makes that failure structurally impossible rather than asking a model politely to
avoid it.

```
  "So the eigenvalue of this matrix …"
            │
            ▼   maskTerms()  — terms are lifted out
  "So the ⟦0⟧ of this ⟦1⟧ …"
            │
            ▼   the model translates the connective tissue only
  "तो इस ⟦1⟧ का ⟦0⟧ …"
            │
            ▼   unmaskTerms()  — terms are put back, and the run split is recorded
  "तो इस matrix का eigenvalue …"
   [hi]      [en]   [hi]  [en]
```

**The model never sees the terms, so it cannot translate them.**

The same pass that restores the terms records where they sit in the translated sentence.
That boundary is the only place we know with certainty which characters are term and which
are explanation — so it drives both the teal highlighting in the subtitles and the voice
switch in the audio. Recovering it afterwards, from the finished string, would mean
guessing, and a wrong guess sends a Hindi voice at a Latin word.

---

## What it does

| | |
|---|---|
| **Live translation** | Professor speaks; students hear their own language in an earbud, ~1–3 s behind |
| **Terms preserved** | Untranslated in the subtitles *and* spoken by a second voice in the audio |
| **Any language per student** | One lecture, each student on a different language, switchable mid-sentence |
| **Diagrams** | Wolfram-rendered plots proposed from the lecture content — professor approves before the class sees anything |
| **Accessibility** | Every diagram carries a spoken description, translated the same way. Screen-reader live regions throughout |
| **Recordings** | Archived as *text*, not audio — so replay works in a language nobody chose during the lecture, at any speed |

---

## Running it

```bash
npm install
npm run dev
```

Professor console at **http://localhost:5173/teach**, students join at **/listen/&lt;CODE&gt;**.

This works with **no API keys at all** — speech capture and synthesis happen in the browser
and cost nothing. Without keys, translation falls through to passthrough and says so on
screen rather than passing off untranslated text as a translation.

### Keys

Copy `.env.example` to `.env`. Every key is optional and each one upgrades one feature.

```bash
cp .env.example .env
```

| Key | Turns on | Get it |
|---|---|---|
| `FEATHERLESS_API_KEY` | Real translation, glossary extraction, diagram drafting | [featherless.ai](https://featherless.ai) → Dashboard → API Keys |
| `WOLFRAM_APP_ID` | Wolfram\|Alpha rendered diagrams | [developer.wolframalpha.com](https://developer.wolframalpha.com/portal/myapps) |
| `WOLFRAM_CLOUD_API_URL` | Better diagrams — arbitrary Wolfram Language | run `scripts/wolfram-deploy.wl` |
| `FIRECRAWL_API_KEY` | Build the glossary from a syllabus URL | [firecrawl.dev](https://firecrawl.dev) |

`FEATHERLESS_API_KEY` is the one that matters. The rest are enhancements.

### Demo without a microphone

A scripted lecture, played in at realistic speaking pace:

```bash
npm run simulate -- --new --script linear-algebra
```

It prints a join code and a student URL. `--script` takes `linear-algebra`, `physics` or
`cs`; `--pace 2` runs at double speed. Use this if the hall microphone is unreliable, or to
make the demo reproducible.

### Checking it actually works

```bash
npm run doctor
```

Verifies that each configured service *works*, not merely that a key is present — it
authenticates, confirms the model id exists on your account, and runs a real
term-preserving translation into all three languages, asserting that `eigenvalue`,
`matrix` and `eigenvector` survived and are tagged for an English voice. A key that is set
but rejected looks identical to a working one from the outside and degrades silently to
passthrough, which is not something to discover during a demo.

```bash
npm test          # term-protection engine, 21 assertions
npm run test:live # full WebSocket pipeline against a running server, 23 assertions
```

---

## Deploying

### The constraint

**Vercel cannot host the server.** It runs serverless functions, which cannot hold a
WebSocket open, do not share memory between invocations, and time out long before a lecture
ends. A lecture room in `server/src/rooms.ts` is a live object holding one professor socket
and a set of student sockets — there is nowhere in a serverless model to put it.

So: frontend on Vercel, server on something always-on. Or put both on the always-on host
and skip Vercel entirely.

### Option A — single host (simplest)

The server serves the built frontend itself, so everything is one origin, one URL, no CORS
and nothing to configure.

```bash
npm run build && npm start
```

Deploy that with the included `Dockerfile` to Railway, Fly.io, Cloud Run, or anything that
keeps a container running. Set `FEATHERLESS_API_KEY` in the host's dashboard.

### Option B — Vercel frontend + Render server

**1. Server on Render.** Push to GitHub, then *New → Blueprint* on [render.com](https://render.com)
and select the repo. `render.yaml` configures it; set `FEATHERLESS_API_KEY` in the dashboard
when prompted. Note the URL it gives you, e.g. `https://suvidha-server.onrender.com`.

**2. Frontend on Vercel.** Import the repo. `vercel.json` configures the build. Add one
environment variable:

```
VITE_SERVER_URL = https://suvidha-server.onrender.com
```

It must be `https://` — a page served over HTTPS cannot open a `ws://` connection, and the
browser error does not say so. The app checks for this and shows a banner rather than
leaving you to guess.

**3. Pin the origin** (optional). Set `ALLOWED_ORIGINS` on Render to your Vercel URL.

Vercel env vars are build-time for `VITE_*`, so **redeploy after changing it**.

### Deployment gotchas

- **Render's free tier sleeps** after ~15 minutes idle and takes ~30s to wake. Load the
  professor console a minute before the demo, or use a paid tier.
- **Recordings live on disk.** Most hosts reset the filesystem on redeploy. Point `DATA_DIR`
  at a mounted disk to keep them.
- **Rooms are in memory.** Restarting the server ends any live lecture. Fine for a single
  instance; running more than one would need shared state.
- **Speech recognition needs HTTPS** (or localhost). Both Vercel and Render give you that.

### Never commit secrets

`.gitignore` excludes `.env` and every `.env.*` variant, and re-includes `.env.example`.
Verify before pushing:

```bash
git status --porcelain | grep -E "\.env$"
```

That must print nothing. Keys belong in the host's dashboard, not the repo.

---

## How it is put together

```
shared/          Protocol types shared by both ends. SpeechRun is the important one.

server/
  pipeline/
    glossary.ts     Term detection, masking, and the run split. The core.
    translate.ts    Prompting, output hygiene, caching, graceful degradation.
    segment.ts      Re-cuts recognition results on sentence boundaries.
    visualize.ts    Concept detection → diagram spec → approval gate.
    auto-glossary.ts Extracts vocabulary from course material.
  providers/        Featherless (translation), Wolfram (plots), Firecrawl (import).
  rooms.ts          One professor, many students, fan-out per language.
  store.ts          Lecture archive, as plain JSON.

web/
  lib/tts.ts        Multi-voice synthesis queue. The other core file.
  lib/asr.ts        Web Speech recognition, and the restart loop it needs.
  routes/           Professor console, student listener, replay.
```

### Decisions worth knowing about

**Translation is driven by who is listening.** Rendering a lecture into Bengali that nobody
is listening to costs latency for the students who *are* listening, because the calls share
a rate limit. Replay translates on demand instead.

**Falling behind is handled explicitly.** Translation plus synthesis is slower than speech.
A queue that never drops anything drifts further behind with every sentence until the
student is hearing a different paragraph than the one on the board. Past three queued
utterances Suvidha discards the oldest — the one furthest behind and least useful — and
tells the student it did.

**Nothing generated reaches students unreviewed.** Diagram suggestions go to the professor,
not the class. An unreviewed AI diagram on two hundred screens mid-lecture is a way to teach
the wrong thing very efficiently. Rendering is deferred to approval, so a dismissed
suggestion never spends a Wolfram credit.

**Recordings store text, not audio.** Audio would fix the language at recording time. Text
plus translations can be re-voiced later in a language nobody chose during the lecture, at
half speed, or by a screen reader instead of by us.

**Interim results are never translated.** Speech recognition revises them two or three times
a second; translating a sentence that is about to change wastes the call and makes the audio
stutter.

---

## Speech, and the gap in the sponsor credits

Featherless covers the language work completely — and its unlimited-token plan is well
matched to a live lecture, which is a continuous stream of small calls. Wolfram covers the
mathematics. Neither does speech in either direction.

Suvidha uses the browser's built-in Web Speech API for both, which is free, needs no key,
and works offline for synthesis. That is also the honest hackathon answer: a lecturer should
be able to walk into a hall and use this without anyone having provisioned anything.

The trade-off is real and worth stating: browser recognition is less accurate on accented
technical English than a paid cloud ASR would be. This is exactly why the glossary carries
aliases — `eigen value`, `igen value`, `sudo code` — so a mangled term is still recognised as
a term and still protected. Both `lib/asr.ts` and `providers/` are written as adapters, so a
cloud ASR drops in behind the same interface when accuracy justifies the cost.

---

## Known limits

- Recognition quality on heavily accented speech in a noisy hall is the weakest link.
- Bengali speech synthesis is not installed on every OS; the app checks at join time and
  tells the student plainly rather than failing silently.
- Replay in a language nobody used during the lecture shows the original text — those
  renderings were never generated. On-demand replay translation is the obvious next step.
- The visualisation drafter is deliberately conservative and declines most speech. A wrong
  diagram is worse than no diagram.
