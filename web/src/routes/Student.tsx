import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  LANGUAGES,
  type GlossaryTerm,
  type LangCode,
  type LectureMeta,
  type ServerMessage,
  type SpeechRun,
  type Translation,
  type Utterance,
  type VizSpec,
} from '@suvidha/shared';
import { LectureSocket, type SocketState } from '../lib/ws';
import {
  SpeechQueue,
  isSpeechSupported,
  loadVoices,
  reportVoices,
  unlockAudio,
  type VoiceReport,
} from '../lib/tts';
import {
  Badge,
  Button,
  Card,
  ConnectionWarning,
  LangPicker,
  LiveDot,
  LiveRegion,
  RunText,
} from '../components/ui';

/**
 * The student's view.
 *
 * One rule shaped this screen: the student is trying to follow a lecture, not
 * operate software. Everything that is not the professor's words is small,
 * quiet, and out of the way. The controls that do exist - language, audio,
 * catch-up - are the ones a person reaches for mid-sentence without looking.
 */

/**
 * Sample sentences for the audio test, one per language.
 *
 * Deliberately the real output shape - explanation in the student's language,
 * terms in the language of instruction - so the test exercises the two-voice
 * path rather than a single voice reading a canned phrase. If the terms come
 * out in the wrong voice, this is where it shows.
 */
const SAMPLE_LINES: Record<LangCode, (instruction: LangCode) => SpeechRun[]> = {
  hi: (i) => [
    { lang: 'hi', text: 'यह एक ', isTerm: false },
    { lang: i, text: 'matrix', isTerm: true },
    { lang: 'hi', text: ' है, और इसका ', isTerm: false },
    { lang: i, text: 'eigenvalue', isTerm: true },
    { lang: 'hi', text: ' दो है।', isTerm: false },
  ],
  bn: (i) => [
    { lang: 'bn', text: 'এটি একটি ', isTerm: false },
    { lang: i, text: 'matrix', isTerm: true },
    { lang: 'bn', text: ', এবং এর ', isTerm: false },
    { lang: i, text: 'eigenvalue', isTerm: true },
    { lang: 'bn', text: ' দুই।', isTerm: false },
  ],
  fr: (i) => [
    { lang: 'fr', text: 'Voici une ', isTerm: false },
    { lang: i, text: 'matrix', isTerm: true },
    { lang: 'fr', text: ', et son ', isTerm: false },
    { lang: i, text: 'eigenvalue', isTerm: true },
    { lang: 'fr', text: ' vaut deux.', isTerm: false },
  ],
  en: () => [
    { lang: 'en', text: 'This is a ', isTerm: false },
    { lang: 'en', text: 'matrix', isTerm: true },
    { lang: 'en', text: ', and its ', isTerm: false },
    { lang: 'en', text: 'eigenvalue', isTerm: true },
    { lang: 'en', text: ' is two.', isTerm: false },
  ],
};

interface Line {
  utterance: Utterance;
  translation?: Translation;
  /** Subtitle text arriving while the translation is still being generated. */
  partial?: string;
}

export default function Student() {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();

  const [lang, setLang] = useState<LangCode>(() => {
    const saved = localStorage.getItem('suvidha:lang');
    return saved && saved in LANGUAGES ? (saved as LangCode) : 'hi';
  });

  const [joined, setJoined] = useState(false);
  const [lecture, setLecture] = useState<LectureMeta | null>(null);
  const [glossary, setGlossary] = useState<GlossaryTerm[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [interim, setInterim] = useState('');
  const [socketState, setSocketState] = useState<SocketState>('closed');
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  const [audioOn, setAudioOn] = useState(false);
  const [rate, setRate] = useState(1.05);
  const [depth, setDepth] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [voices, setVoices] = useState<VoiceReport[]>([]);
  const [showOriginal, setShowOriginal] = useState(true);
  const [visual, setVisual] = useState<VizSpec | null>(null);
  const [silentLangs, setSilentLangs] = useState<LangCode[]>([]);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const socketRef = useRef<LectureSocket | null>(null);
  const queueRef = useRef<SpeechQueue | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const langRef = useRef(lang);
  langRef.current = lang;

  /* ---------------------------------------------------------------- *
   * Speech queue
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const queue = new SpeechQueue({
      onDepthChange: setDepth,
      onDrop: (_id, reason) => {
        if (reason === 'behind') setDropped((n) => n + 1);
      },
      onVoiceMissing: (missing) =>
        setSilentLangs((prev) => (prev.includes(missing) ? prev : [...prev, missing])),
      onSpeechError: setSpeechError,
    });
    // The queue must start in the same state the button claims it is in.
    // Audio begins off - both because `audioOn` starts false and because a
    // student who has not opted in should not have a lecture start playing at
    // them - and leaving the queue enabled would have it swallowing
    // translations, counting them as dropped, and calling speak() behind a
    // control that says "Audio off".
    queue.setEnabled(false);
    queueRef.current = queue;
    return () => {
      queue.dispose();
      queueRef.current = null;
    };
  }, []);

  useEffect(() => {
    queueRef.current?.setRate(rate);
  }, [rate]);

  // Voice availability is checked for the chosen language *and* the language of
  // instruction, because a sentence needs both: one voice for the explanation
  // and one for the terms embedded in it.
  useEffect(() => {
    if (!isSpeechSupported()) return;
    let cancelled = false;
    loadVoices().then(() => {
      if (cancelled) return;
      const needed: LangCode[] = [lang];
      if (lecture && !needed.includes(lecture.instructionLang)) {
        needed.push(lecture.instructionLang);
      }
      setVoices(reportVoices(needed));
    });
    return () => {
      cancelled = true;
    };
  }, [lang, lecture]);

  /* ---------------------------------------------------------------- *
   * Socket
   * ---------------------------------------------------------------- */

  const handleMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'joined':
        setLecture(msg.lecture);
        setGlossary(msg.glossary);
        setJoined(true);
        setError(null);
        break;

      case 'glossary':
        setGlossary(msg.glossary);
        break;

      case 'error':
        setError(msg.message);
        break;

      case 'utterance':
        if (!msg.utterance.final) {
          setInterim(msg.utterance.text);
          return;
        }
        setInterim('');
        setLines((prev) => {
          if (prev.some((l) => l.utterance.id === msg.utterance.id)) return prev;
          // A lecture runs for an hour; keeping every line in the DOM makes the
          // page progressively slower exactly when it must not be.
          return [...prev, { utterance: msg.utterance }].slice(-120);
        });
        break;

      case 'translation-partial':
        if (msg.lang !== langRef.current) return;
        setLines((prev) =>
          prev.map((line) =>
            line.utterance.id === msg.utteranceId && !line.translation
              ? { ...line, partial: msg.text }
              : line,
          ),
        );
        break;

      case 'translation':
        if (msg.translation.lang !== langRef.current) return;
        setLines((prev) =>
          prev.map((line) =>
            line.utterance.id === msg.translation.utteranceId
              ? { ...line, translation: msg.translation }
              : line,
          ),
        );
        queueRef.current?.enqueue({
          id: `${msg.translation.utteranceId}:${msg.translation.lang}`,
          runs: msg.translation.runs,
        });
        break;

      case 'viz':
        if (msg.viz.status === 'approved') setVisual(msg.viz);
        break;

      case 'lecture-ended':
        setEnded(true);
        break;
    }
  }, []);

  useEffect(() => {
    if (!code) return;

    const socket = new LectureSocket({
      onMessage: handleMessage,
      onStateChange: setSocketState,
    });
    socketRef.current = socket;

    const join = { type: 'student:join' as const, lectureId: code.toUpperCase(), lang: langRef.current };
    socket.setRejoin(join);
    socket.connect();
    socket.send(join);

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, [code, handleMessage]);

  /* ---------------------------------------------------------------- *
   * Actions
   * ---------------------------------------------------------------- */

  const changeLang = (next: LangCode) => {
    setLang(next);
    localStorage.setItem('suvidha:lang', next);
    // Anything already queued is in the old language and would be jarring.
    queueRef.current?.clear();
    queueRef.current?.resetDiagnostics();
    setDropped(0);
    setSilentLangs([]);
    setSpeechError(null);
    socketRef.current?.send({ type: 'student:set-lang', lang: next });
    socketRef.current?.setRejoin({
      type: 'student:join',
      lectureId: (code ?? '').toUpperCase(),
      lang: next,
    });
  };

  const toggleAudio = () => {
    const next = !audioOn;
    setAudioOn(next);
    if (next) {
      // Browsers require a user gesture before synthesis makes sound. This
      // click is that gesture.
      unlockAudio();
      queueRef.current?.setEnabled(true);
    } else {
      queueRef.current?.setEnabled(false);
    }
  };

  /**
   * Speaks a sample line in the chosen language.
   *
   * Exists because "no sound" has several causes that look identical from the
   * student's seat - audio not switched on, no voice for the language, the
   * professor simply not talking yet - and a student mid-lecture has no way to
   * tell them apart. One button that either produces sound or explains why
   * removes the guesswork before it matters.
   */
  const testAudio = () => {
    unlockAudio();
    setTesting(true);
    setSpeechError(null);
    queueRef.current?.resetDiagnostics();
    setSilentLangs([]);

    const instruction = lecture?.instructionLang ?? 'en';
    const sample = SAMPLE_LINES[lang] ?? SAMPLE_LINES.en;
    const wasEnabled = audioOn;
    queueRef.current?.setEnabled(true);
    queueRef.current?.enqueue({
      id: `test-${Date.now()}`,
      runs: sample(instruction),
    });
    window.setTimeout(() => {
      setTesting(false);
      if (!wasEnabled) queueRef.current?.setEnabled(false);
    }, 4000);
  };

  // Auto-scroll, but only when the reader is already at the bottom. Yanking the
  // view away from someone re-reading a sentence they missed is the fastest way
  // to make them give up on the tool.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [lines, interim]);

  const activeGlossary = useMemo(
    () => glossary.filter((t) => t.gloss?.[lang] || t.gloss?.en).slice(0, 40),
    [glossary, lang],
  );

  const latest = lines[lines.length - 1];
  const missingVoice = voices.find((v) => v.status === 'missing');

  /* ---------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------- */

  if (!code) {
    return (
      <div className="mx-auto max-w-md p-8">
        <p className="mb-4 text-ink-300">No lecture code.</p>
        <Button onClick={() => navigate('/')}>Go back</Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col bg-ink-950">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-ink-800 bg-ink-950/95 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {!ended && socketState === 'open' && <LiveDot />}
              <h1 className="truncate text-sm font-semibold text-ink-100">
                {lecture?.title ?? `Lecture ${code.toUpperCase()}`}
              </h1>
            </div>
            <p className="truncate text-xs text-ink-400">
              {ended
                ? 'This lecture has ended'
                : socketState === 'open'
                  ? [lecture?.course, lecture?.instructor].filter(Boolean).join(' · ') || 'Connected'
                  : socketState === 'reconnecting'
                    ? 'Reconnecting…'
                    : 'Connecting…'}
            </p>
          </div>

          <Button
            onClick={toggleAudio}
            variant={audioOn ? 'primary' : 'secondary'}
            aria-pressed={audioOn}
          >
            {audioOn ? '🔊 Audio on' : '🔇 Audio off'}
          </Button>
        </div>
      </header>

      <div className="mx-auto w-full max-w-4xl flex-1 px-4 py-4">
        <ConnectionWarning />

        {error && (
          <Card className="mb-4 border-live-500/40 bg-live-500/5 p-4">
            <p className="text-sm text-live-500">{error}</p>
            <Button className="mt-3" size="sm" onClick={() => navigate('/')}>
              Back to home
            </Button>
          </Card>
        )}

        {/* Language + controls */}
        <Card className="mb-4 p-4">
          <LangPicker
            value={lang}
            onChange={changeLang}
            exclude={[]}
            label="Listen in"
            size="sm"
          />

          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3 border-t border-ink-800 pt-4">
            <label className="flex items-center gap-2 text-sm text-ink-300">
              <span>Speed</span>
              <input
                type="range"
                min={0.7}
                max={1.6}
                step={0.05}
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
                className="w-28 accent-brand-500"
                aria-label="Speech speed"
              />
              <span className="w-10 font-mono text-xs text-ink-400">{rate.toFixed(2)}×</span>
            </label>

            <label className="flex items-center gap-2 text-sm text-ink-300">
              <input
                type="checkbox"
                checked={showOriginal}
                onChange={(e) => setShowOriginal(e.target.checked)}
                className="accent-brand-500"
              />
              Show what the professor said
            </label>

            <button
              onClick={testAudio}
              disabled={testing}
              className="text-sm font-medium text-brand-400 underline disabled:opacity-50"
            >
              {testing ? 'Playing…' : 'Test audio'}
            </button>

            {depth > 1 && (
              <button
                onClick={() => queueRef.current?.skipToLatest()}
                className="text-sm font-medium text-brand-400 underline"
              >
                Skip to live ({depth} waiting)
              </button>
            )}
          </div>
        </Card>

        {/* Audio status. The loudest thing on the page when it is wrong. */}
        {(silentLangs.length > 0 || (audioOn && missingVoice)) && (
          <Card className="mb-4 border-live-500/50 bg-live-500/10 p-4">
            <p className="text-sm font-semibold text-live-500">
              🔇 You will not hear{' '}
              {(silentLangs.length > 0 ? silentLangs : [lang])
                .map((l) => LANGUAGES[l].name)
                .join(' or ')}{' '}
              on this device
            </p>
            <p className="mt-1.5 text-sm text-ink-200">
              This device has no {LANGUAGES[lang].name} voice installed, so speech
              synthesis produces silence. The subtitles below are complete and correct —
              nothing is missing from them.
            </p>
            <p className="mt-2 text-xs text-ink-400">
              A phone almost always has the voice. Open this same link on Android or iOS.
              On Windows: Settings → Time &amp; language → Language &amp; region → Add a
              language, and tick <strong>Speech</strong>.
            </p>
          </Card>
        )}

        {speechError && (
          <Card className="mb-4 border-brand-500/40 bg-brand-500/5 p-3">
            <p className="text-sm text-brand-400">Speech engine reported: {speechError}</p>
          </Card>
        )}
        {dropped > 0 && (
          <p className="mb-3 text-xs text-ink-500">
            {dropped} {dropped === 1 ? 'sentence was' : 'sentences were'} skipped to stay with the
            professor.
          </p>
        )}

        {/* Visualisation */}
        {visual && (
          <Card className="mb-4 overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-ink-800 px-4 py-2">
              <h2 className="text-sm font-medium text-ink-200">{visual.title}</h2>
              <button
                onClick={() => setVisual(null)}
                className="text-xs text-ink-400 hover:text-ink-200"
                aria-label="Dismiss diagram"
              >
                ✕
              </button>
            </div>
            {visual.rendered && (
              <img
                src={visual.rendered}
                alt={visual.altText[lang] ?? visual.altText.en ?? visual.title}
                className="w-full bg-white"
              />
            )}
            {/* The description is shown, not just attached as alt text: a
                sighted student following a second language benefits from it
                too, and it proves the accessibility path actually works. */}
            {(visual.altText[lang] ?? visual.altText.en) && (
              <p
                className="px-4 py-3 text-sm text-ink-300"
                lang={visual.altText[lang] ? lang : 'en'}
                data-lang={visual.altText[lang] ? lang : 'en'}
              >
                {visual.altText[lang] ?? visual.altText.en}
              </p>
            )}
          </Card>
        )}

        {/* Transcript */}
        <div
          ref={scrollRef}
          className="max-h-[calc(100vh-22rem)] min-h-[16rem] overflow-y-auto rounded-xl border border-ink-800 bg-ink-900/40 p-4"
        >
          {lines.length === 0 && !interim && (
            <p className="py-12 text-center text-ink-500">
              {ended ? 'The lecture has ended.' : 'Waiting for the professor to speak…'}
            </p>
          )}

          <div className="space-y-5">
            {lines.map((line) => (
              <article key={line.utterance.id}>
                {line.translation ? (
                  <p
                    className="text-xl leading-relaxed text-ink-100 sm:text-2xl"
                    lang={lang}
                    data-lang={lang}
                  >
                    <RunText runs={line.translation.runs} />
                  </p>
                ) : line.partial ? (
                  /* Arriving live. Shown at full contrast because it is real
                     translated text, not a placeholder - only the trailing
                     cursor signals that more is coming. */
                  <p
                    className="text-xl leading-relaxed text-ink-100 sm:text-2xl"
                    lang={lang}
                    data-lang={lang}
                  >
                    {line.partial}
                    <span className="ml-0.5 inline-block h-5 w-2 translate-y-0.5 animate-pulse bg-brand-500/70" />
                  </p>
                ) : (
                  <p className="text-xl leading-relaxed text-ink-500 sm:text-2xl">
                    {line.utterance.text}
                    <span className="ml-2 align-middle text-xs text-ink-600">translating…</span>
                  </p>
                )}

                {showOriginal && line.translation && (
                  <p className="mt-1.5 text-sm text-ink-500" lang={lecture?.instructionLang ?? 'en'}>
                    {line.utterance.text}
                  </p>
                )}

                {line.translation?.engine === 'fallback' && (
                  <p className="mt-1 text-xs text-brand-500/70">
                    Shown in the original — translation was unavailable for this line.
                  </p>
                )}
              </article>
            ))}

            {interim && (
              <p className="text-xl leading-relaxed text-ink-600 italic sm:text-2xl">{interim}</p>
            )}
          </div>
        </div>

        {/* Terms */}
        {activeGlossary.length > 0 && (
          <Card className="mt-4 p-4">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-200">
              <Badge tone="term">Terms</Badge>
              <span className="font-normal text-ink-400">
                kept in {LANGUAGES[lecture?.instructionLang ?? 'en'].name}, explained in{' '}
                <span lang={lang} data-lang={lang}>
                  {LANGUAGES[lang].nativeName}
                </span>
              </span>
            </h2>
            <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {activeGlossary.map((term) => (
                <div key={term.id} className="flex gap-2 text-sm">
                  <dt className="term shrink-0">{term.term}</dt>
                  <dd className="text-ink-400" lang={term.gloss?.[lang] ? lang : 'en'} data-lang={term.gloss?.[lang] ? lang : 'en'}>
                    {term.gloss?.[lang] ?? term.gloss?.en}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        )}
      </div>

      {/* Announced to screen readers without stealing focus. */}
      <LiveRegion>
        {latest?.translation ? latest.translation.text : latest?.utterance.text}
      </LiveRegion>
    </div>
  );
}
