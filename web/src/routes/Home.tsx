import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LANGUAGES, type LangCode } from '@suvidha/shared';
import { Button, ChoiceCard, LangPicker, Wordmark } from '../components/ui';

/**
 * The front door.
 *
 * One question, asked once: are you teaching or are you listening? Everything
 * else - lecture setup, course material, language, audio - belongs to whichever
 * of those two answers you gave, and putting any of it here would mean showing
 * every visitor most of a screen that is not for them.
 *
 * The student branch stays on this page rather than routing away, because the
 * whole of it is one short field and a language choice; a page transition for
 * that would cost more than it explains.
 */

type Stage = 'role' | 'student';

export default function Home() {
  const [stage, setStage] = useState<Stage>('role');

  return (
    <div className="flex min-h-full flex-col bg-ink-950">
      <header className="border-b border-ink-800 bg-ink-900">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-5 py-4 sm:px-8">
          <Wordmark />
          <p className="hidden text-sm text-ink-400 sm:block">Live lecture translation</p>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col justify-center px-5 py-12 sm:px-8 sm:py-20">
        {stage === 'role' ? <RoleChoice onStudent={() => setStage('student')} /> : null}
        {stage === 'student' ? <StudentJoin onBack={() => setStage('role')} /> : null}
      </main>

      <footer className="border-t border-ink-800">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm sm:px-8">
          <p className="text-ink-500">
            Technical terms are preserved in the language the course is taught in.
          </p>
          <div className="flex gap-5">
            <Link to="/replay" className="text-ink-400 hover:text-ink-100">
              Recordings
            </Link>
            <Link to="/check" className="text-ink-400 hover:text-ink-100">
              Pre-flight check
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Stage 1 - who are you
 * ------------------------------------------------------------------ */

function RoleChoice({ onStudent }: { onStudent: () => void }) {
  const navigate = useNavigate();

  return (
    <div>
      <h1 className="font-display max-w-2xl text-3xl leading-tight font-semibold tracking-tight text-ink-100 sm:text-4xl">
        Understand the lecture.
        <br />
        Keep the vocabulary.
      </h1>
      <p className="mt-4 max-w-xl leading-relaxed text-ink-400">
        The explanation is translated into the language you think in.{' '}
        <span className="term">eigenvalue</span> stays{' '}
        <span className="term">eigenvalue</span> — because that is the word in the
        textbook, on the exam, and in the interview.
      </p>

      <div className="mt-10 grid gap-4 sm:grid-cols-2">
        <ChoiceCard
          meta="Join a class"
          title="I am a student"
          description="Enter the code shown in the hall and choose the language you want to listen in."
          onClick={onStudent}
        />
        <ChoiceCard
          meta="Run a class"
          title="I am a professor"
          description="Set up the lecture, add your course material, and get a code for the class."
          onClick={() => navigate('/teach')}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Stage 2 - the student's code
 * ------------------------------------------------------------------ */

function StudentJoin({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const [code, setCode] = useState('');
  const [lang, setLang] = useState<LangCode>(() => {
    const saved = localStorage.getItem('suvidha:lang');
    return saved && saved in LANGUAGES ? (saved as LangCode) : 'hi';
  });

  const trimmed = code.trim().toUpperCase();

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    if (!trimmed) return;
    // The student view reads this on mount, so choosing here means the first
    // sentence of the lecture already arrives in the right language.
    localStorage.setItem('suvidha:lang', lang);
    navigate(`/listen/${trimmed}`);
  };

  return (
    <div className="mx-auto w-full max-w-xl">
      <button
        type="button"
        onClick={onBack}
        className="mb-6 text-sm text-ink-400 hover:text-ink-100"
      >
        &larr; Back
      </button>

      <p className="eyebrow mb-2">Join a class</p>
      <h1 className="text-2xl font-semibold tracking-tight text-ink-100">
        Enter the lecture code
      </h1>
      <p className="mt-2 leading-relaxed text-ink-400">
        Six characters, shown on the board or read out at the start of the class.
      </p>

      <form onSubmit={join} className="mt-8">
        <label htmlFor="lecture-code" className="mb-1.5 block text-sm font-medium text-ink-300">
          Lecture code
        </label>
        <input
          id="lecture-code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="ABC123"
          maxLength={6}
          autoFocus
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className="w-full rounded-md border border-ink-600 bg-ink-900 px-4 py-4 text-center font-mono text-2xl tracking-[0.4em] text-ink-100 uppercase transition-colors placeholder:tracking-[0.3em] placeholder:text-ink-500 hover:border-ink-500 focus:border-brand-500 focus:outline-none"
        />

        <div className="mt-7 border-t border-ink-800 pt-6">
          <LangPicker value={lang} onChange={setLang} label="I want to listen in" />
          <p className="mt-2.5 text-xs text-ink-400">
            You can change this at any point during the lecture.
          </p>
        </div>

        <Button
          type="submit"
          variant="primary"
          size="lg"
          disabled={!trimmed}
          className="mt-7 w-full"
        >
          Join lecture
        </Button>
      </form>
    </div>
  );
}
