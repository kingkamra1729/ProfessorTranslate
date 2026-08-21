/**
 * Voice activity detection.
 *
 * This is the gatekeeper on the microphone. It watches the audio and reports
 * two things the rest of the capture path cannot work out on its own: when the
 * professor started talking, and when they stopped.
 *
 * Why it earns its place: the browser's speech recogniser has its own idea of
 * when an utterance has ended, and that idea is slow - it waits out a long
 * silence before committing a final result, and every millisecond of that wait
 * is a millisecond the student spends staring at a half-finished subtitle.
 * Detecting the pause ourselves lets the capture layer close the segment the
 * moment the speaker actually stops, which is the single largest saving
 * available on the path from spoken word to translated line.
 *
 * It also stops the recogniser being fed silence. A lecturer writing on the
 * board is thirty seconds of room tone, and forwarding that produces phantom
 * interim results - "you", "thank you", "the" - which are then translated and
 * spoken to the class.
 *
 * The detector never touches the recogniser's audio. It opens its own capture
 * of the same device and observes; the recogniser keeps the microphone it
 * already had. Two readers of one input stream, which is what the Web Speech
 * API's lack of any audio ingress leaves available.
 */

export interface VadOptions {
  /**
   * Silence, in ms, before the speaker is considered to have stopped.
   *
   * This is the segment boundary: at this point the capture layer forces the
   * recogniser to commit whatever it has. Too short and a mid-sentence breath
   * cuts a clause in half; too long and the saving disappears. 300ms is roughly
   * the gap between clauses in unhurried speech and well below the ~700ms gap
   * that separates sentences.
   */
  silenceMs?: number;
  /**
   * Silence, in ms, before a micro-pause is reported.
   *
   * Fires earlier than `silenceMs` and does something cheaper: it tells the
   * server to flush any text still sitting in the chunk buffer. Nothing is
   * interrupted and no audio is cut, so it can afford to be twitchy.
   */
  pauseMs?: number;
  /** Continuous speech, in ms, before onset is declared. Rejects door slams. */
  onsetMs?: number;
  /**
   * Fraction of total energy that must sit in the speech band for a loud frame
   * to count as a voice. Rejects hum, hiss, and the projector fan.
   */
  minVoiceBandRatio?: number;
  /** Absolute RMS floor, below which nothing is ever speech. */
  noiseGate?: number;
}

export interface VadEvents {
  /** The speaker has started. */
  onSpeechStart?: () => void;
  /** `pauseMs` of silence has elapsed. Fires once per silence run. */
  onPause?: () => void;
  /** `silenceMs` of silence has elapsed. Fires once per silence run. */
  onSpeechEnd?: (speechDurationMs: number) => void;
  /** Every frame, for a level meter. `level` is 0-1, already smoothed. */
  onLevel?: (level: number, speaking: boolean) => void;
  /** The detector could not start. Capture continues without it. */
  onUnavailable?: (reason: string) => void;
}

/** How often the analyser is sampled. 20ms is one frame of typical speech. */
const HOP_MS = 20;

/** The band human speech actually occupies, in Hz. */
const VOICE_BAND_LOW_HZ = 85;
const VOICE_BAND_HIGH_HZ = 3400;

export class VoiceActivityDetector {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private timeBuf = new Float32Array(0);
  private freqBuf = new Uint8Array(0);

  /**
   * Running estimate of the room, updated only while nobody is speaking.
   *
   * A fixed threshold cannot work: the same number is deaf in a lecture hall
   * with two hundred people in it and hair-triggered in a quiet office. Tracking
   * the floor means the detector calibrates itself to whatever room it is
   * actually in, within a second or so of starting.
   */
  private noiseFloor = 0.01;
  private level = 0;

  private speaking = false;
  private speechRunMs = 0;
  private silenceRunMs = 0;
  private onsetRunMs = 0;
  private pauseFired = false;
  private endFired = false;

  private readonly silenceMs: number;
  private readonly pauseMs: number;
  private readonly onsetMs: number;
  private readonly minVoiceBandRatio: number;
  private readonly noiseGate: number;

  constructor(
    private events: VadEvents = {},
    options: VadOptions = {},
  ) {
    this.silenceMs = options.silenceMs ?? 300;
    this.pauseMs = options.pauseMs ?? 200;
    this.onsetMs = options.onsetMs ?? 60;
    this.minVoiceBandRatio = options.minVoiceBandRatio ?? 0.35;
    this.noiseGate = options.noiseGate ?? 0.006;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /**
   * Opens the microphone and starts observing.
   *
   * Resolves either way. A detector that cannot start is not a reason to stop
   * a lecture - the capture path falls back to the recogniser's own endpointing,
   * which is what it did before this existed.
   */
  async start(): Promise<boolean> {
    if (this.ctx) return true;

    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      this.events.onUnavailable?.('This browser cannot open the microphone for analysis.');
      return false;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // The browser's own processing is left on. It is tuned for exactly
          // this signal, and fighting it with raw capture makes the detector
          // worse, not more honest.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      this.events.onUnavailable?.(
        err instanceof Error && err.name === 'NotAllowedError'
          ? 'Microphone permission was denied, so pause detection is off.'
          : 'No microphone available for pause detection.',
      );
      return false;
    }

    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

    if (!Ctor) {
      this.releaseStream();
      this.events.onUnavailable?.('This browser has no Web Audio support.');
      return false;
    }

    this.ctx = new Ctor();
    // Autoplay policy suspends a context created outside a gesture. The mic
    // button is a gesture, so this normally resolves immediately.
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => undefined);

    const source = this.ctx.createMediaStreamSource(this.stream);
    const analyser = this.ctx.createAnalyser();
    // 1024 samples is ~21ms at 48kHz: one hop, so every frame is fresh.
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    // Deliberately not connected to the destination - this must never be
    // audible, and routing it to the speakers would feed back into the mic.
    this.analyser = analyser;

    this.timeBuf = new Float32Array(analyser.fftSize);
    this.freqBuf = new Uint8Array(analyser.frequencyBinCount);

    this.timer = setInterval(() => this.tick(), HOP_MS);
    return true;
  }

  private tick(): void {
    const analyser = this.analyser;
    const ctx = this.ctx;
    if (!analyser || !ctx) return;

    analyser.getFloatTimeDomainData(this.timeBuf);
    analyser.getByteFrequencyData(this.freqBuf);

    let sumSquares = 0;
    for (let i = 0; i < this.timeBuf.length; i++) {
      const sample = this.timeBuf[i];
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / this.timeBuf.length);

    const loud = rms > this.noiseGate && rms > this.noiseFloor * 2.5;
    const voiced = loud && this.voiceBandRatio(ctx.sampleRate) >= this.minVoiceBandRatio;

    // The floor only learns from frames that are not speech, or it would climb
    // to match the speaker and then stop hearing them.
    if (!voiced) this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;

    this.level = this.level * 0.7 + Math.min(1, rms * 12) * 0.3;
    this.events.onLevel?.(this.level, this.speaking);

    if (voiced) this.onFrameVoiced();
    else this.onFrameSilent();
  }

  /** Share of spectral energy inside the band human speech occupies. */
  private voiceBandRatio(sampleRate: number): number {
    const binHz = sampleRate / 2 / this.freqBuf.length;
    const lowBin = Math.max(1, Math.floor(VOICE_BAND_LOW_HZ / binHz));
    const highBin = Math.min(this.freqBuf.length - 1, Math.ceil(VOICE_BAND_HIGH_HZ / binHz));

    let band = 0;
    let total = 0;
    for (let i = 1; i < this.freqBuf.length; i++) {
      const v = this.freqBuf[i];
      total += v;
      if (i >= lowBin && i <= highBin) band += v;
    }
    return total > 0 ? band / total : 0;
  }

  private onFrameVoiced(): void {
    this.silenceRunMs = 0;

    if (this.speaking) {
      this.speechRunMs += HOP_MS;
      return;
    }

    // Onset needs to persist. A single loud frame is a chair, a cough, or the
    // door; requiring `onsetMs` of it is what makes those free.
    this.onsetRunMs += HOP_MS;
    if (this.onsetRunMs < this.onsetMs) return;

    this.speaking = true;
    this.speechRunMs = this.onsetRunMs;
    this.onsetRunMs = 0;
    this.pauseFired = false;
    this.endFired = false;
    this.events.onSpeechStart?.();
  }

  private onFrameSilent(): void {
    this.onsetRunMs = 0;
    if (!this.speaking && this.endFired) return;

    this.silenceRunMs += HOP_MS;

    if (!this.pauseFired && this.silenceRunMs >= this.pauseMs) {
      this.pauseFired = true;
      this.events.onPause?.();
    }

    if (!this.endFired && this.silenceRunMs >= this.silenceMs) {
      this.endFired = true;
      const spoken = this.speechRunMs;
      this.speaking = false;
      this.speechRunMs = 0;
      this.events.onSpeechEnd?.(spoken);
    }
  }

  private releaseStream(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.analyser = null;
    this.releaseStream();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.speaking = false;
    this.speechRunMs = 0;
    this.silenceRunMs = 0;
    this.onsetRunMs = 0;
    this.level = 0;
  }
}

export function isVadSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    Boolean(
      window.AudioContext ??
        (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext,
    )
  );
}
