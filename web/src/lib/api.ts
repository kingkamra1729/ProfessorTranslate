import type { GlossaryTerm, LangCode, LectureMeta, LectureRecording, VizSpec } from '@suvidha/shared';
import { apiUrl } from './config';

/**
 * Thin REST client.
 *
 * Paths are relative in local development and in a single-host deployment, and
 * absolute against VITE_SERVER_URL when the frontend and server are on separate
 * hosts - which is what deploying the frontend to Vercel requires.
 */

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* Non-JSON error body; the status line will have to do. */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export interface ServiceStatus {
  name: string;
  enabled: boolean;
  detail: string;
}

export const api = {
  health: () => req<{ ok: boolean; services: ServiceStatus[] }>('/api/health'),

  packs: () =>
    req<Array<{ id: string; name: string; description: string; termCount: number }>>('/api/packs'),

  createLecture: (body: {
    title: string;
    course: string;
    instructor: string;
    instructionLang: LangCode;
    packIds: string[];
    extraTerms: string[];
  }) =>
    req<{ lecture: LectureMeta; glossary: GlossaryTerm[] }>('/api/lectures', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getLecture: (id: string) =>
    req<{ lecture: LectureMeta; glossary: GlossaryTerm[]; listeners: number }>(
      `/api/lectures/${encodeURIComponent(id)}`,
    ),

  liveLectures: () => req<LectureMeta[]>('/api/lectures'),

  recordings: () => req<LectureMeta[]>('/api/recordings'),

  recording: (id: string) => req<LectureRecording>(`/api/recordings/${encodeURIComponent(id)}`),

  buildGlossary: (body: { url?: string; text?: string; subject?: string }) =>
    req<{ terms: GlossaryTerm[] }>('/api/glossary/build', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  updateGlossary: (id: string, terms: GlossaryTerm[]) =>
    req<{ ok: boolean; count: number }>(`/api/lectures/${encodeURIComponent(id)}/glossary`, {
      method: 'PUT',
      body: JSON.stringify({ terms }),
    }),

  visualize: (prompt: string, lectureId: string) =>
    req<VizSpec>('/api/visualize', {
      method: 'POST',
      body: JSON.stringify({ prompt, lectureId }),
    }),
};
