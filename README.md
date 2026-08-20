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
| **Missing terms caught live** | The system watches for subject vocabulary the glossary lacks and offers it to the professor mid-lecture |
| **Recordings** | Archived as *text*, not audio — so replay renders into a language nobody chose during the lecture, on demand |

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
npm test           # term-protection engine, 21 assertions, no network
npm run test:live  # full WebSocket pipeline against a running server, 23 assertions
npm run test:features  # Wolfram render + Firecrawl import, 12 assertions (spends credits)
npm run bench      # times candidate models on a realistic generation
npm run test:scout     # missing-term suggestions reach the professor, live
npm run test:reliability  # term survival rate over many runs (see below)
```

`test:reliability` exists because term preservation is the one property here that is not
deterministic — it depends on a model copying sentinel tokens through a sentence it is
rewriting. A single passing test says nothing about a property that fails one time in
twenty, and one in twenty across a lecture is several mistranslated terms per class. It
runs the same translations repeatedly and reports the loss rate, failing above 3%.
Currently **0% over 162 translations**, median latency 1.3–1.8s.

---

## Deploying

One service on [Render](https://render.com), which is in the sponsor list.

The server builds and serves the frontend itself, so the professor console, the student view,
the REST API and the WebSocket all sit behind a single origin. That removes three whole
classes of failure by construction: CORS, mixed content (an `https` page cannot open a
`ws://` socket), and a frontend baked against a stale server URL.

```bash
# what Render runs
npm install && npm run build   # build
npm start                      # start
```

**Deploy:** push to GitHub → *New → Blueprint* on Render → pick the repo. `render.yaml`
configures everything; set `FEATHERLESS_API_KEY`, `WOLFRAM_APP_ID` and `FIRECRAWL_API_KEY`
in the dashboard when prompted. Never in the repo.

A `Dockerfile` is included too, so Railway, Fly.io or Cloud Run work identically.

### Why not Vercel

It cannot host this. Vercel runs serverless functions: they cannot hold a WebSocket open,
they do not share memory between invocations, and they time out long before a lecture ends.
A lecture room in `server/src/rooms.ts` is a live object holding the professor's socket and
every student's socket for the length of a class. Deploying there would give you a working
homepage that nobody can ever join.

### Deployment notes

- **Render's free tier sleeps** after ~15 minutes idle and takes ~30s to wake. Open the
  professor console a minute before demoing.
- **Recordings live on disk**, and free tiers reset the filesystem on redeploy. Attach a
  disk and point `DATA_DIR` at it to keep them. Live lectures are unaffected.
- **Rooms are in memory.** Restarting the server ends any live lecture. Fine on one
  instance; more than one would need shared state.
- **Speech recognition requires HTTPS** (or localhost). Render provides it.

### Never commit secrets

`.gitignore` excludes `.env` and every `.env.*` variant, and re-includes `.env.example`.
Verify before pushing:

```bash
git status --porcelain | grep -E "\.env$"
```

That must print nothing. Keys belong in Render's dashboard.

---

## What the provider actually does

Three things were measured rather than assumed, and each changed a default.

**Bigger models were worse here.** On a ~400-token structured generation,
`Qwen3-30B-A3B-Instruct-2507` returns clean JSON in ~9s. `Qwen3-235B-A22B` and
`Qwen3.5-27B` both spent their entire token budget on internal reasoning and returned an
**empty string**. So one model does every job. That also sidesteps the provider's
model-switching throttle, which 429s when a key hops between deployments. Re-measure on
your own plan with `npm run bench`.

**The plan caps concurrency at 4.** `/v1/plan` reports it. One utterance fans out to every
language in the room simultaneously, so a lecture with four languages is at the ceiling
before anything else asks. Requests go through a gate that queues rather than 429s, and the
automatic diagram proposer stands down whenever the gate is busy — a speculative diagram
must never sit in front of the sentence a student is waiting to hear. `/api/health` reports
gate pressure, so "the demo felt slow" is diagnosable.

**Don't validate a key by listing models.** `/v1/models` is a 7.7 MB response covering
40,000+ models and takes several seconds. Using it as a health check makes a perfectly good
key look broken. `npm run doctor` authenticates with a two-token completion instead.

## Which sponsor tools are used, and which are not

**Used, because they do the job:** Featherless (translation, glossary extraction, term
scouting, diagram specs), Wolfram (plot rendering and computation), Firecrawl (course
material → glossary), Render (hosting).

**Not used:** ProtoFlow is an AI PCB schematic tool, Momen is a no-code app builder, and
Perfect Corp makes beauty and AR SDKs. None of them solve a problem this product has.
Wiring a PCB designer into a lecture translator to collect a logo would be a worse project,
not a better one.

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
