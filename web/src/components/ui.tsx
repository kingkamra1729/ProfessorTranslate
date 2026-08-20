import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import { LANGUAGES, type LangCode, type SpeechRun } from '@suvidha/shared';
import { hasMixedContentProblem } from '../lib/config';

/* ------------------------------------------------------------------ *
 * RunText - the visual half of term preservation
 * ------------------------------------------------------------------ */

/**
 * Renders a translated line with its protected terms marked.
 *
 * This is the counterpart to what the student hears: the same boundary that
 * decides which voice speaks a word decides which styling it gets, so the
 * subtitle and the audio agree about what is a term. A student who reads
 * "eigenvalue" in teal here will meet the same word in the textbook.
 *
 * The `lang` attribute per run is not decoration - it tells the browser which
 * font and which hyphenation rules to use, and tells a screen reader which
 * pronunciation engine to switch to mid-sentence.
 */
export function RunText({
  runs,
  className = '',
}: {
  runs: SpeechRun[];
  className?: string;
}) {
  return (
    <span className={className}>
      {runs.map((run, i) =>
        run.isTerm ? (
          <span key={i} className="term" lang={run.lang} data-lang={run.lang}>
            {run.text}
          </span>
        ) : (
          <span key={i} lang={run.lang} data-lang={run.lang}>
            {run.text}
          </span>
        ),
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
};

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
  }[size];
  const variants = {
    primary: 'bg-brand-500 text-ink-950 hover:bg-brand-400 font-semibold',
    secondary: 'bg-ink-700 text-ink-100 hover:bg-ink-600',
    ghost: 'text-ink-300 hover:text-ink-100 hover:bg-ink-800',
    danger: 'bg-live-500 text-white hover:opacity-90',
  }[variant];

  return <button className={`${base} ${sizes} ${variants} ${className}`} {...props} />;
}

export function Card({
  children,
  className = '',
  as: Tag = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'section' | 'aside';
}) {
  return (
    <Tag className={`rounded-xl border border-ink-700 bg-ink-900 ${className}`}>{children}</Tag>
  );
}

export function Field({
  label,
  hint,
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = props.id ?? `f-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink-300">
        {label}
      </label>
      <input
        id={id}
        className="w-full rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-ink-100 placeholder:text-ink-500 focus:border-brand-500 focus:outline-none"
        {...props}
      />
      {hint && <p className="mt-1 text-xs text-ink-400">{hint}</p>}
    </div>
  );
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'live' | 'ok' | 'warn' | 'term';
}) {
  const tones = {
    neutral: 'bg-ink-700 text-ink-200',
    live: 'bg-live-500/15 text-live-500',
    ok: 'bg-ok-500/15 text-ok-500',
    warn: 'bg-brand-500/15 text-brand-400',
    term: 'bg-term-900 text-term-400',
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${tones}`}>
      {children}
    </span>
  );
}

export function LiveDot() {
  return <span className="live-dot inline-block h-2 w-2 rounded-full bg-live-500" aria-hidden />;
}

/* ------------------------------------------------------------------ *
 * Language picker
 * ------------------------------------------------------------------ */

/**
 * Language choice, shown in each language's own script.
 *
 * A student who reads Bengali more comfortably than English should not have to
 * find the word "Bengali" written in English to say so.
 */
export function LangPicker({
  value,
  onChange,
  exclude = [],
  label = 'Listen in',
  size = 'md',
}: {
  value: LangCode;
  onChange: (lang: LangCode) => void;
  exclude?: LangCode[];
  label?: string;
  size?: 'sm' | 'md';
}) {
  const options = Object.values(LANGUAGES).filter((l) => !exclude.includes(l.code));

  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium text-ink-300">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {options.map((lang) => {
          const selected = lang.code === value;
          return (
            <button
              key={lang.code}
              type="button"
              onClick={() => onChange(lang.code)}
              aria-pressed={selected}
              className={`rounded-lg border transition-colors ${
                size === 'sm' ? 'px-3 py-1.5' : 'px-4 py-2.5'
              } ${
                selected
                  ? 'border-brand-500 bg-brand-500/10 text-brand-400'
                  : 'border-ink-600 bg-ink-800 text-ink-300 hover:border-ink-500 hover:text-ink-100'
              }`}
            >
              <span
                lang={lang.code}
                data-lang={lang.code}
                className={size === 'sm' ? 'text-sm' : 'text-base'}
              >
                {lang.nativeName}
              </span>
              {lang.nativeName !== lang.name && (
                <span className="ml-2 text-xs text-ink-400">{lang.name}</span>
              )}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

export function Shell({
  title,
  subtitle,
  right,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-full bg-ink-950">
      <header className="border-b border-ink-800 bg-ink-900/60 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-semibold text-ink-100">{title}</h1>
            {subtitle && <p className="truncate text-sm text-ink-400">{subtitle}</p>}
          </div>
          {right}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  );
}

/**
 * Warns about the deployment mistake that produces the most confusing failure.
 *
 * A page served over HTTPS cannot open a `ws://` connection - the browser
 * blocks it, and what the user sees is a socket that never connects, with an
 * error in the console that does not mention mixed content. Since this only
 * happens in a split deployment, and only after everything worked locally, it
 * is worth naming explicitly rather than leaving someone to debug it at 2am.
 */
export function ConnectionWarning() {
  if (!hasMixedContentProblem()) return null;
  return (
    <div className="mb-4 rounded-lg border border-live-500/40 bg-live-500/5 p-3">
      <p className="text-sm text-live-500">
        This page is served over HTTPS but <code>VITE_SERVER_URL</code> points at an{' '}
        <code>http://</code> address, so the browser will refuse the connection. Use an{' '}
        <code>https://</code> server URL and rebuild.
      </p>
    </div>
  );
}

/**
 * A polite live region.
 *
 * Screen readers announce changes here without interrupting whatever the user
 * is currently reading - which matters when the content updates every few
 * seconds for the whole lecture.
 */
export function LiveRegion({ children }: { children: ReactNode }) {
  return (
    <div aria-live="polite" aria-atomic="false" className="sr-only">
      {children}
    </div>
  );
}
