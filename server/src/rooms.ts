import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  isLangCode,
  type GlossaryTerm,
  type LangCode,
  type LectureMeta,
  type ServerMessage,
  type Utterance,
  type VizSpec,
} from '@suvidha/shared';
import { buildMatcher, type TermMatcher } from './pipeline/glossary.js';
import { UtteranceBuffer } from './pipeline/segment.js';
import { translateUtterance } from './pipeline/translate.js';
import { LectureAccumulator } from './store.js';

/**
 * A live lecture room: one professor, many students, each listening in the
 * language they think in.
 */

export interface Listener {
  socket: WebSocket;
  lang: LangCode;
}

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) {
    socket.send(JSON.stringify(msg));
  }
}

export class Room {
  readonly accumulator: LectureAccumulator;
  private matcher: TermMatcher;
  private buffer = new UtteranceBuffer();
  private listeners = new Set<Listener>();
  private professor: WebSocket | null = null;
  private glossaryTerms: GlossaryTerm[];
  private ended = false;

  constructor(
    readonly meta: LectureMeta,
    glossary: GlossaryTerm[],
  ) {
    this.glossaryTerms = glossary;
    this.matcher = buildMatcher(glossary);
    this.accumulator = new LectureAccumulator(meta, glossary);
  }

  get glossary(): GlossaryTerm[] {
    return this.glossaryTerms;
  }

  get isEnded(): boolean {
    return this.ended;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /* ---------------------------------------------------------------- *
   * Membership
   * ---------------------------------------------------------------- */

  attachProfessor(socket: WebSocket): void {
    this.professor = socket;
    send(socket, {
      type: 'joined',
      role: 'professor',
      lecture: this.meta,
      glossary: this.glossaryTerms,
    });
    this.broadcastCounts();
  }

  detachProfessor(socket: WebSocket): void {
    if (this.professor === socket) this.professor = null;
  }

  addListener(socket: WebSocket, lang: LangCode): Listener {
    const listener: Listener = { socket, lang };
    this.listeners.add(listener);
    send(socket, {
      type: 'joined',
      role: 'student',
      lecture: this.meta,
      glossary: this.glossaryTerms,
    });
    this.broadcastCounts();
    return listener;
  }

  removeListener(listener: Listener): void {
    this.listeners.delete(listener);
    this.broadcastCounts();
  }

  setListenerLang(listener: Listener, lang: LangCode): void {
    listener.lang = lang;
    this.broadcastCounts();
  }

  /**
   * Languages currently being listened to.
   *
   * Translation is driven by this set rather than by the full language list.
   * Rendering a lecture into Bengali that nobody in the room is listening to
   * costs latency for the students who *are* listening, because the calls share
   * the same rate limit. The replay view can translate on demand afterwards.
   */
  private activeLangs(): LangCode[] {
    const set = new Set<LangCode>();
    for (const l of this.listeners) {
      if (l.lang !== this.meta.instructionLang) set.add(l.lang);
    }
    return [...set];
  }

  private broadcastCounts(): void {
    const counts: Partial<Record<LangCode, number>> = {};
    for (const l of this.listeners) {
      counts[l.lang] = (counts[l.lang] ?? 0) + 1;
    }
    const msg: ServerMessage = { type: 'listeners', counts, total: this.listeners.size };
    if (this.professor) send(this.professor, msg);
    this.broadcastToStudents(msg);
  }

  private broadcastToStudents(msg: ServerMessage, lang?: LangCode): void {
    for (const l of this.listeners) {
      if (lang && l.lang !== lang) continue;
      send(l.socket, msg);
    }
  }

  broadcastAll(msg: ServerMessage): void {
    if (this.professor) send(this.professor, msg);
    this.broadcastToStudents(msg);
  }

  /* ---------------------------------------------------------------- *
   * Speech in
   * ---------------------------------------------------------------- */

  /**
   * Handles one recognition result from the professor's microphone.
   *
   * Interim results are forwarded for the live caption but never translated -
   * they get revised two or three times a second, and translating a sentence
   * that is about to change wastes the call and makes the audio stutter.
   */
  async handleSpeech(text: string, final: boolean, t: number): Promise<void> {
    if (this.ended) return;
    const trimmed = text.trim();
    if (!trimmed) return;

    if (!final) {
      const interim: Utterance = {
        id: `interim-${this.meta.id}`,
        lectureId: this.meta.id,
        t,
        text: trimmed,
        termIds: [],
        final: false,
      };
      this.broadcastAll({ type: 'utterance', utterance: interim });
      return;
    }

    // Re-cut the final result on sentence boundaries before translating.
    for (const chunk of this.buffer.push(trimmed)) {
      void this.processChunk(chunk, t);
    }
  }

  /** Emits anything held back by the segmenter. */
  async flushBuffer(t: number): Promise<void> {
    for (const chunk of this.buffer.flush()) {
      void this.processChunk(chunk, t);
    }
  }

  private async processChunk(text: string, t: number): Promise<void> {
    const utterance: Utterance = {
      id: randomUUID(),
      lectureId: this.meta.id,
      t,
      text,
      termIds: [],
      final: true,
    };

    this.accumulator.addUtterance(utterance);
    this.broadcastAll({ type: 'utterance', utterance });

    const targets = this.activeLangs();
    if (targets.length === 0) return;

    // Each language is dispatched independently and delivered the moment it
    // lands. Waiting for all of them would hold every student to the speed of
    // the slowest rendering.
    await Promise.all(
      targets.map(async (lang) => {
        const translation = await translateUtterance({
          utteranceId: utterance.id,
          text,
          from: this.meta.instructionLang,
          to: lang,
          matcher: this.matcher,
        });
        this.accumulator.addTranslation(translation);
        this.broadcastToStudents({ type: 'translation', translation }, lang);
        if (this.professor) send(this.professor, { type: 'translation', translation });
      }),
    );
  }

  /* ---------------------------------------------------------------- *
   * Glossary and visuals
   * ---------------------------------------------------------------- */

  updateGlossary(terms: GlossaryTerm[]): void {
    this.glossaryTerms = terms;
    this.matcher = buildMatcher(terms);
    this.accumulator.setGlossary(terms);
    this.broadcastAll({ type: 'glossary', glossary: terms });
  }

  /** Sends a proposed visual to the professor for approval, not to students. */
  proposeVisual(viz: VizSpec): void {
    this.accumulator.addVisual(viz);
    if (this.professor) send(this.professor, { type: 'viz', viz });
  }

  /**
   * Publishes an approved visual to the room.
   *
   * The approval gate is the point. An unreviewed generated diagram appearing
   * on two hundred screens mid-lecture is a way to teach the wrong thing very
   * efficiently.
   */
  publishVisual(viz: VizSpec): void {
    this.accumulator.addVisual(viz);
    this.broadcastAll({ type: 'viz', viz });
  }

  findVisual(id: string): VizSpec | undefined {
    return this.accumulator.snapshot().visuals.find((v) => v.id === id);
  }

  /* ---------------------------------------------------------------- *
   * Teardown
   * ---------------------------------------------------------------- */

  async end(): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    await this.flushBuffer(Date.now() - this.meta.startedAt);
    // Give in-flight translations a moment to land before archiving.
    await new Promise((r) => setTimeout(r, 400));
    await this.accumulator.persist(Date.now());
    this.broadcastAll({ type: 'lecture-ended', lectureId: this.meta.id });
  }
}

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

const rooms = new Map<string, Room>();

export function createRoom(
  meta: Omit<LectureMeta, 'id' | 'startedAt'> & { id?: string },
  glossary: GlossaryTerm[],
): Room {
  const id = meta.id ?? shortId();
  const full: LectureMeta = { ...meta, id, startedAt: Date.now() };
  const room = new Room(full, glossary);
  rooms.set(id, room);
  return room;
}

export function getRoom(id: string): Room | undefined {
  return rooms.get(id);
}

export function listRooms(): LectureMeta[] {
  return [...rooms.values()]
    .filter((r) => !r.isEnded)
    .map((r) => ({ ...r.meta, utteranceCount: r.accumulator.transcriptLength }));
}

export function closeRoom(id: string): void {
  rooms.delete(id);
}

/**
 * A short, unambiguous room code students can type from the back of the hall.
 *
 * Excludes the characters that get misread off a projector - 0/O, 1/I/L - which
 * matters more than entropy for a code that lives for one lecture.
 */
export function shortId(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

export function parseLang(v: unknown, fallback: LangCode = 'en'): LangCode {
  return isLangCode(v) ? v : fallback;
}
