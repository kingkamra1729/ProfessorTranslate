import { LANGUAGES, type LangCode } from '@suvidha/shared';

/**
 * Speech recognition for the professor's microphone, on the browser's built-in
 * Web Speech API.
 *
 * Chosen over a cloud transcription service for one reason that matters more
 * than accuracy: it is free and needs no key, so a lecturer can walk into a
 * hall and use this without anyone having provisioned anything. A cloud ASR
 * adapter belongs behind this same interface if the accuracy ever justifies the
 * cost, but the default has to work on a laptop with nothing set up.
 *
 * The API is also more fragile than its documentation suggests, and most of
 * this file is about that.
 */

/* ------------------------------------------------------------------ *
 * Types - the Web Speech API is not in the standard DOM lib
 * ------------------------------------------------------------------ */

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResult {
  readonly length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
  isFinal: boolean;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
  message: string;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isRecognitionSupported(): boolean {
  return typeof window !== 'undefined' && getCtor() !== null;
}

/* ------------------------------------------------------------------ *
 * Recogniser
 * ------------------------------------------------------------------ */

export type RecognizerState = 'idle' | 'listening' | 'restarting' | 'error';

export interface RecognizerEvents {
  onResult?: (text: string, isFinal: boolean) => void;
  onStateChange?: (state: RecognizerState, detail?: string) => void;
  /** Non-fatal problems worth showing the professor, e.g. a muted mic. */
  onNotice?: (message: string) => void;
}

export class Recognizer {
  private recognition: SpeechRecognitionLike | null = null;
  private wantRunning = false;
  private state: RecognizerState = 'idle';
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveErrors = 0;

  constructor(
    private lang: LangCode,
    private events: RecognizerEvents = {},
  ) {}

  get currentState(): RecognizerState {
    return this.state;
  }

  private setState(state: RecognizerState, detail?: string): void {
    this.state = state;
    this.events.onStateChange?.(state, detail);
  }

  setLang(lang: LangCode): void {
    this.lang = lang;
    if (this.wantRunning) {
      // The locale is fixed at construction, so a change means a new session.
      this.stop();
      this.start();
    }
  }

  start(): void {
    const Ctor = getCtor();
    if (!Ctor) {
      this.setState('error', 'This browser has no speech recognition. Use Chrome or Edge.');
      return;
    }

    this.wantRunning = true;
    this.spawn(Ctor);
  }

  private spawn(Ctor: SpeechRecognitionCtor): void {
    const rec = new Ctor();
    rec.lang = LANGUAGES[this.lang].sttLocale;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      this.consecutiveErrors = 0;
      this.setState('listening');
    };

    rec.onresult = (event) => {
      // `resultIndex` marks where new content starts; everything before it has
      // already been delivered. Interim and final results are reported
      // separately because only finals are worth translating.
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? '';
        if (result.isFinal) {
          const text = transcript.trim();
          if (text) this.events.onResult?.(text, true);
        } else {
          interim += transcript;
        }
      }
      const trimmed = interim.trim();
      if (trimmed) this.events.onResult?.(trimmed, false);
    };

    rec.onerror = (event) => {
      switch (event.error) {
        case 'no-speech':
          // Ordinary: the lecturer paused. `onend` restarts us.
          break;
        case 'aborted':
          break;
        case 'not-allowed':
        case 'service-not-allowed':
          this.wantRunning = false;
          this.setState('error', 'Microphone permission was denied.');
          break;
        case 'audio-capture':
          this.wantRunning = false;
          this.setState('error', 'No microphone was found.');
          break;
        case 'network':
          this.consecutiveErrors++;
          this.events.onNotice?.('Recognition lost its network connection; retrying.');
          break;
        default:
          this.consecutiveErrors++;
          this.events.onNotice?.(`Recognition error: ${event.error}`);
      }
    };

    rec.onend = () => {
      this.recognition = null;
      if (!this.wantRunning) {
        this.setState('idle');
        return;
      }

      // Chrome ends the session on every significant pause, which in a lecture
      // is constantly. Restarting is not error handling, it is the normal
      // operating mode - without it, recognition stops a minute in and the
      // professor has no idea the class stopped hearing them.
      this.setState('restarting');

      // Back off only when errors are actually repeating, so an ordinary pause
      // resumes instantly.
      const delay = this.consecutiveErrors > 0
        ? Math.min(4000, 250 * 2 ** this.consecutiveErrors)
        : 120;

      this.restartTimer = setTimeout(() => {
        if (!this.wantRunning) return;
        const Ctor = getCtor();
        if (Ctor) this.spawn(Ctor);
      }, delay);
    };

    try {
      rec.start();
      this.recognition = rec;
    } catch {
      // `start()` throws if a previous session has not fully released. `onend`
      // will fire and drive the restart.
      this.recognition = null;
    }
  }

  stop(): void {
    this.wantRunning = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    try {
      this.recognition?.stop();
    } catch {
      /* already stopped */
    }
    this.recognition = null;
    this.setState('idle');
  }

  dispose(): void {
    this.stop();
  }
}
