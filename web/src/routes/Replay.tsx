import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  LANGUAGES,
  type LangCode,
  type LectureMeta,
  type LectureRecording,
} from '@suvidha/shared';
import { api } from '../lib/api';
import { SpeechQueue, isSpeechSupported, loadVoices, unlockAudio } from '../lib/tts';
import { Badge, Button, Card, LangPicker, LiveRegion, RunText, Shell } from '../components/ui';

/**
 * Replay.
 *
 * What was archived is text, not audio, and that choice pays off here. A
 * recording of the professor's voice would be fixed in one language forever.
 * A recording of the transcript plus every translation can be re-voiced on
 * demand - in a different language than the student chose during the lecture,
 * at half speed, or by a screen reader instead of by us.
 *
 * For a student who missed the class, or could not see the board, or needed the
 * sentence three more times than the lecture allowed, this is the part of the
 * product they will actually use.
 */

export default function Replay() {
  const { id } = useParams<{ id: string }>();
  return id ? <One id={id} /> : <Index />;
}

/* ================================================================== *
 * Index
 * ================================================================== */

function Index() {
  const [items, setItems] = useState<LectureMeta[] | null>(null);

  useEffect(() => {
    api.recordings().then(setItems).catch(() => setItems([]));
  }, []);

  return (
    <Shell
      title="Recorded lectures"
      subtitle="Replayable in any language, at any speed"
      right={
        <Link to="/" className="text-sm text-ink-300 underline hover:text-ink-100">
          Home
        </Link>
      }
    >
      {items === null && <p className="text-ink-500">Loading…</p>}
      {items?.length === 0 && (
        <Card className="p-8 text-center">
          <p className="text-ink-400">
            No recordings yet. They appear here once a lecture is ended from the professor's
            console.
          </p>
        </Card>
      )}

      <div className="grid gap-2">
        {items?.map((rec) => (
          <Link
            key={rec.id}
            to={`/replay/${rec.id}`}
            className="flex items-center justify-between gap-4 rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 transition-colors hover:border-brand-500/50"
          >
            <div className="min-w-0">
              <p className="truncate font-medium text-ink-100">{rec.title}</p>
              <p className="truncate text-sm text-ink-400">
                {[rec.course, rec.instructor].filter(Boolean).join(' · ')}
                {' — '}
                {new Date(rec.startedAt).toLocaleString()}
              </p>
            </div>
            <span className="shrink-0 text-sm text-ink-500">{rec.utteranceCount ?? 0} lines</span>
          </Link>
        ))}
      </div>
    </Shell>
  );
}

/* ================================================================== *
 * One recording
 * ================================================================== */

function One({ id }: { id: string }) {
  const [rec, setRec] = useState<LectureRecording | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<LangCode>(() => {
    const saved = localStorage.getItem('suvidha:lang');
    return saved && saved in LANGUAGES ? (saved as LangCode) : 'hi';
  });

  const [playing, setPlaying] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [rate, setRate] = useState(1.05);

  const queueRef = useRef<SpeechQueue | null>(null);
  const playingRef = useRef(false);
  const cursorRef = useRef(0);
  const activeRef = useRef<HTMLElement | null>(null);

  playingRef.current = playing;
  cursorRef.current = cursor;

  useEffect(() => {
    api.recording(id).then(setRec).catch((e) => setError(e.message));
  }, [id]);

  useEffect(() => {
    if (isSpeechSupported()) void loadVoices();
  }, []);

  /* ---------------------------------------------------------------- *
   * Playback
   * ---------------------------------------------------------------- */

  const speakFrom = useCallback(
    (index: number) => {
      if (!rec) return;
      const utterance = rec.utterances[index];
      if (!utterance) {
        setPlaying(false);
        return;
      }

      const translation = rec.translations[utterance.id]?.find((t) => t.lang === lang);
      const runs = translation?.runs ?? [
        { lang: rec.instructionLang, text: utterance.text, isTerm: false },
      ];

      queueRef.current?.enqueue({ id: `${utterance.id}:${index}`, runs });
    },
    [rec, lang],
  );

  useEffect(() => {
    const queue = new SpeechQueue({
      onEnd: () => {
        if (!playingRef.current) return;
        const next = cursorRef.current + 1;
        setCursor(next);
        speakFrom(next);
      },
    });
    // Replay is not racing a live lecturer, so nothing is ever dropped to catch
    // up - the student is in control of the clock here.
    queue.maxDepth = 1;
    queueRef.current = queue;
    return () => {
      queue.dispose();
      queueRef.current = null;
    };
  }, [speakFrom]);

  useEffect(() => {
    queueRef.current?.setRate(rate);
  }, [rate]);

  // Keep the line being spoken in view.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [cursor]);

  const play = () => {
    unlockAudio();
    setPlaying(true);
    playingRef.current = true;
    speakFrom(cursor);
  };

  const pause = () => {
    setPlaying(false);
    playingRef.current = false;
    queueRef.current?.clear();
  };

  const jumpTo = (index: number) => {
    queueRef.current?.clear();
    setCursor(index);
    cursorRef.current = index;
    if (playingRef.current) speakFrom(index);
  };

  /* ---------------------------------------------------------------- *
   * Derived
   * ---------------------------------------------------------------- */

  const availableLangs = useMemo(() => {
    if (!rec) return [];
    const set = new Set<LangCode>([rec.instructionLang]);
    for (const list of Object.values(rec.translations)) {
      for (const t of list) set.add(t.lang);
    }
    return [...set];
  }, [rec]);

  const langMissing = rec !== null && !availableLangs.includes(lang);

  if (error) {
    return (
      <Shell title="Recording">
        <Card className="p-6">
          <p className="text-live-500">{error}</p>
          <Link to="/replay" className="mt-3 inline-block text-sm text-ink-300 underline">
            Back to recordings
          </Link>
        </Card>
      </Shell>
    );
  }

  if (!rec) {
    return (
      <Shell title="Recording">
        <p className="text-ink-500">Loading…</p>
      </Shell>
    );
  }

  const current = rec.utterances[cursor];

  return (
    <Shell
      title={rec.title}
      subtitle={[rec.course, rec.instructor, new Date(rec.startedAt).toLocaleString()]
        .filter(Boolean)
        .join(' · ')}
      right={
        <Link to="/replay" className="text-sm text-ink-300 underline hover:text-ink-100">
          All recordings
        </Link>
      }
    >
      <Card className="mb-5 p-4">
        <LangPicker value={lang} onChange={setLang} label="Replay in" size="sm" />

        {langMissing && (
          <p className="mt-3 rounded-lg border border-brand-500/40 bg-brand-500/5 px-3 py-2 text-sm text-brand-400">
            Nobody listened in {LANGUAGES[lang].name} during this lecture, so it was never
            rendered. Lines below are shown in{' '}
            {LANGUAGES[rec.instructionLang].name} instead.
          </p>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-ink-800 pt-4">
          <Button variant="primary" onClick={playing ? pause : play}>
            {playing ? '⏸ Pause' : '▶ Play'}
          </Button>

          <Button size="sm" onClick={() => jumpTo(Math.max(0, cursor - 1))} disabled={cursor === 0}>
            ← Previous
          </Button>
          <Button
            size="sm"
            onClick={() => jumpTo(Math.min(rec.utterances.length - 1, cursor + 1))}
            disabled={cursor >= rec.utterances.length - 1}
          >
            Next →
          </Button>

          <label className="flex items-center gap-2 text-sm text-ink-300">
            <span>Speed</span>
            <input
              type="range"
              min={0.6}
              max={1.8}
              step={0.05}
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
              className="w-28 accent-brand-500"
              aria-label="Playback speed"
            />
            <span className="w-10 font-mono text-xs text-ink-400">{rate.toFixed(2)}×</span>
          </label>

          <span className="text-sm text-ink-500">
            {cursor + 1} / {rec.utterances.length}
          </span>
        </div>
      </Card>

      {rec.visuals.length > 0 && (
        <div className="mb-5 grid gap-3 sm:grid-cols-2">
          {rec.visuals.map((viz) => (
            <Card key={viz.id} className="overflow-hidden">
              <h3 className="border-b border-ink-800 px-3 py-2 text-sm text-ink-200">
                {viz.title}
              </h3>
              {viz.rendered && (
                <img
                  src={viz.rendered}
                  alt={viz.altText[lang] ?? viz.altText.en ?? viz.title}
                  className="w-full bg-white"
                />
              )}
              {(viz.altText[lang] ?? viz.altText.en) && (
                <p className="px-3 py-2 text-sm text-ink-400">
                  {viz.altText[lang] ?? viz.altText.en}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}

      <div className="space-y-1">
        {rec.utterances.map((utterance, i) => {
          const translation = rec.translations[utterance.id]?.find((t) => t.lang === lang);
          const active = i === cursor;

          return (
            <article
              key={utterance.id}
              ref={active ? (el) => (activeRef.current = el) : undefined}
              className={`rounded-lg px-3 py-2 transition-colors ${
                active ? 'bg-brand-500/10 ring-1 ring-brand-500/40' : 'hover:bg-ink-900'
              }`}
            >
              <button
                onClick={() => jumpTo(i)}
                className="w-full text-left"
                aria-current={active ? 'true' : undefined}
              >
                {translation ? (
                  <p className="text-lg leading-relaxed text-ink-100" lang={lang} data-lang={lang}>
                    <RunText runs={translation.runs} />
                  </p>
                ) : (
                  <p className="text-lg leading-relaxed text-ink-200">{utterance.text}</p>
                )}

                {translation && (
                  <p className="mt-1 text-sm text-ink-500" lang={rec.instructionLang}>
                    {utterance.text}
                  </p>
                )}
              </button>
            </article>
          );
        })}
      </div>

      {rec.glossary.length > 0 && (
        <Card className="mt-6 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-ink-200">
            <Badge tone="term">Terms</Badge>
            <span className="font-normal text-ink-400">
              preserved in {LANGUAGES[rec.instructionLang].name} throughout
            </span>
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {rec.glossary.map((t) => (
              <span key={t.id} className="rounded bg-term-900 px-2 py-0.5 text-xs text-term-400">
                {t.term}
              </span>
            ))}
          </div>
        </Card>
      )}

      <LiveRegion>{current?.text}</LiveRegion>
    </Shell>
  );
}
