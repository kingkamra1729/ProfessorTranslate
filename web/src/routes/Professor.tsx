import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  LANGUAGES,
  type GlossaryTerm,
  type LangCode,
  type LectureMeta,
  type ServerMessage,
  type TermSuggestion,
  type Translation,
  type Utterance,
  type VizSpec,
} from '@suvidha/shared';
import { api } from '../lib/api';
import { Recognizer, isRecognitionSupported, type RecognizerState } from '../lib/asr';
import { LectureSocket, type SocketState } from '../lib/ws';
import {
  Badge,
  Button,
  Card,
  ConnectionWarning,
  Field,
  LangPicker,
  LiveDot,
  PageHeader,
  RunText,
  Section,
  SegmentedControl,
  Stepper,
  TextArea,
  Wordmark,
} from '../components/ui';

/**
 * The professor's console.
 *
 * Setup happens before the lecture, when there is time to think. Once teaching
 * starts, the screen collapses to the three things that matter mid-sentence:
 * is the microphone actually being heard, how many students are on each
 * language, and is there a diagram waiting for approval.
 */

type Phase = 'setup' | 'live';

export default function Professor() {
  const { code: codeParam } = useParams<{ code: string }>();
  const navigate = useNavigate();

  const [phase, setPhase] = useState<Phase>(codeParam ? 'live' : 'setup');
  const [lecture, setLecture] = useState<LectureMeta | null>(null);
  const [glossary, setGlossary] = useState<GlossaryTerm[]>([]);

  return phase === 'setup' ? (
    <Setup
      onStarted={(meta, terms) => {
        setLecture(meta);
        setGlossary(terms);
        setPhase('live');
        navigate(`/teach/${meta.id}`, { replace: true });
      }}
    />
  ) : (
    <Live
      code={(codeParam ?? lecture?.id ?? '').toUpperCase()}
      initialLecture={lecture}
      initialGlossary={glossary}
    />
  );
}

/* ================================================================== *
 * Setup
 * ================================================================== */

/**
 * How a piece of course material was supplied.
 *
 * The three routes exist because course material lives in three places and a
 * lecturer should not have to convert between them: the notes are a file, the
 * reading list is a page, and the thing they actually want protected is often
 * a paragraph they can type in thirty seconds.
 */
type SourceKind = 'text' | 'url' | 'file';

/** One piece of material the professor has added, and what came out of it. */
interface KnowledgeSource {
  id: string;
  kind: SourceKind;
  /** What to call this in the list: a filename, a host, or "Written notes". */
  label: string;
  charactersRead: number;
  terms: GlossaryTerm[];
}

const SOURCE_OPTIONS: Array<{ value: SourceKind; label: string }> = [
  { value: 'text', label: 'Written notes' },
  { value: 'url', label: 'Web page' },
  { value: 'file', label: 'PDF or document' },
];

function Setup({
  onStarted,
}: {
  onStarted: (lecture: LectureMeta, glossary: GlossaryTerm[]) => void;
}) {
  const [step, setStep] = useState(0);

  /* Step 1 - the lecture itself. */
  const [title, setTitle] = useState('Eigenvalues and eigenvectors');
  const [course, setCourse] = useState('MA201');
  const [instructor, setInstructor] = useState('');
  const [instructionLang, setInstructionLang] = useState<LangCode>('en');
  const [packs, setPacks] = useState<
    Array<{ id: string; name: string; description: string; termCount: number }>
  >([]);
  const [selected, setSelected] = useState<string[]>(['linear-algebra']);
  const [extra, setExtra] = useState('');

  /* Step 2 - the knowledge base. */
  const [kind, setKind] = useState<SourceKind>('text');
  const [draftText, setDraftText] = useState('');
  const [draftUrl, setDraftUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.packs().then(setPacks).catch(() => setPacks([]));
  }, []);

  const togglePack = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));

  /**
   * Every term the knowledge base has produced, first occurrence winning.
   *
   * Two sources covering the same course will overlap heavily - the syllabus
   * and the notes both name the same theorem - and a duplicate entry is not
   * merely untidy: the matcher builds one key per surface form, so the second
   * copy is dead weight that also inflates the count shown to the professor.
   */
  const knowledgeTerms = useMemo(() => {
    const seen = new Set<string>();
    const out: GlossaryTerm[] = [];
    for (const source of sources) {
      for (const term of source.terms) {
        const key = term.term.trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(term);
      }
    }
    return out;
  }, [sources]);

  /** Reads a file as base64 without pulling the whole thing through a string. */
  const readAsBase64 = (f: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that file'));
      reader.onload = () => {
        const result = String(reader.result ?? '');
        // FileReader gives "data:<mime>;base64,<payload>"; the server wants the
        // payload alone.
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.readAsDataURL(f);
    });

  const canRead =
    (kind === 'text' && draftText.trim().length > 0) ||
    (kind === 'url' && draftUrl.trim().length > 0) ||
    (kind === 'file' && file !== null);

  const addSource = async () => {
    setReading(true);
    setReadError(null);
    try {
      const payload: Parameters<typeof api.buildGlossary>[0] = { subject: title };
      let label: string;

      if (kind === 'file' && file) {
        payload.file = { name: file.name, base64: await readAsBase64(file) };
        label = file.name;
      } else if (kind === 'url') {
        payload.url = draftUrl.trim();
        label = draftUrl.trim().replace(/^https?:\/\//, '');
      } else {
        payload.text = draftText.trim();
        label = 'Written notes';
      }

      const { terms, info } = await api.buildGlossary(payload);
      setSources((prev) => [
        ...prev,
        {
          id: `${kind}-${Date.now()}`,
          kind,
          label,
          charactersRead: info.charactersRead,
          terms,
        },
      ]);

      // Clear only the input that was just consumed, so adding a second source
      // of the same kind starts from empty rather than from the last one.
      if (kind === 'file') setFile(null);
      if (kind === 'url') setDraftUrl('');
      if (kind === 'text') setDraftText('');
    } catch (err) {
      setReadError(err instanceof Error ? err.message : 'Could not read that material');
    } finally {
      setReading(false);
    }
  };

  const removeSource = (id: string) =>
    setSources((prev) => prev.filter((source) => source.id !== id));

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const extraTerms = [
        ...extra.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
        ...knowledgeTerms.map((t) => t.term),
      ];

      const { lecture, glossary } = await api.createLecture({
        title: title.trim() || 'Untitled lecture',
        course: course.trim(),
        instructor: instructor.trim(),
        instructionLang,
        packIds: selected,
        extraTerms,
      });

      // Knowledge-base terms carry aliases the plain extraTerms path cannot
      // express, so they are pushed as a full glossary update rather than as
      // bare strings. Aliases are what catch the term when speech recognition
      // mangles it, which is most of the time.
      if (knowledgeTerms.length > 0) {
        const merged = [...knowledgeTerms, ...glossary];
        await api.updateGlossary(lecture.id, merged);
        onStarted(lecture, merged);
      } else {
        onStarted(lecture, glossary);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the lecture');
      setStarting(false);
    }
  };

  const packTerms = packs
    .filter((p) => selected.includes(p.id))
    .reduce((n, p) => n + p.termCount, 0);
  const totalTerms = packTerms + knowledgeTerms.length;

  return (
    <div className="min-h-full bg-ink-950">
      <header className="border-b border-ink-800 bg-ink-900">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-4 px-5 py-4 sm:px-6">
          <Link to="/">
            <Wordmark size="sm" />
          </Link>
          <span className="text-sm text-ink-400">Professor</span>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-10 sm:px-6">
        <Stepper
          steps={['Lecture details', 'Knowledge base']}
          current={step}
          onGo={setStep}
        />

        {step === 0 ? (
          <>
            <PageHeader
              eyebrow="Step 1 of 2"
              title="Lecture details"
              description="These describe the class and decide which vocabulary is protected from translation."
            />

            <div className="grid gap-4">
              <Section
                title="The class"
                description="Shown to students when they join, so they know they are in the right lecture."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="Lecture title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                  />
                  <Field
                    label="Course code"
                    value={course}
                    onChange={(e) => setCourse(e.target.value)}
                  />
                  <Field
                    label="Your name"
                    value={instructor}
                    onChange={(e) => setInstructor(e.target.value)}
                    placeholder="Dr. Rao"
                  />
                </div>

                <div className="mt-5 border-t border-ink-800 pt-5">
                  <LangPicker
                    value={instructionLang}
                    onChange={setInstructionLang}
                    label="I will be speaking in"
                    size="sm"
                  />
                  <p className="mt-2 text-xs text-ink-400">
                    Technical terms are preserved in this language for every student, whatever
                    they listen in.
                  </p>
                </div>
              </Section>

              <Section
                title="Vocabulary to protect"
                description="Terms in the packs you select are lifted out before translation and put back afterwards, so the model never has the chance to render them."
                aside={<Badge tone="term">{packTerms} terms</Badge>}
              >
                <div className="grid gap-2 sm:grid-cols-2">
                  {packs.map((pack) => {
                    const on = selected.includes(pack.id);
                    return (
                      <button
                        key={pack.id}
                        type="button"
                        onClick={() => togglePack(pack.id)}
                        aria-pressed={on}
                        className={`rounded-md border p-3 text-left transition-colors ${
                          on
                            ? 'border-term-500 bg-term-900/50'
                            : 'border-ink-600 bg-ink-900 hover:border-ink-500'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-medium text-ink-100">{pack.name}</span>
                          <span className="shrink-0 text-xs text-ink-400">{pack.termCount}</span>
                        </div>
                        <p className="mt-1 text-xs text-ink-400">{pack.description}</p>
                      </button>
                    );
                  })}
                </div>

                <TextArea
                  className="mt-4"
                  label="Additional terms"
                  value={extra}
                  onChange={(e) => setExtra(e.target.value)}
                  rows={2}
                  placeholder="Rayleigh quotient, Gram–Schmidt, spectral radius"
                  hint="Separated by commas or new lines."
                />
              </Section>
            </div>

            <div className="mt-8 flex items-center justify-between gap-4 border-t border-ink-800 pt-6">
              <Link to="/" className="text-sm text-ink-400 hover:text-ink-100">
                &larr; Back
              </Link>
              <Button variant="primary" size="lg" onClick={() => setStep(1)}>
                Continue to knowledge base
              </Button>
            </div>
          </>
        ) : (
          <>
            <PageHeader
              eyebrow="Step 2 of 2"
              title="Knowledge base"
              description="Anything you add here is read before the class starts, so the system knows what this lecture is about. It learns the subject vocabulary — including the ways speech recognition tends to mishear each term — and protects it, which is what lets a student follow the explanation without losing the words the textbook uses."
            />

            <div className="grid gap-4">
              <Section
                eyebrow="Optional"
                title="Add course material"
                description="Three ways in. Add as many as you like — a syllabus and last week's notes together give a better picture than either alone."
              >
                <SegmentedControl
                  label="How to supply the material"
                  value={kind}
                  onChange={(next) => {
                    setKind(next);
                    setReadError(null);
                  }}
                  options={SOURCE_OPTIONS}
                />

                <div className="mt-5">
                  {kind === 'text' && (
                    <TextArea
                      label="Paste or type the material"
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                      rows={7}
                      placeholder="Today we cover eigenvalues and eigenvectors, the characteristic polynomial, and diagonalisation. Reading: Strang chapter 6."
                      hint="A lecture plan, an abstract, a reading list — anything that names the concepts this class will use."
                    />
                  )}

                  {kind === 'url' && (
                    <Field
                      label="Course page or syllabus URL"
                      value={draftUrl}
                      onChange={(e) => setDraftUrl(e.target.value)}
                      placeholder="https://example.edu/courses/ma201/week-6"
                      type="url"
                      inputMode="url"
                      hint="The page is fetched and read as text. It has to be publicly reachable — a page behind a login will come back empty."
                    />
                  )}

                  {kind === 'file' && (
                    <div>
                      <label
                        htmlFor="course-file"
                        className="mb-1.5 block text-sm font-medium text-ink-300"
                      >
                        Upload lecture notes or a syllabus
                      </label>
                      <input
                        id="course-file"
                        type="file"
                        accept=".pdf,.txt,.md,.markdown,.csv,.tsv,.html,.htm,.rtf,.tex"
                        onChange={(e) => {
                          setFile(e.target.files?.[0] ?? null);
                          setReadError(null);
                        }}
                        className="block w-full rounded-md border border-ink-600 bg-ink-900 text-sm text-ink-300 file:mr-3 file:border-0 file:border-r file:border-ink-600 file:bg-ink-800 file:px-4 file:py-2.5 file:text-sm file:font-medium file:text-ink-200 hover:file:bg-ink-700"
                      />
                      <p className="mt-1.5 text-xs text-ink-400">
                        PDF, Markdown or plain text. A scanned PDF has no text in it — reading
                        those from photographs is a later feature.
                      </p>
                      {file && (
                        <p className="mt-2 text-xs text-term-400">
                          {file.name} · {(file.size / 1024).toFixed(0)} kB
                          <button
                            type="button"
                            onClick={() => setFile(null)}
                            className="ml-2 text-ink-400 underline hover:text-ink-200"
                          >
                            remove
                          </button>
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-ink-800 pt-5">
                  <Button
                    variant="secondary"
                    onClick={addSource}
                    disabled={reading || !canRead}
                  >
                    {reading ? 'Reading…' : 'Read and add'}
                  </Button>
                  <p className="text-xs text-ink-400">
                    Nothing is sent to students. This only builds the term list.
                  </p>
                </div>

                {readError && <p className="mt-3 text-sm text-live-500">{readError}</p>}
              </Section>

              {sources.length > 0 && (
                <Section
                  title="In the knowledge base"
                  description="Terms found here are protected for the whole lecture and shown to students in the term list."
                  aside={<Badge tone="ok">{knowledgeTerms.length} terms</Badge>}
                >
                  <ul className="divide-y divide-ink-800 border-y border-ink-800">
                    {sources.map((source) => (
                      <li
                        key={source.id}
                        className="flex items-center justify-between gap-4 py-3"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-ink-100">
                            {source.label}
                          </p>
                          <p className="text-xs text-ink-400">
                            {SOURCE_OPTIONS.find((o) => o.value === source.kind)?.label} ·{' '}
                            {source.terms.length} terms ·{' '}
                            {source.charactersRead.toLocaleString()} characters read
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeSource(source.id)}
                          className="shrink-0 text-sm text-ink-400 underline hover:text-live-500"
                        >
                          Remove
                        </button>
                      </li>
                    ))}
                  </ul>

                  {knowledgeTerms.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-1.5">
                      {knowledgeTerms.slice(0, 28).map((t) => (
                        <span
                          key={t.id}
                          className="rounded bg-term-900 px-2 py-0.5 text-xs text-term-400"
                        >
                          {t.term}
                        </span>
                      ))}
                      {knowledgeTerms.length > 28 && (
                        <span className="px-1 text-xs text-ink-500">
                          +{knowledgeTerms.length - 28} more
                        </span>
                      )}
                    </div>
                  )}
                </Section>
              )}
            </div>

            {error && <p className="mt-5 text-sm text-live-500">{error}</p>}

            {!isRecognitionSupported() && (
              <p className="mt-5 text-sm text-brand-500">
                This browser cannot capture speech. Use Chrome or Edge to teach; students can
                listen in any browser.
              </p>
            )}

            <div className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t border-ink-800 pt-6">
              <button
                type="button"
                onClick={() => setStep(0)}
                className="text-sm text-ink-400 hover:text-ink-100"
              >
                &larr; Lecture details
              </button>
              <div className="flex items-center gap-4">
                <p className="text-sm text-ink-400">
                  {totalTerms} {totalTerms === 1 ? 'term' : 'terms'} protected
                </p>
                <Button variant="primary" size="lg" onClick={start} disabled={starting}>
                  {starting ? 'Starting…' : sources.length > 0 ? 'Start lecture' : 'Skip and start'}
                </Button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/* ================================================================== *
 * Live
 * ================================================================== */

function Live({
  code,
  initialLecture,
  initialGlossary,
}: {
  code: string;
  initialLecture: LectureMeta | null;
  initialGlossary: GlossaryTerm[];
}) {
  const navigate = useNavigate();

  const [lecture, setLecture] = useState<LectureMeta | null>(initialLecture);
  const [glossary, setGlossary] = useState<GlossaryTerm[]>(initialGlossary);
  const [lines, setLines] = useState<Array<{ utterance: Utterance; sample?: Translation }>>([]);
  const [interim, setInterim] = useState('');
  const [counts, setCounts] = useState<Partial<Record<LangCode, number>>>({});
  const [total, setTotal] = useState(0);
  const [socketState, setSocketState] = useState<SocketState>('closed');
  const [micState, setMicState] = useState<RecognizerState>('idle');
  const [micDetail, setMicDetail] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [proposals, setProposals] = useState<VizSpec[]>([]);
  const [suggestions, setSuggestions] = useState<TermSuggestion[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [vizPrompt, setVizPrompt] = useState('');
  const [ended, setEnded] = useState(false);

  const socketRef = useRef<LectureSocket | null>(null);
  const recognizerRef = useRef<Recognizer | null>(null);
  const startedAt = useRef(Date.now());
  const scrollRef = useRef<HTMLDivElement | null>(null);

  /* ---------------------------------------------------------------- *
   * Socket
   * ---------------------------------------------------------------- */

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'joined':
        setLecture(msg.lecture);
        setGlossary(msg.glossary);
        startedAt.current = msg.lecture.startedAt;
        break;
      case 'glossary':
        setGlossary(msg.glossary);
        break;
      case 'listeners':
        setCounts(msg.counts);
        setTotal(msg.total);
        break;
      case 'utterance':
        if (!msg.utterance.final) {
          setInterim(msg.utterance.text);
          return;
        }
        setInterim('');
        setLines((prev) => {
          if (prev.some((l) => l.utterance.id === msg.utterance.id)) return prev;
          return [...prev, { utterance: msg.utterance }].slice(-80);
        });
        break;
      case 'translation':
        // The professor sees one rendering per line, as a spot check that terms
        // are surviving. Which language is unimportant; that they are intact is
        // the whole point.
        setLines((prev) =>
          prev.map((l) =>
            l.utterance.id === msg.translation.utteranceId && !l.sample
              ? { ...l, sample: msg.translation }
              : l,
          ),
        );
        break;
      case 'term-suggestions':
        setSuggestions(msg.suggestions);
        // Pre-selected: the system only proposes what it is fairly confident
        // about, so the common action is "yes, all of them". The professor is
        // mid-sentence and unchecking one is cheaper than checking four.
        setChosen(new Set(msg.suggestions.map((s) => s.term)));
        break;
      case 'viz':
        setProposals((prev) => {
          const next = prev.filter((p) => p.id !== msg.viz.id);
          return msg.viz.status === 'proposed' ? [...next, msg.viz] : next;
        });
        break;
      case 'lecture-ended':
        setEnded(true);
        break;
      case 'error':
        setNotice(msg.message);
        break;
    }
  }, []);

  useEffect(() => {
    if (!code) return;
    const socket = new LectureSocket({ onMessage: handleMessage, onStateChange: setSocketState });
    socketRef.current = socket;
    const join = { type: 'prof:join' as const, lectureId: code };
    socket.setRejoin(join);
    socket.connect();
    socket.send(join);
    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [code, handleMessage]);

  useEffect(() => {
    if (lecture) return;
    api
      .getLecture(code)
      .then((res) => {
        setLecture(res.lecture);
        setGlossary(res.glossary);
      })
      .catch(() => setNotice('That lecture code is not live.'));
  }, [code, lecture]);

  /* ---------------------------------------------------------------- *
   * Microphone
   * ---------------------------------------------------------------- */

  const startMic = () => {
    if (recognizerRef.current) return;
    const rec = new Recognizer(lecture?.instructionLang ?? 'en', {
      onResult: (text, isFinal) => {
        socketRef.current?.send({
          type: 'prof:utterance',
          text,
          final: isFinal,
          t: Date.now() - startedAt.current,
        });
      },
      onStateChange: (state, detail) => {
        setMicState(state);
        setMicDetail(detail ?? null);
      },
      onNotice: setNotice,
    });
    recognizerRef.current = rec;
    rec.start();
  };

  const stopMic = () => {
    recognizerRef.current?.dispose();
    recognizerRef.current = null;
    setMicState('idle');
  };

  useEffect(() => () => recognizerRef.current?.dispose(), []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, interim]);

  /* ---------------------------------------------------------------- *
   * Visuals
   * ---------------------------------------------------------------- */

  const toggleTerm = (term: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(term)) next.delete(term);
      else next.add(term);
      return next;
    });

  const acceptTerms = () => {
    const accepted = suggestions.filter((s) => chosen.has(s.term));
    socketRef.current?.send({ type: 'prof:accept-terms', terms: accepted });
    setSuggestions([]);
    setChosen(new Set());
  };

  const dismissTerms = () => {
    socketRef.current?.send({ type: 'prof:dismiss-terms' });
    setSuggestions([]);
    setChosen(new Set());
  };

  const decide = (viz: VizSpec, approve: boolean) => {
    socketRef.current?.send({ type: 'prof:viz-decision', vizId: viz.id, approve });
    setProposals((prev) => prev.filter((p) => p.id !== viz.id));
  };

  const requestViz = (e: React.FormEvent) => {
    e.preventDefault();
    const prompt = vizPrompt.trim();
    if (!prompt) return;
    socketRef.current?.send({ type: 'prof:request-viz', prompt });
    setVizPrompt('');
  };

  const endLecture = async () => {
    stopMic();
    socketRef.current?.send({ type: 'prof:end' });
  };

  const listening = micState === 'listening' || micState === 'restarting';
  const joinUrl = `${location.origin}/listen/${code}`;

  const langRows = useMemo(
    () =>
      Object.values(LANGUAGES)
        .map((l) => ({ lang: l, count: counts[l.code] ?? 0 }))
        .filter((r) => r.count > 0)
        .sort((a, b) => b.count - a.count),
    [counts],
  );

  /* ---------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------- */

  return (
    <div className="min-h-full bg-ink-950">
      <header className="sticky top-0 z-10 border-b border-ink-800 bg-ink-900/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {listening && <LiveDot />}
              <h1 className="truncate font-semibold text-ink-100">
                {lecture?.title ?? 'Lecture'}
              </h1>
            </div>
            <p className="text-xs text-ink-400">
              {socketState === 'open' ? `${total} listening` : socketState}
              {glossary.length > 0 && ` · ${glossary.length} terms protected`}
            </p>
          </div>

          <div className="text-right">
            <p className="text-xs text-ink-400">Join code</p>
            <p className="font-mono text-2xl tracking-[0.25em] text-brand-500">{code}</p>
          </div>

          {!ended ? (
            <Button variant={listening ? 'danger' : 'primary'} onClick={listening ? stopMic : startMic}>
              {listening ? '⏸ Pause' : '🎙 Start speaking'}
            </Button>
          ) : (
            <Button onClick={() => navigate(`/replay/${code}`)}>View recording</Button>
          )}
        </div>
      </header>

      <div className="mx-auto grid max-w-6xl gap-5 px-4 py-5 lg:grid-cols-[1fr_20rem]">
        <div>
          <ConnectionWarning />

          {notice && (
            <Card className="mb-4 border-brand-500/40 bg-brand-500/5 p-3">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm text-brand-400">{notice}</p>
                <button onClick={() => setNotice(null)} className="text-xs text-ink-400">
                  ✕
                </button>
              </div>
            </Card>
          )}

          {micState === 'error' && micDetail && (
            <Card className="mb-4 border-live-500/40 bg-live-500/5 p-3">
              <p className="text-sm text-live-500">{micDetail}</p>
            </Card>
          )}

          {/* Missing vocabulary caught mid-lecture. */}
          {suggestions.length > 0 && (
            <Card className="mb-4 border-term-500/50 p-4">
              <h2 className="mb-1 text-sm font-semibold text-term-400">
                Heard {suggestions.length === 1 ? 'a term' : 'terms'} not in your glossary
              </h2>
              <p className="mb-3 text-xs text-ink-400">
                Until added, these are translated like ordinary words. Adding one protects it
                for the rest of the lecture.
              </p>

              <div className="space-y-2">
                {suggestions.map((s) => {
                  const on = chosen.has(s.term);
                  return (
                    <label
                      key={s.term}
                      className={`flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${
                        on ? 'border-term-500 bg-term-900/30' : 'border-ink-700 bg-ink-800'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => toggleTerm(s.term)}
                        className="mt-1 accent-term-500"
                      />
                      <span className="min-w-0">
                        <span className="term">{s.term}</span>
                        {s.reason && (
                          <span className="ml-2 text-xs text-ink-400">{s.reason}</span>
                        )}
                        <span className="mt-1 block truncate text-xs text-ink-500 italic">
                          &ldquo;{s.heardIn}&rdquo;
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>

              <div className="mt-3 flex gap-2">
                <Button size="sm" variant="primary" onClick={acceptTerms} disabled={chosen.size === 0}>
                  Protect {chosen.size} {chosen.size === 1 ? 'term' : 'terms'}
                </Button>
                <Button size="sm" variant="ghost" onClick={dismissTerms}>
                  Not now
                </Button>
              </div>
            </Card>
          )}

          {/* Visualisation proposals - nothing reaches students without this. */}
          {proposals.length > 0 && (
            <Card className="mb-4 border-brand-500/40 p-4">
              <h2 className="mb-3 text-sm font-semibold text-brand-400">
                Suggested diagram{proposals.length > 1 ? 's' : ''} — your approval needed
              </h2>
              <div className="space-y-3">
                {proposals.map((viz) => (
                  <div key={viz.id} className="rounded-lg border border-ink-700 bg-ink-800 p-3">
                    <p className="font-medium text-ink-100">{viz.title}</p>
                    {viz.altText.en && (
                      <p className="mt-1 text-sm text-ink-400">{viz.altText.en}</p>
                    )}
                    {viz.expression && (
                      <code className="mt-2 block overflow-x-auto rounded border border-ink-700 bg-ink-900 px-2 py-1 text-xs text-term-400">
                        {viz.expression}
                      </code>
                    )}
                    <div className="mt-3 flex gap-2">
                      <Button size="sm" variant="primary" onClick={() => decide(viz, true)}>
                        Show to class
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => decide(viz, false)}>
                        Dismiss
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <form onSubmit={requestViz} className="mb-4 flex gap-2">
            <input
              value={vizPrompt}
              onChange={(e) => setVizPrompt(e.target.value)}
              placeholder="Ask for a diagram — “plot sin(x)/x from -20 to 20”"
              className="min-w-0 flex-1 rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none"
            />
            <Button type="submit" disabled={!vizPrompt.trim()}>
              Generate
            </Button>
          </form>

          <div
            ref={scrollRef}
            className="max-h-[calc(100vh-20rem)] min-h-[18rem] overflow-y-auto rounded-lg border border-ink-800 bg-ink-900 p-4"
          >
            {lines.length === 0 && !interim && (
              <p className="py-16 text-center text-ink-500">
                {listening
                  ? 'Listening — start speaking.'
                  : 'Press “Start speaking” when you are ready.'}
              </p>
            )}

            <div className="space-y-4">
              {lines.map(({ utterance, sample }) => (
                <article key={utterance.id}>
                  <p className="leading-relaxed text-ink-200">{utterance.text}</p>
                  {sample && (
                    <p
                      className="mt-1 text-sm text-ink-400"
                      lang={sample.lang}
                      data-lang={sample.lang}
                    >
                      <span className="mr-2 text-xs text-ink-600 uppercase">
                        {LANGUAGES[sample.lang].name}
                      </span>
                      <RunText runs={sample.runs} />
                    </p>
                  )}
                </article>
              ))}
              {interim && <p className="leading-relaxed text-ink-600 italic">{interim}</p>}
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <aside className="space-y-4">
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold text-ink-200">Who is listening</h2>
            {langRows.length === 0 ? (
              <p className="text-sm text-ink-500">Nobody has joined yet.</p>
            ) : (
              <ul className="space-y-2">
                {langRows.map(({ lang, count }) => (
                  <li key={lang.code} className="flex items-center justify-between gap-2 text-sm">
                    <span lang={lang.code} data-lang={lang.code} className="text-ink-200">
                      {lang.nativeName}
                    </span>
                    <span className="font-mono text-ink-400">{count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-2 text-sm font-semibold text-ink-200">Share with the class</h2>
            <p className="mb-3 text-xs break-all text-ink-400">{joinUrl}</p>
            <Button
              size="sm"
              className="w-full"
              onClick={() => navigator.clipboard?.writeText(joinUrl)}
            >
              Copy link
            </Button>
          </Card>

          <Card className="p-4">
            <h2 className="mb-2 text-sm font-semibold text-ink-200">
              Protected terms{' '}
              <span className="font-normal text-ink-500">({glossary.length})</span>
            </h2>
            <div className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
              {glossary.slice(0, 60).map((t) => (
                <span key={t.id} className="rounded bg-term-900 px-2 py-0.5 text-xs text-term-400">
                  {t.term}
                </span>
              ))}
            </div>
          </Card>

          {!ended && (
            <Button variant="danger" className="w-full" onClick={endLecture}>
              End lecture &amp; save recording
            </Button>
          )}
        </aside>
      </div>
    </div>
  );
}
