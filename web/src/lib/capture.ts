import { Recognizer, type RecognizerState } from './asr';
import { VoiceActivityDetector, type VadOptions } from './vad';
import type { LangCode } from '@suvidha/shared';

/**
 * The professor's capture path: a recogniser and a voice activity detector,
 * wired together.
 *
 * They are separate objects because they are separate concerns - one turns
 * audio into text, the other decides whether there is any audio worth turning
 * into text - but neither is useful alone here, and the wiring between them is
 * subtle enough to deserve its own file rather than being spread through a
 * React component.
 *
 * What the wiring buys, in the order it happens during one pause:
 *
 *   200ms of silence  ->  onPause      ->  the server flushes its chunk buffer,
 *                                          so a trailing clause is translated
 *                                          now rather than waiting to be
 *                                          prepended to the next sentence.
 *
 *   300ms of silence  ->  endSegment() ->  the recogniser commits its pending
 *                                          final immediately instead of waiting
 *                                          out Chrome's own much longer
 *                                          endpoint timeout.
 *
 *                     ->  onSegmentEnd ->  onPause again, because the final
 *                                          just delivered will have left a new
 *                                          remainder in the buffer.
 *
 * And while the detector reports silence, interim results are not forwarded at
 * all. Room tone produces phantom interims - "you", "thank you" - and those get
 * translated and spoken to the class if anything downstream believes them.
 */

export interface SpeechCaptureEvents {
  /** A recognition result. Interims are suppressed while the room is quiet. */
  onResult?: (text: string, isFinal: boolean) => void;
  /**
   * The speaker has paused and anything buffered downstream should be flushed.
   *
   * Always fires after the results it relates to, never before.
   */
  onPause?: () => void;
  onStateChange?: (state: RecognizerState, detail?: string) => void;
  onNotice?: (message: string) => void;
  /** Microphone level, 0-1, and whether the detector considers it speech. */
  onLevel?: (level: number, speaking: boolean) => void;
}

export class SpeechCapture {
  private recognizer: Recognizer;
  private vad: VoiceActivityDetector;
  private vadRunning = false;

  /**
   * Whether the recogniser is holding text it has not committed.
   *
   * Forcing a segment closed is only worth its restart cost when there is
   * something to force out. Without this the detector would tear down and
   * respawn recognition on every gap between sentences, including the ones
   * where the professor had already finished cleanly.
   */
  private hasUncommitted = false;

  /** Set while a forced close is in flight, so one pause closes one segment. */
  private closing = false;

  constructor(
    lang: LangCode,
    private events: SpeechCaptureEvents = {},
    vadOptions: VadOptions = {},
  ) {
    this.recognizer = new Recognizer(lang, {
      onResult: (text, isFinal) => this.handleResult(text, isFinal),
      onStateChange: events.onStateChange,
      onNotice: events.onNotice,
      onSegmentEnd: () => this.handleSegmentEnd(),
    });

    this.vad = new VoiceActivityDetector(
      {
        onPause: () => this.handleMicroPause(),
        onSpeechEnd: () => this.handleSpeechEnd(),
        onLevel: events.onLevel,
        // Not an error. Capture still works; it just falls back to the
        // recogniser's own endpointing, which is what happened before the
        // detector existed. Worth saying once, not worth alarming anyone.
        onUnavailable: (reason) => {
          this.vadRunning = false;
          events.onNotice?.(`${reason} Falling back to browser endpointing.`);
        },
      },
      vadOptions,
    );
  }

  get currentState(): RecognizerState {
    return this.recognizer.currentState;
  }

  /** True when pause detection is actually running, not merely wired up. */
  get isGated(): boolean {
    return this.vadRunning;
  }

  start(): void {
    this.recognizer.start();
    // Deliberately not awaited. Recognition must not wait on a permission
    // prompt for a second microphone; if the detector never starts, capture
    // carries on without it.
    void this.vad.start().then((ok) => {
      this.vadRunning = ok;
    });
  }

  setLang(lang: LangCode): void {
    this.recognizer.setLang(lang);
  }

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  private handleResult(text: string, isFinal: boolean): void {
    if (isFinal) {
      this.hasUncommitted = false;
      this.events.onResult?.(text, true);
      return;
    }

    // Interims arriving during silence are the recogniser hallucinating on room
    // tone. Dropping them costs nothing - a real word will raise the level and
    // the next interim carries the whole phrase anyway.
    if (this.vadRunning && !this.vad.isSpeaking) return;

    this.hasUncommitted = true;
    this.events.onResult?.(text, false);
  }

  /** 200ms of silence: flush downstream, touch nothing here. */
  private handleMicroPause(): void {
    this.events.onPause?.();
  }

  /** 300ms of silence: make the recogniser commit what it is sitting on. */
  private handleSpeechEnd(): void {
    if (!this.hasUncommitted || this.closing) return;
    this.closing = true;
    this.recognizer.endSegment();
  }

  /**
   * A segment closed and its finals have been delivered.
   *
   * The flush is issued here rather than from the pause because only now is the
   * text it needs to flush actually on the server. Issuing it earlier would
   * flush an empty buffer and leave the real remainder behind.
   */
  private handleSegmentEnd(): void {
    this.closing = false;
    this.hasUncommitted = false;
    this.events.onPause?.();
  }

  stop(): void {
    this.recognizer.stop();
    this.vad.stop();
    this.vadRunning = false;
    this.hasUncommitted = false;
    this.closing = false;
  }

  dispose(): void {
    this.stop();
    this.recognizer.dispose();
  }
}
