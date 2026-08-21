import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from 'react';
import { Link } from 'react-router-dom';
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

/**
 * Radii are deliberately tight - 6px, not the 16px that reads as a consumer
 * app. Hover darkens rather than lightens, which is the direction a light
 * surface expects.
 */
export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2 text-sm',
    lg: 'px-5 py-2.5 text-[0.9375rem]',
  }[size];
  const variants = {
    primary: 'bg-brand-500 text-ink-950 hover:bg-brand-600 font-semibold',
    secondary:
      'border border-ink-600 bg-ink-900 text-ink-200 hover:border-ink-500 hover:bg-ink-800',
    ghost: 'text-ink-400 hover:bg-ink-800 hover:text-ink-100',
    danger: 'bg-live-500 text-ink-950 hover:opacity-90 font-semibold',
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
    <Tag className={`raised rounded-lg border border-ink-800 bg-ink-900 ${className}`}>
      {children}
    </Tag>
  );
}

/**
 * A titled section of a form.
 *
 * Exists so that every panel in the setup flow carries the same three-part
 * header - label, heading, one line of explanation - rather than each screen
 * inventing its own hierarchy.
 */
export function Section({
  eyebrow,
  title,
  description,
  aside,
  children,
  className = '',
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card as="section" className={`p-5 sm:p-6 ${className}`}>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="min-w-0">
          {eyebrow && <p className="eyebrow mb-1.5">{eyebrow}</p>}
          <h2 className="text-base font-semibold text-ink-100">{title}</h2>
          {description && (
            <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-400">{description}</p>
          )}
        </div>
        {aside && <div className="shrink-0">{aside}</div>}
      </div>
      {children}
    </Card>
  );
}

const inputClass =
  'w-full rounded-md border border-ink-600 bg-ink-900 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-500 transition-colors hover:border-ink-500 focus:border-brand-500 focus:outline-none disabled:bg-ink-800 disabled:text-ink-500';

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
      <input id={id} className={inputClass} {...props} />
      {hint && <p className="mt-1.5 text-xs text-ink-400">{hint}</p>}
    </div>
  );
}

export function TextArea({
  label,
  hint,
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; hint?: string }) {
  const id = props.id ?? `t-${(label ?? 'field').replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className={className}>
      {label && (
        <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink-300">
          {label}
        </label>
      )}
      <textarea id={id} className={`${inputClass} leading-relaxed`} {...props} />
      {hint && <p className="mt-1.5 text-xs text-ink-400">{hint}</p>}
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
    neutral: 'bg-ink-800 text-ink-300',
    live: 'bg-live-500/10 text-live-500',
    ok: 'bg-ok-500/10 text-ok-500',
    warn: 'bg-brand-500/10 text-brand-500',
    term: 'bg-term-900 text-term-400',
  }[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium ${tones}`}
    >
      {children}
    </span>
  );
}

export function LiveDot() {
  return <span className="live-dot inline-block h-2 w-2 rounded-full bg-live-500" aria-hidden />;
}

/* ------------------------------------------------------------------ *
 * Wordmark and identity
 * ------------------------------------------------------------------ */

/**
 * The product name, set in the display serif.
 *
 * The Devanagari endonym is shown alongside it rather than instead of it: the
 * word means "convenience", and the two scripts side by side are the clearest
 * statement of what the product is for.
 */
export function Wordmark({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const scale = {
    sm: 'text-base',
    md: 'text-lg',
    lg: 'text-2xl',
  }[size];
  return (
    <span className={`font-display ${scale} font-semibold tracking-tight text-ink-100`}>
      Suvidha
      <span className="ml-2 font-sans text-[0.7em] font-normal text-ink-400" lang="hi" data-lang="hi">
        सुविधा
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Choice and step controls
 * ------------------------------------------------------------------ */

/**
 * A large, unambiguous choice.
 *
 * The first thing anyone does here is say who they are, and that decision
 * should be readable across a room and reachable with a thumb. Rendered as a
 * button rather than a styled div so it is focusable and announced correctly.
 */
export function ChoiceCard({
  title,
  description,
  meta,
  onClick,
}: {
  title: string;
  description: string;
  meta?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="raised group flex w-full flex-col rounded-lg border border-ink-800 bg-ink-900 p-6 text-left transition-colors hover:border-brand-500 focus-visible:border-brand-500"
    >
      {meta && <span className="eyebrow mb-2">{meta}</span>}
      <span className="text-lg font-semibold text-ink-100">{title}</span>
      <span className="mt-1.5 text-sm leading-relaxed text-ink-400">{description}</span>
      <span className="mt-5 text-sm font-medium text-brand-500 group-hover:text-brand-600">
        Continue &rarr;
      </span>
    </button>
  );
}

/**
 * Progress through a short, linear flow.
 *
 * Shown because the professor is being asked for setup before a class starts
 * and needs to know how much is left. Steps already completed are clickable so
 * a wrong answer can be corrected without losing the rest.
 */
export function Stepper({
  steps,
  current,
  onGo,
}: {
  steps: string[];
  current: number;
  onGo?: (index: number) => void;
}) {
  return (
    <ol className="mb-8 flex flex-wrap items-center gap-x-2 gap-y-2">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={label} className="flex items-center gap-2">
            <button
              type="button"
              disabled={!done || !onGo}
              onClick={() => onGo?.(i)}
              className={`flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors ${
                active
                  ? 'font-semibold text-ink-100'
                  : done
                    ? 'text-ink-400 hover:text-ink-100'
                    : 'text-ink-500'
              } ${done && onGo ? 'cursor-pointer' : 'cursor-default'}`}
              aria-current={active ? 'step' : undefined}
            >
              <span
                aria-hidden
                className={`flex h-5 w-5 items-center justify-center rounded-full border text-[0.6875rem] font-semibold ${
                  active
                    ? 'border-brand-500 bg-brand-500 text-ink-950'
                    : done
                      ? 'border-brand-500 text-brand-500'
                      : 'border-ink-600 text-ink-500'
                }`}
              >
                {done ? '✓' : i + 1}
              </span>
              {label}
            </button>
            {i < steps.length - 1 && (
              <span aria-hidden className="h-px w-6 bg-ink-700 sm:w-10" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * One-of-N selection, as a single connected control.
 *
 * Used where the options are alternative routes to the same outcome - three
 * ways to supply the same course material - and only one can be active. A
 * segmented control says "pick a route" where three separate panels would say
 * "fill all of these in".
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string; hint?: string }>;
  label: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 rounded-md bg-ink-800 p-1">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(option.value)}
            className={`flex-1 rounded px-3 py-2 text-sm font-medium transition-colors ${
              selected
                ? 'raised bg-ink-900 text-ink-100'
                : 'text-ink-400 hover:text-ink-200'
            }`}
          >
            {option.label}
            {option.hint && (
              <span className="mt-0.5 block text-xs font-normal text-ink-400">{option.hint}</span>
            )}
          </button>
        );
      })}
    </div>
  );
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
              className={`rounded-md border transition-colors ${
                size === 'sm' ? 'px-3 py-1.5' : 'px-4 py-2.5'
              } ${
                selected
                  ? 'border-brand-500 bg-brand-500/8 text-brand-500'
                  : 'border-ink-600 bg-ink-900 text-ink-300 hover:border-ink-500 hover:text-ink-100'
              }`}
            >
              <span
                lang={lang.code}
                data-lang={lang.code}
                className={size === 'sm' ? 'text-sm font-medium' : 'text-base font-medium'}
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
      <header className="border-b border-ink-800 bg-ink-900">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-4 py-3 sm:px-6">
          <Link to="/" className="shrink-0 border-r border-ink-800 pr-4">
            <Wordmark size="sm" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold text-ink-100">{title}</h1>
            {subtitle && <p className="truncate text-sm text-ink-400">{subtitle}</p>}
          </div>
          {right}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}

/**
 * The header for a full-page form, outside the Shell.
 *
 * Setup screens are read once, carefully, before a lecture. They get a wider
 * measure and a larger title than the in-lecture chrome, which is read at a
 * glance and must stay out of the way.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
}) {
  return (
    <div className="mb-8">
      {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
      <h1 className="text-2xl font-semibold tracking-tight text-ink-100">{title}</h1>
      {description && (
        <p className="mt-2 max-w-prose leading-relaxed text-ink-400">{description}</p>
      )}
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
    <div className="mb-4 rounded-md border border-live-500/40 bg-live-500/5 p-3">
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
