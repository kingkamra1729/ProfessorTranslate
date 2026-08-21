import { randomUUID } from 'node:crypto';
import type { WebSocket } from 'ws';
import {
  isLangCode,
  type GlossaryTerm,
  type LangCode,
  type LectureMeta,
  type ServerMessage,
  type TermSuggestion,
  type Translation,
  type Utterance,
  type VizSpec,
} from '@suvidha/shared';
import { buildMatcher, type TermMatcher } from './pipeline/glossary.js';
import { UtteranceBuffer } from './pipeline/segment.js';
import { scoutTerms, suggestionToTerm } from './pipeline/term-scout.js';
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

/**
 * How recently an identical final must have arrived to count as a duplicate.
 *
 * Short on purpose. A lecturer does repeat themselves for emphasis, and
 * suppressing that would be its own bug - but not usually within four seconds,
 * and not word for word.
 */
const DUPLICATE_WINDOW_MS = 4000;

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
  /**
   * Every connected professor socket, not just the most recent.
   *
   * A single slot looked sufficient - there is one lecturer - but it silently
   * drops the previous connection whenever a new one arrives. A professor who
   * reloads the page, whose laptop sleeps and reconnects, or who opens the
   * console on a second screen ends up with a window that looks live and
   * receives nothing. Holding a set means every open console stays current and
   * a stale socket simply falls out on close.
   */
  private professors = new Set<WebSocket>();
  private glossaryTerms: GlossaryTerm[];
  private ended = false;

  /**
   * Ordering state.
   *
   * Sentences are numbered as they are cut from the speech stream, while still
   * in spoken order, and each language keeps its own cursor. Translations that
   * finish early wait in `pendingByLang` until everything before them has gone
   * out, so a student never hears the second sentence of a thought before the
   * first.
   */
  /**
   * When this room last saw a professor or a spoken word.
   *
   * A lecture only ends when the professor presses the button, and quite often
   * nobody does - they shut the laptop, the tab crashes, the wifi drops. The
   * room then advertises itself as live on the home page indefinitely, so
   * students join a lecture that finished hours ago and wait for speech that
   * will never come.
   */
  private lastActivityAt = Date.now();

  /**
   * The last final text accepted, and when.
   *
   * A second line of defence against duplicated speech. The client has its own
   * guard, but two professor consoles open at once - a reload that left the old
   * tab running, a laptop and a tablet - both capture the same audio and both
   * send it, and no client-side check can see the other. Identical text within
   * a few seconds is a duplicate, not a lecturer saying the same sentence twice
   * word for word.
   */
  private lastFinal = { text: '', at: 0 };

  private nextSeq = 0;
  private pendingByLang = new Map<LangCode, Map<number, Translation>>();
  private nextEmitByLang = new Map<LangCode, number>();
  /**
   * Which sentences were dispatched for each language.
   *
   * Recorded synchronously at dispatch, before any await. A language only ever
   * waits on sentences that were actually sent for translation in that
   * language, which is what lets a student who switches language mid-lecture -
   * or joins late - receive the very next sentence instead of waiting behind
   * sequence numbers that were never theirs.
   */
  private dispatchedByLang = new Map<LangCode, Set<number>>();
  /** Suggestions awaiting the professor's decision. */
  private pendingSuggestions: TermSuggestion[] = [];
  /** Terms already offered, so a rejected one is not proposed again. */
  private offered = new Set<string>();

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

  private sendToProfessors(msg: ServerMessage): void {
    for (const socket of this.professors) send(socket, msg);
  }

  attachProfessor(socket: WebSocket): void {
    this.professors.add(socket);
    this.lastActivityAt = Date.now();
    send(socket, {
      type: 'joined',
      role: 'professor',
      lecture: this.meta,
      glossary: this.glossaryTerms,
    });
    this.broadcastCounts();
  }

  detachProfessor(socket: WebSocket): void {
    this.professors.delete(socket);
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
    this.sendToProfessors(msg);
    this.broadcastToStudents(msg);
  }

  private broadcastToStudents(msg: ServerMessage, lang?: LangCode): void {
    for (const l of this.listeners) {
      if (lang && l.lang !== lang) continue;
      send(l.socket, msg);
    }
  }

  broadcastAll(msg: ServerMessage): void {
    this.sendToProfessors(msg);
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
    this.lastActivityAt = Date.now();

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

    const now = Date.now();
    if (trimmed === this.lastFinal.text && now - this.lastFinal.at < DUPLICATE_WINDOW_MS) {
      console.warn(`[room ${this.meta.id}] dropped duplicate speech: ${trimmed.slice(0, 60)}`);
      return;
    }
    this.lastFinal = { text: trimmed, at: now };

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

  /**
   * Handles the client reporting that the speaker has stopped.
   *
   * The segmenter holds back any tail that has not reached a boundary, waiting
   * for the rest of the clause. When the professor actually stops talking there
   * is no rest of the clause coming, and holding it is strictly worse than
   * sending it short: the tail does not merely arrive late, it is prepended to
   * the next sentence and garbles that one too.
   *
   * The pause signal is what tells us the difference between "mid-thought" and
   * "finished". Nothing else on the server can know it - a recognition result
   * looks identical either way.
   */
  async notePause(t: number): Promise<void> {
    if (this.ended || this.buffer.isEmpty) return;
    this.lastActivityAt = Date.now();
    await this.flushBuffer(t);
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

    // Sequence number assigned here, where chunks are still in spoken order.
    const seq = this.nextSeq++;

    this.accumulator.addUtterance(utterance);
    this.broadcastAll({ type: 'utterance', utterance });

    const targets = this.activeLangs();
    if (targets.length === 0) return;

    // Recorded before any await, so the dispatch record is complete for this
    // sequence before a translation for it can possibly come back.
    for (const lang of targets) {
      const set = this.dispatchedByLang.get(lang) ?? new Set<number>();
      set.add(seq);
      this.dispatchedByLang.set(lang, set);
    }

    // Languages are dispatched independently, so a French student never waits
    // on the Bengali rendering. But sentences within one language must still
    // arrive in the order they were spoken - see `emitInOrder`.
    await Promise.all(
      targets.map(async (lang) => {
        const translation = await translateUtterance({
          utteranceId: utterance.id,
          text,
          from: this.meta.instructionLang,
          to: lang,
          matcher: this.matcher,
          // Partials are sent as they arrive, deliberately bypassing the
          // ordering queue below. They are throwaway subtitle text for one
          // specific line, addressed by utterance id, so a later sentence
          // showing its partial early cannot reorder anything the student
          // reads - and waiting would defeat the entire point.
          onPartial: (partialText) => {
            this.broadcastToStudents(
              {
                type: 'translation-partial',
                utteranceId: utterance.id,
                lang,
                text: partialText,
              },
              lang,
            );
          },
        });
        this.accumulator.addTranslation(translation);
        this.emitInOrder(lang, seq, translation);
      }),
    );
  }

  /**
   * Delivers translations to students in the order the sentences were spoken.
   *
   * A single recognition result often contains two or three sentences, and they
   * are translated concurrently. The short one finishes first. Broadcasting on
   * completion therefore delivers them out of order, and while the subtitle view
   * survives that - it places lines by utterance id - the audio does not. The
   * student simply hears the second sentence before the first, with nothing on
   * screen to indicate it happened.
   *
   * So a completed translation waits until every earlier sentence in its own
   * language has gone out. Per language, because a slow Bengali rendering must
   * not hold up French.
   */
  private emitInOrder(lang: LangCode, seq: number, translation: Translation): void {
    const pending = this.pendingByLang.get(lang) ?? new Map<number, Translation>();
    pending.set(seq, translation);
    this.pendingByLang.set(lang, pending);
    this.drain(lang);
  }

  /**
   * Sends everything that is now contiguous from this language's cursor.
   *
   * The cursor advances past any sequence that was never dispatched for this
   * language, which covers both a sentence spoken while nobody was listening
   * and every sentence that preceded a student switching into this language.
   * It stops at a dispatched sequence whose translation has not arrived yet -
   * that one is genuinely still in flight and everything after it must wait.
   */
  private drain(lang: LangCode): void {
    const pending = this.pendingByLang.get(lang);
    const dispatched = this.dispatchedByLang.get(lang);
    if (!pending || !dispatched) return;

    let next = this.nextEmitByLang.get(lang) ?? 0;
    while (next < this.nextSeq) {
      if (!dispatched.has(next)) {
        next++;
        continue;
      }
      const ready = pending.get(next);
      if (!ready) break;

      pending.delete(next);
      this.broadcastToStudents({ type: 'translation', translation: ready }, lang);
      this.sendToProfessors({ type: 'translation', translation: ready });
      next++;
    }
    this.nextEmitByLang.set(lang, next);
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
    this.sendToProfessors({ type: 'viz', viz });
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
   * Term scouting
   * ---------------------------------------------------------------- */

  /**
   * Looks for subject vocabulary the glossary is missing.
   *
   * Driven from a timer rather than per-utterance, and it declines whenever the
   * request budget is under pressure, because nothing here is worth a
   * millisecond of added audio latency.
   */
  async scoutForTerms(): Promise<void> {
    if (this.ended || this.pendingSuggestions.length > 0) return;

    const recent = this.accumulator.recentUtterances(10);
    const text = recent.map((u) => u.text).join(' ').trim();
    if (text.length < 160) return;

    const found = await scoutTerms({ text, glossary: this.glossaryTerms });

    // A term the professor has already been shown, and by implication chosen
    // not to add, must not come back every twenty seconds.
    const fresh = found.filter((s) => !this.offered.has(s.term.toLowerCase()));
    if (fresh.length === 0) return;

    for (const s of fresh) this.offered.add(s.term.toLowerCase());
    this.pendingSuggestions = fresh;

    this.sendToProfessors({ type: 'term-suggestions', suggestions: fresh });
  }

  /**
   * Adds accepted suggestions to the live glossary.
   *
   * Takes effect on the next utterance, so a term accepted mid-lecture protects
   * the rest of the lecture.
   */
  acceptSuggestions(accepted: TermSuggestion[]): void {
    this.pendingSuggestions = [];
    if (accepted.length === 0) return;

    const additions = accepted.map((s, i) => suggestionToTerm(s, this.glossaryTerms.length + i));
    // Newest first: a term the professor just confirmed they are using outranks
    // a pack entry they never looked at.
    this.updateGlossary([...additions, ...this.glossaryTerms]);
  }

  dismissSuggestions(): void {
    this.pendingSuggestions = [];
  }

  /**
   * True when this room has been silent with nobody teaching for long enough
   * that it is certainly over.
   *
   * Requires both conditions. A professor who is connected but writing on the
   * board in silence is still teaching, and a room that is briefly
   * professor-less because their laptop is reconnecting has not ended either.
   */
  isStale(idleMs: number): boolean {
    if (this.ended) return false;
    if (this.professors.size > 0) return false;
    return Date.now() - this.lastActivityAt > idleMs;
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

/** How long a professor-less, silent room stays listed before it is retired. */
export const STALE_ROOM_MS = 20 * 60 * 1000;

export function listRooms(): LectureMeta[] {
  return [...rooms.values()]
    .filter((r) => !r.isEnded && !r.isStale(STALE_ROOM_MS))
    .map((r) => ({ ...r.meta, utteranceCount: r.accumulator.transcriptLength }));
}

/**
 * Ends rooms that were abandoned rather than finished.
 *
 * Archiving rather than discarding: the transcript is the professor's work and
 * the students' revision material, and the fact that nobody pressed the button
 * is no reason to throw it away.
 */
export async function sweepStaleRooms(): Promise<string[]> {
  const retired: string[] = [];
  for (const room of rooms.values()) {
    if (!room.isStale(STALE_ROOM_MS)) continue;
    try {
      await room.end();
      retired.push(room.meta.id);
    } catch (err) {
      console.warn('[rooms] could not retire', room.meta.id, err);
    }
  }
  return retired;
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
