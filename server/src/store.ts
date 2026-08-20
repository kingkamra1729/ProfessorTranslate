import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  GlossaryTerm,
  LangCode,
  LectureMeta,
  LectureRecording,
  Translation,
  Utterance,
  VizSpec,
} from '@suvidha/shared';
import { config } from './config.js';

/**
 * Lecture archive.
 *
 * Recordings are plain JSON on disk. A hackathon does not need a database, and
 * a transcript that a student can open, read and search without our software
 * is a better artefact than one locked in a schema.
 *
 * What is stored is not audio. It is the transcript, every translation of it,
 * the glossary that was active, and the visuals - which means replay can be
 * re-voiced in any language later, at any speed, by a screen reader, or read
 * silently. Storing audio would have fixed the language at recording time.
 */

function lecturePath(id: string): string {
  return join(config.dataDir, `lecture-${id}.json`);
}

async function ensureDataDir(): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
}

/** Rejects ids that could escape the data directory. */
function assertSafeId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error(`Unsafe lecture id: ${id}`);
  }
}

export async function saveRecording(rec: LectureRecording): Promise<void> {
  assertSafeId(rec.id);
  await ensureDataDir();
  await writeFile(lecturePath(rec.id), JSON.stringify(rec, null, 2), 'utf8');
}

export async function loadRecording(id: string): Promise<LectureRecording | null> {
  assertSafeId(id);
  try {
    const raw = await readFile(lecturePath(id), 'utf8');
    return JSON.parse(raw) as LectureRecording;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Lists archived lectures, newest first, without loading full transcripts. */
export async function listRecordings(): Promise<LectureMeta[]> {
  await ensureDataDir();
  let files: string[];
  try {
    files = await readdir(config.dataDir);
  } catch {
    return [];
  }

  const metas: LectureMeta[] = [];
  for (const file of files) {
    if (!file.startsWith('lecture-') || !file.endsWith('.json')) continue;
    try {
      const raw = await readFile(join(config.dataDir, file), 'utf8');
      const rec = JSON.parse(raw) as LectureRecording;
      metas.push({
        id: rec.id,
        title: rec.title,
        course: rec.course,
        instructor: rec.instructor,
        instructionLang: rec.instructionLang,
        startedAt: rec.startedAt,
        endedAt: rec.endedAt,
        utteranceCount: rec.utterances?.length ?? 0,
      });
    } catch {
      // A half-written file from a crashed session should not break the list.
      continue;
    }
  }

  return metas.sort((a, b) => b.startedAt - a.startedAt);
}

/* ------------------------------------------------------------------ *
 * In-memory accumulation during a live lecture
 * ------------------------------------------------------------------ */

/**
 * Collects a lecture as it happens, then writes it once at the end.
 *
 * Writing on every utterance would mean a disk write every couple of seconds
 * for every concurrent lecture; the whole transcript of a ninety-minute lecture
 * is a few hundred kilobytes and comfortably fits in memory. `snapshot()`
 * exists so a crash-tolerant caller can checkpoint periodically anyway.
 */
export class LectureAccumulator {
  private utterances: Utterance[] = [];
  private translations = new Map<string, Translation[]>();
  private visuals: VizSpec[] = [];

  constructor(
    readonly meta: LectureMeta,
    private glossary: GlossaryTerm[],
  ) {}

  addUtterance(u: Utterance): void {
    // Interim results are revisions of the same utterance, not new ones.
    const existing = this.utterances.findIndex((x) => x.id === u.id);
    if (existing >= 0) this.utterances[existing] = u;
    else this.utterances.push(u);
  }

  addTranslation(tr: Translation): void {
    const list = this.translations.get(tr.utteranceId) ?? [];
    const existing = list.findIndex((x) => x.lang === tr.lang);
    if (existing >= 0) list[existing] = tr;
    else list.push(tr);
    this.translations.set(tr.utteranceId, list);
  }

  addVisual(v: VizSpec): void {
    const existing = this.visuals.findIndex((x) => x.id === v.id);
    if (existing >= 0) this.visuals[existing] = v;
    else this.visuals.push(v);
  }

  setGlossary(terms: GlossaryTerm[]): void {
    this.glossary = terms;
  }

  get transcriptLength(): number {
    return this.utterances.length;
  }

  /**
   * The last `n` finalised utterances.
   *
   * Kept separate from `snapshot()` because the visualisation timer polls this
   * every few seconds and has no use for a deep copy of the whole lecture.
   */
  recentUtterances(n: number): Utterance[] {
    const finals = this.utterances.filter((u) => u.final);
    return finals.slice(Math.max(0, finals.length - n));
  }

  /** Languages this lecture has actually been translated into so far. */
  get translatedLangs(): LangCode[] {
    const set = new Set<LangCode>();
    for (const list of this.translations.values()) {
      for (const tr of list) set.add(tr.lang);
    }
    return [...set];
  }

  snapshot(endedAt?: number): LectureRecording {
    return {
      ...this.meta,
      endedAt,
      utteranceCount: this.utterances.length,
      // Only finalised utterances belong in an archive; interim text is noise.
      utterances: this.utterances.filter((u) => u.final),
      translations: Object.fromEntries(this.translations),
      glossary: this.glossary,
      visuals: this.visuals.filter((v) => v.status === 'approved'),
    };
  }

  async persist(endedAt?: number): Promise<void> {
    await saveRecording(this.snapshot(endedAt));
  }
}
