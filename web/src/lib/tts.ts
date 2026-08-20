import { LANGUAGES, type LangCode, type SpeechRun } from '@suvidha/shared';

/**
 * Multi-voice speech synthesis.
 *
 * This is the module that makes term preservation audible rather than merely
 * visible in the subtitles.
 *
 * A translated sentence arrives already split into runs, each tagged with the
 * language it must be pronounced in. A Hindi voice handed the Latin string
 * "eigenvalue" produces a noise that is not the word; an English voice produces
 * the word the professor said. So each run is spoken by a voice chosen for its
 * own language, and the sentence is reassembled in the student's ear.
 *
 * The second job here is keeping up. Translation plus synthesis is slower than
 * speech, so a queue that never drops anything drifts further behind the
 * lecturer with every sentence until the student is listening to a different
 * paragraph than the one on the board. Falling behind is handled explicitly
 * below, and reported, rather than being allowed to accumulate silently.
 */

export interface VoiceReport {
  lang: LangCode;
  voice: SpeechSynthesisVoice | null;
  /** Human-readable state for the UI to display honestly. */
  status: 'ok' | 'approximate' | 'missing';
  detail: string;
}

/* ------------------------------------------------------------------ *
 * Voice discovery
 * ------------------------------------------------------------------ */

let voiceCache: SpeechSynthesisVoice[] = [];

/**
 * Chrome populates the voice list asynchronously and returns an empty array on
 * the first call. Waiting for `voiceschanged` once, with a timeout so a browser
 * that never fires it does not hang the page, is the reliable pattern.
 */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    if (typeof speechSynthesis === 'undefined') {
      resolve([]);
      return;
    }

    const existing = speechSynthesis.getVoices();
    if (existing.length > 0) {
      voiceCache = existing;
      resolve(existing);
      return;
    }

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      voiceCache = speechSynthesis.getVoices();
      speechSynthesis.removeEventListener('voiceschanged', finish);
      resolve(voiceCache);
    };

    speechSynthesis.addEventListener('voiceschanged', finish);
    setTimeout(finish, 2000);
  });
}

/**
 * Picks the best available voice for a language.
 *
 * Preference order within a matching locale favours network voices, which on
 * Chrome means Google's - noticeably more natural for Hindi and Bengali than
 * the bundled system voices, and the difference is very audible over an
 * earbud for forty minutes.
 */
export function pickVoice(lang: LangCode): SpeechSynthesisVoice | null {
  const voices = voiceCache.length > 0 ? voiceCache : speechSynthesis?.getVoices?.() ?? [];
  if (voices.length === 0) return null;

  const spec = LANGUAGES[lang];

  const byQuality = (list: SpeechSynthesisVoice[]) =>
    [...list].sort((a, b) => {
      // localService === false generally means a higher-quality network voice.
      if (a.localService !== b.localService) return a.localService ? 1 : -1;
      const aGoogle = /google/i.test(a.name) ? 0 : 1;
      const bGoogle = /google/i.test(b.name) ? 0 : 1;
      return aGoogle - bGoogle;
    })[0] ?? null;

  // Exact locale, in the order the language spec prefers.
  for (const locale of spec.ttsLocales) {
    const exact = voices.filter((v) => v.lang.replace('_', '-').toLowerCase() === locale.toLowerCase());
    if (exact.length > 0) return byQuality(exact);
  }

  // Any regional variant of the same language.
  const loose = voices.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith(`${lang}-`) || v.lang.toLowerCase() === lang);
  if (loose.length > 0) return byQuality(loose);

  return null;
}

/** Describes voice availability so the UI can warn before the lecture starts. */
export function reportVoices(langs: LangCode[]): VoiceReport[] {
  return langs.map((lang) => {
    const voice = pickVoice(lang);
    const spec = LANGUAGES[lang];

    if (!voice) {
      return {
        lang,
        voice: null,
        status: 'missing',
        detail: `No ${spec.name} voice installed. Subtitles will still work; audio will not.`,
      };
    }

    const voiceLocale = voice.lang.replace('_', '-').toLowerCase();
    const exact = spec.ttsLocales.some((l) => voiceLocale === l.toLowerCase());

    return {
      lang,
      voice,
      status: exact ? 'ok' : 'approximate',
      detail: exact
        ? `${voice.name} (${voice.lang})`
        : `${voice.name} (${voice.lang}) — close, but not the preferred locale`,
    };
  });
}

/* ------------------------------------------------------------------ *
 * Queue
 * ------------------------------------------------------------------ */

export interface QueueItem {
  id: string;
  runs: SpeechRun[];
}

export interface SpeechQueueEvents {
  onStart?: (id: string) => void;
  onEnd?: (id: string) => void;
  /** Fired when an item is discarded to catch up. */
  onDrop?: (id: string, reason: 'behind' | 'cleared') => void;
  onDepthChange?: (depth: number) => void;
  /**
   * Fired when a run cannot be spoken because no voice exists for its language.
   *
   * This is the failure that most needs reporting and is least visible.
   * `speechSynthesis.speak()` accepts an utterance in a language it has no
   * voice for, reports no error, fires no `error` event, and simply produces
   * nothing. Without this callback a student sits in silence while the app
   * shows every sign of working.
   */
  onVoiceMissing?: (lang: LangCode) => void;
  /** Fired when the platform reports a synthesis error. */
  onSpeechError?: (detail: string) => void;
}

/**
 * Speaks translated utterances in order, one voice per run.
 */
export class SpeechQueue {
  private pending: QueueItem[] = [];
  private current: QueueItem | null = null;
  private enabled = true;
  private rate = 1.05;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  /** Languages already reported as unvoiceable, so the UI is told once. */
  private reportedMissing = new Set<LangCode>();

  /**
   * How many utterances may wait before we start discarding.
   *
   * Three is roughly ten seconds of lecture. Past that a student is no longer
   * listening to the slide on the screen, and hearing the right sentence late
   * is worse than missing it - they cannot tell it is late.
   */
  maxDepth = 3;

  constructor(private events: SpeechQueueEvents = {}) {}

  get depth(): number {
    return this.pending.length + (this.current ? 1 : 0);
  }

  get isSpeaking(): boolean {
    return this.current !== null;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.clear();
  }

  setRate(rate: number): void {
    this.rate = Math.min(2, Math.max(0.5, rate));
  }

  enqueue(item: QueueItem): void {
    if (!this.enabled || item.runs.length === 0) return;

    this.pending.push(item);

    // Drop from the front: the oldest waiting sentence is the one furthest
    // behind the professor and therefore the least useful to still play.
    while (this.pending.length > this.maxDepth) {
      const dropped = this.pending.shift();
      if (dropped) this.events.onDrop?.(dropped.id, 'behind');
    }

    this.events.onDepthChange?.(this.depth);
    this.pump();
  }

  clear(): void {
    const cleared = [...this.pending];
    this.pending = [];
    this.current = null;
    try {
      speechSynthesis.cancel();
    } catch {
      /* nothing playing */
    }
    for (const item of cleared) this.events.onDrop?.(item.id, 'cleared');
    this.stopKeepAlive();
    this.events.onDepthChange?.(this.depth);
  }

  /** Abandons the backlog and jumps to the most recent sentence. */
  skipToLatest(): void {
    if (this.pending.length === 0) return;
    const latest = this.pending[this.pending.length - 1];
    for (const item of this.pending.slice(0, -1)) this.events.onDrop?.(item.id, 'behind');
    this.pending = [latest];
    try {
      speechSynthesis.cancel();
    } catch {
      /* nothing playing */
    }
    this.current = null;
    this.events.onDepthChange?.(this.depth);
    this.pump();
  }

  private pump(): void {
    if (this.current || this.pending.length === 0 || !this.enabled) return;

    const item = this.pending.shift()!;
    this.current = item;
    this.events.onStart?.(item.id);
    this.events.onDepthChange?.(this.depth);

    const utterances = item.runs
      .filter((run) => run.text.trim().length > 0)
      .map((run) => {
        const u = new SpeechSynthesisUtterance(run.text);
        const voice = pickVoice(run.lang);
        if (voice) {
          u.voice = voice;
          u.lang = voice.lang;
        } else {
          // Nothing will be heard for this run. Say so, loudly, once per
          // language - the platform will not.
          if (!this.reportedMissing.has(run.lang)) {
            this.reportedMissing.add(run.lang);
            this.events.onVoiceMissing?.(run.lang);
          }
          u.lang = LANGUAGES[run.lang].ttsLocales[0];
        }
        // Terms are the words the student is meant to retain, so they are said
        // a little slower and a little louder than the explanation around them.
        u.rate = run.isTerm ? this.rate * 0.92 : this.rate;
        u.volume = run.isTerm ? 1 : 0.95;
        return u;
      });

    if (utterances.length === 0) {
      this.finish(item);
      return;
    }

    const last = utterances[utterances.length - 1];
    last.addEventListener('end', () => this.finish(item));
    // An error on any run must not strand the queue.
    last.addEventListener('error', (e) => {
      const err = e as SpeechSynthesisErrorEvent;
      // 'interrupted' and 'canceled' are our own doing - skipping ahead or
      // switching language - and are not worth alarming the student about.
      if (err.error && err.error !== 'interrupted' && err.error !== 'canceled') {
        this.events.onSpeechError?.(err.error);
      }
      this.finish(item);
    });

    // Handing every run to the platform queue at once, rather than chaining
    // them on 'end', keeps the gap between a term and the words around it below
    // what the ear reads as a pause.
    for (const u of utterances) speechSynthesis.speak(u);
    this.startKeepAlive();
  }

  private finish(item: QueueItem): void {
    if (this.current?.id !== item.id) return;
    this.current = null;
    this.events.onEnd?.(item.id);
    this.events.onDepthChange?.(this.depth);
    if (this.pending.length === 0) this.stopKeepAlive();
    this.pump();
  }

  /**
   * Chrome stops synthesising after roughly fifteen seconds of continuous
   * speech unless it is nudged. A periodic pause/resume is the long-standing
   * workaround and is harmless when nothing is playing.
   */
  private startKeepAlive(): void {
    if (this.keepAlive) return;
    this.keepAlive = setInterval(() => {
      if (!speechSynthesis.speaking) return;
      speechSynthesis.pause();
      speechSynthesis.resume();
    }, 9000);
  }

  private stopKeepAlive(): void {
    if (!this.keepAlive) return;
    clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  /** Forgets which languages were reported, e.g. after voices finish loading. */
  resetDiagnostics(): void {
    this.reportedMissing.clear();
  }

  dispose(): void {
    this.clear();
    this.stopKeepAlive();
  }
}

/**
 * Speech synthesis needs a user gesture before it will produce sound on most
 * browsers. Speaking an empty utterance inside a click handler satisfies that
 * requirement without the student hearing anything.
 */
export function unlockAudio(): void {
  try {
    const u = new SpeechSynthesisUtterance('');
    u.volume = 0;
    speechSynthesis.speak(u);
  } catch {
    /* Unsupported: the UI reports this separately. */
  }
}

export function isSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}
