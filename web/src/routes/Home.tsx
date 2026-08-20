import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { LectureMeta } from '@suvidha/shared';
import { api, type ServiceStatus } from '../lib/api';
import { Badge, Button, Card, LiveDot } from '../components/ui';

export default function Home() {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [live, setLive] = useState<LectureMeta[]>([]);
  const [services, setServices] = useState<ServiceStatus[]>([]);

  useEffect(() => {
    api.liveLectures().then(setLive).catch(() => setLive([]));
    api.health().then((h) => setServices(h.services)).catch(() => setServices([]));
    const timer = setInterval(() => {
      api.liveLectures().then(setLive).catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim().toUpperCase();
    if (trimmed) navigate(`/listen/${trimmed}`);
  };

  return (
    <div className="min-h-full bg-ink-950">
      <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 sm:py-20">
        <header className="mb-14">
          <div className="mb-4 flex items-center gap-3">
            <span className="text-3xl">🎧</span>
            <span className="text-sm font-medium tracking-widest text-brand-500 uppercase">
              Suvidha · सुविधा
            </span>
          </div>

          <h1 className="max-w-3xl text-4xl leading-tight font-bold text-ink-100 sm:text-5xl">
            Understand the lecture.
            <br />
            <span className="text-brand-500">Keep the vocabulary.</span>
          </h1>

          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-300">
            Live translation of what the professor is explaining, straight to a student's
            earbuds — while every technical term stays in the language it is taught in.
          </p>

          <p className="mt-4 max-w-2xl leading-relaxed text-ink-400">
            The explanation is what a second-language student loses, so the explanation is
            what gets translated. <span className="term">eigenvalue</span> stays{' '}
            <span className="term">eigenvalue</span> — in the subtitles, and in an English
            voice in the earbud — because that is the word in the textbook, on the exam,
            and in the interview.
          </p>
        </header>

        <div className="mb-12 grid gap-4 sm:grid-cols-2">
          <Card className="p-6">
            <h2 className="mb-1 text-lg font-semibold text-ink-100">I am teaching</h2>
            <p className="mb-5 text-sm text-ink-400">
              Start a lecture, pick the vocabulary to protect, and give the class a code.
            </p>
            <Link to="/teach">
              <Button variant="primary" size="lg" className="w-full">
                Start a lecture
              </Button>
            </Link>
          </Card>

          <Card className="p-6">
            <h2 className="mb-1 text-lg font-semibold text-ink-100">I am listening</h2>
            <p className="mb-5 text-sm text-ink-400">
              Enter the code on the board and choose the language you think in.
            </p>
            <form onSubmit={join} className="flex gap-2">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABC123"
                maxLength={6}
                aria-label="Lecture code"
                className="min-w-0 flex-1 rounded-lg border border-ink-600 bg-ink-800 px-4 py-3 font-mono text-lg tracking-[0.3em] text-ink-100 uppercase placeholder:tracking-normal placeholder:text-ink-500 focus:border-brand-500 focus:outline-none"
              />
              <Button type="submit" variant="primary" size="lg" disabled={!code.trim()}>
                Join
              </Button>
            </form>
          </Card>
        </div>

        {live.length > 0 && (
          <section className="mb-12">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold tracking-wide text-ink-300 uppercase">
              <LiveDot /> Live right now
            </h2>
            <div className="grid gap-2">
              {live.map((lecture) => (
                <Link
                  key={lecture.id}
                  to={`/listen/${lecture.id}`}
                  className="flex items-center justify-between gap-4 rounded-lg border border-ink-700 bg-ink-900 px-4 py-3 transition-colors hover:border-brand-500/50"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink-100">{lecture.title}</p>
                    <p className="truncate text-sm text-ink-400">
                      {[lecture.course, lecture.instructor].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <span className="font-mono text-sm tracking-widest text-brand-500">
                    {lecture.id}
                  </span>
                </Link>
              ))}
            </div>
          </section>
        )}

        <section className="mb-12 grid gap-6 sm:grid-cols-3">
          <Feature
            title="Terms are never translated"
            body="Known vocabulary is lifted out before the model sees the sentence and put back after. The translator has no opportunity to render it, because it was never given it."
          />
          <Feature
            title="Two voices, one sentence"
            body="Each sentence is spoken by a native voice for the explanation and an English voice for the terms. That is what makes the rule audible and not just visible."
          />
          <Feature
            title="Built for people who cannot see the board"
            body="Every diagram carries a spoken description, translated the same way. Recordings replay as text, so a screen reader can read them at any speed."
          />
        </section>

        <div className="flex flex-wrap items-center justify-between gap-4 border-t border-ink-800 pt-6">
          <div className="flex flex-wrap gap-4">
            <Link to="/replay" className="text-sm text-ink-300 underline hover:text-ink-100">
              Browse recorded lectures →
            </Link>
            <Link to="/check" className="text-sm text-brand-400 underline hover:text-brand-500">
              Pre-flight check →
            </Link>
          </div>

          <div className="flex flex-wrap gap-2">
            {services.map((s) => (
              <Badge key={s.name} tone={s.enabled ? 'ok' : 'neutral'}>
                <span title={s.detail}>
                  {s.enabled ? '✓' : '·'} {s.name}
                </span>
              </Badge>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h3 className="mb-2 font-semibold text-ink-100">{title}</h3>
      <p className="text-sm leading-relaxed text-ink-400">{body}</p>
    </div>
  );
}
