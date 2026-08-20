import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
  RunText,
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

function Setup({
  onStarted,
}: {
  onStarted: (lecture: LectureMeta, glossary: GlossaryTerm[]) => void;
}) {
  const [title, setTitle] = useState('Eigenvalues and eigenvectors');
  const [course, setCourse] = useState('MA201');
  const [instructor, setInstructor] = useState('');
  const [instructionLang, setInstructionLang] = useState<LangCode>('en');
  const [packs, setPacks] = useState<
    Array<{ id: string; name: string; description: string; termCount: number }>
  >([]);
  const [selected, setSelected] = useState<string[]>(['linear-algebra']);
  const [extra, setExtra] = useState('');

  const [importUrl, setImportUrl] = useState('');
  const [importText, setImportText] = useState('');
  const [importing, setImporting] = useState(false);
  const [imported, setImported] = useState<GlossaryTerm[]>([]);
  const [importError, setImportError] = useState<string | null>(null);

  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.packs().then(setPacks).catch(() => setPacks([]));
  }, []);

  const togglePack = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));

  const runImport = async () => {
    setImporting(true);
    setImportError(null);
    try {
      const { terms } = await api.buildGlossary({
        url: importUrl.trim() || undefined,
        text: importText.trim() || undefined,
        subject: title,
      });
      setImported(terms);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImporting(false);
    }
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const extraTerms = [
        ...extra.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
        ...imported.map((t) => t.term),
      ];

      const { lecture, glossary } = await api.createLecture({
        title: title.trim() || 'Untitled lecture',
        course: course.trim(),
        instructor: instructor.trim(),
        instructionLang,
        packIds: selected,
        extraTerms,
      });

      // Imported terms carry aliases the plain extraTerms path cannot express,
      // so they are pushed as a full glossary update rather than as bare
      // strings. Aliases are what catch the term when speech recognition
      // mangles it, which is most of the time.
      if (imported.length > 0) {
        const merged = [...imported, ...glossary];
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

  const totalTerms =
    packs.filter((p) => selected.includes(p.id)).reduce((n, p) => n + p.termCount, 0) +
    imported.length;

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="mb-1 text-2xl font-bold text-ink-100">Start a lecture</h1>
      <p className="mb-8 text-ink-400">
        Everything here decides one thing: which words must survive translation untouched.
      </p>

      <Card className="mb-5 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Lecture title" value={title} onChange={(e) => setTitle(e.target.value)} />
          <Field label="Course code" value={course} onChange={(e) => setCourse(e.target.value)} />
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
          <p className="mt-2 text-xs text-ink-500">
            Technical terms will be preserved in this language for every student, whatever they
            listen in.
          </p>
        </div>
      </Card>

      <Card className="mb-5 p-5">
        <h2 className="mb-1 font-semibold text-ink-100">Vocabulary to protect</h2>
        <p className="mb-4 text-sm text-ink-400">
          Terms in these packs are lifted out before translation and put back afterwards.
        </p>

        <div className="grid gap-2 sm:grid-cols-2">
          {packs.map((pack) => {
            const on = selected.includes(pack.id);
            return (
              <button
                key={pack.id}
                type="button"
                onClick={() => togglePack(pack.id)}
                aria-pressed={on}
                className={`rounded-lg border p-3 text-left transition-colors ${
                  on
                    ? 'border-term-500 bg-term-900/40'
                    : 'border-ink-600 bg-ink-800 hover:border-ink-500'
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

        <div className="mt-4">
          <label htmlFor="extra" className="mb-1.5 block text-sm font-medium text-ink-300">
            Additional terms
          </label>
          <textarea
            id="extra"
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            rows={2}
            placeholder="Rayleigh quotient, Gram–Schmidt, spectral radius"
            className="w-full rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none"
          />
          <p className="mt-1 text-xs text-ink-400">Separated by commas or new lines.</p>
        </div>
      </Card>

      <Card className="mb-5 p-5">
        <h2 className="mb-1 font-semibold text-ink-100">
          Build from your course material{' '}
          <span className="text-sm font-normal text-ink-400">— optional</span>
        </h2>
        <p className="mb-4 text-sm text-ink-400">
          Point this at a syllabus or notes page and it extracts the vocabulary, including the
          ways speech recognition tends to mishear each term.
        </p>

        <div className="grid gap-3">
          <Field
            label="Course page URL"
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            placeholder="https://…"
          />
          <div>
            <label htmlFor="paste" className="mb-1.5 block text-sm font-medium text-ink-300">
              …or paste the text
            </label>
            <textarea
              id="paste"
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-sm text-ink-100 focus:border-brand-500 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-3">
            <Button
              onClick={runImport}
              disabled={importing || (!importUrl.trim() && !importText.trim())}
            >
              {importing ? 'Extracting…' : 'Extract terms'}
            </Button>
            {imported.length > 0 && (
              <Badge tone="ok">{imported.length} terms found</Badge>
            )}
          </div>
          {importError && <p className="text-sm text-live-500">{importError}</p>}
          {imported.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {imported.slice(0, 24).map((t) => (
                <span key={t.id} className="rounded bg-term-900 px-2 py-0.5 text-xs text-term-400">
                  {t.term}
                </span>
              ))}
              {imported.length > 24 && (
                <span className="px-1 text-xs text-ink-500">+{imported.length - 24} more</span>
              )}
            </div>
          )}
        </div>
      </Card>

      {error && <p className="mb-4 text-sm text-live-500">{error}</p>}

      <div className="flex items-center gap-4">
        <Button variant="primary" size="lg" onClick={start} disabled={starting}>
          {starting ? 'Starting…' : 'Start lecture'}
        </Button>
        <p className="text-sm text-ink-400">{totalTerms} terms will be protected</p>
      </div>

      {!isRecognitionSupported() && (
        <p className="mt-4 text-sm text-brand-400">
          This browser cannot capture speech. Use Chrome or Edge to teach; students can listen in
          any browser.
        </p>
      )}
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
      <header className="sticky top-0 z-10 border-b border-ink-800 bg-ink-950/95 px-4 py-3 backdrop-blur">
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
                      <code className="mt-2 block overflow-x-auto rounded bg-ink-950 px-2 py-1 text-xs text-term-400">
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
            className="max-h-[calc(100vh-20rem)] min-h-[18rem] overflow-y-auto rounded-xl border border-ink-800 bg-ink-900/40 p-4"
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
