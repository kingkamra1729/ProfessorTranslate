import { randomUUID } from 'node:crypto';
import { LANGUAGES, type LangCode, type VizKind, type VizSpec } from '@suvidha/shared';
import { chatWithRetry, gateStatus, isConfigured } from '../providers/featherless.js';
import { alphaShortAnswer, isWolframConfigured, render } from '../providers/wolfram.js';
import { config } from '../config.js';
import type { Room } from '../rooms.js';
import { buildMatcher } from './glossary.js';
import { translateUtterance } from './translate.js';

/**
 * Visualisation.
 *
 * A lecturer saying "so this decays exponentially and then oscillates" is
 * describing a picture they can see and the class cannot. This module turns
 * that sentence into the picture.
 *
 * Two design decisions worth defending:
 *
 *   - Nothing reaches a student without the professor approving it. Generated
 *     diagrams are confidently wrong often enough that pushing them straight to
 *     two hundred screens would be teaching malpractice.
 *   - Every graphic carries a spoken description, translated like any other
 *     explanation. A student who cannot see the plot hears what it shows. This
 *     is the same feature as translation, pointed at a different barrier.
 */

const VIZ_KINDS: VizKind[] = [
  'function2d',
  'parametric2d',
  'surface3d',
  'vectorfield',
  'wolfram',
  'formula',
];

interface VizDraft {
  visualise: boolean;
  kind?: VizKind;
  title?: string;
  expression?: string;
  query?: string;
  domain?: { xMin: number; xMax: number; yMin?: number; yMax?: number };
  altText?: string;
  reason?: string;
}

/* ------------------------------------------------------------------ *
 * Drafting
 * ------------------------------------------------------------------ */

const DRAFT_SYSTEM = [
  'You turn a fragment of university lecture speech into a specification for a single mathematical or scientific diagram.',
  '',
  'Reply with ONE JSON object and nothing else. No markdown fence, no commentary.',
  '',
  'Schema:',
  '{',
  '  "visualise": boolean,',
  '  "kind": "function2d" | "parametric2d" | "surface3d" | "vectorfield" | "wolfram" | "formula",',
  '  "title": string,              // short label, under 60 characters',
  '  "expression": string,          // Wolfram Language, e.g. Plot[Sin[x]/x, {x, -20, 20}]',
  '  "query": string,               // the same request in plain English, as a Wolfram|Alpha query',
  '  "domain": { "xMin": number, "xMax": number, "yMin": number, "yMax": number },',
  '  "altText": string,             // 1-2 sentences describing the SHAPE of the graphic for a student who cannot see it',
  '  "reason": string               // why this helps, one clause',
  '}',
  '',
  'Rules:',
  '- Set "visualise": false when the speech is administrative, conversational, or has no single well-defined graphic. Most speech is not visualisable. Be strict; a wrong diagram is worse than no diagram.',
  '- "expression" must be valid Wolfram Language that evaluates to a graphic.',
  '- "altText" describes what the picture looks like - where it rises, falls, crosses zero, asymptotes - not what the topic is. Assume the listener knows the topic and cannot see the screen.',
  '- Keep technical terms in English inside "title" and "altText".',
].join('\n');

/** Truncates on a word boundary, so a fragment is never sent to Wolfram. */
function truncateWords(text: string, max: number): string {
  const clean = text.trim().replace(/\s+/g, ' ');
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trim();
}

function parseJsonObject(raw: string): VizDraft | null {
  let text = raw.trim();
  // Models wrap JSON in fences and prose no matter how firmly they are asked not to.
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  text = text.replace(/^<think>[\s\S]*?<\/think>\s*/i, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as VizDraft;
  } catch {
    return null;
  }
}

async function draftSpec(sourceText: string): Promise<VizDraft | null> {
  if (!isConfigured()) return null;
  try {
    const raw = await chatWithRetry(
      [
        { role: 'system', content: DRAFT_SYSTEM },
        { role: 'user', content: sourceText },
      ],
      {
        model: config.featherless.reasoningModel,
        temperature: 0.1,
        maxTokens: 700,
        timeoutMs: config.featherless.slowTimeoutMs,
      },
    );
    const draft = parseJsonObject(raw);
    if (!draft) return null;
    if (draft.kind && !VIZ_KINDS.includes(draft.kind)) draft.kind = 'wolfram';
    return draft;
  } catch (err) {
    console.warn('[viz] draft failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Accessibility copy
 * ------------------------------------------------------------------ */

/**
 * Translates a graphic's spoken description into every language in the room.
 *
 * Reuses the lecture translation path deliberately, so the same term-protection
 * rule applies: a described plot says "the eigenvalue", not a translated
 * approximation of it.
 */
async function translateAltText(
  altText: string,
  from: LangCode,
  targets: LangCode[],
): Promise<Partial<Record<LangCode, string>>> {
  const out: Partial<Record<LangCode, string>> = { [from]: altText };
  const matcher = buildMatcher([]);

  await Promise.all(
    targets
      .filter((t) => t !== from)
      .map(async (to) => {
        const tr = await translateUtterance({
          utteranceId: `alt-${randomUUID()}`,
          text: altText,
          from,
          to,
          matcher,
        });
        out[to] = tr.text;
      }),
  );

  return out;
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/** Builds a proposal from an explicit professor request. */
export async function requestVisual(prompt: string, lectureId: string): Promise<VizSpec> {
  const draft = await draftSpec(prompt);

  // An explicit request is honoured even when the drafting model is
  // unavailable or declines. The professor asked for this diagram, so the raw
  // prompt goes to Wolfram|Alpha as-is rather than being second-guessed.
  if (!draft || draft.visualise === false) {
    return {
      id: randomUUID(),
      lectureId,
      kind: 'wolfram',
      title: truncateWords(prompt, 60),
      // The full prompt, not the truncated title. Alpha was previously handed
      // a title cut mid-word and answered 501 "did not understand your input".
      query: prompt,
      altText: { en: prompt },
      status: 'proposed',
    };
  }

  return {
    id: randomUUID(),
    lectureId,
    kind: draft.kind ?? 'wolfram',
    title: draft.title ?? truncateWords(prompt, 60),
    expression: draft.expression,
    query: draft.query ?? prompt,
    domain: draft.domain,
    altText: { en: draft.altText ?? draft.title ?? prompt },
    status: 'proposed',
  };
}

/**
 * Renders an approved spec and prepares its translated descriptions.
 *
 * Rendering is deliberately deferred to approval time so a rejected suggestion
 * never spends a Wolfram call or a cloud credit.
 */
export async function renderVisual(
  viz: VizSpec,
  targets: LangCode[] = [],
  instructionLang: LangCode = 'en',
): Promise<VizSpec> {
  const out: VizSpec = { ...viz, status: 'approved' };

  // Order matters: the drafter's query, then the original description, and the
  // title only as a last resort - it is a display label, not a question.
  const query = viz.query || viz.altText.en || viz.title || '';

  if (isWolframConfigured()) {
    try {
      const result = await render(viz.expression, query);
      out.rendered = result.dataUri;
    } catch (err) {
      // Not fatal. `function2d` and `formula` render perfectly well in the
      // browser, so a Wolfram failure downgrades rather than kills the visual.
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[viz] wolfram render failed:', message);
      if (viz.kind === 'wolfram' || viz.kind === 'surface3d' || viz.kind === 'vectorfield') {
        out.status = 'error';
        out.error = message;
      }
    }
  }

  // A one-line numeric answer, when Alpha has one, sharpens the description.
  if (out.rendered && viz.kind !== 'formula') {
    const short = await alphaShortAnswer(query).catch(() => null);
    if (short && !out.altText.en?.includes(short)) {
      out.altText = { ...out.altText, en: `${out.altText.en ?? ''} ${short}`.trim() };
    }
  }

  const baseAlt = out.altText[instructionLang] ?? out.altText.en;
  if (baseAlt && targets.length > 0) {
    out.altText = {
      ...out.altText,
      ...(await translateAltText(baseAlt, instructionLang, targets)),
    };
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * Automatic proposals
 * ------------------------------------------------------------------ */

/** Per-room state, so we neither spam the professor nor re-read old speech. */
const proposalState = new Map<string, { lastIndex: number; lastAt: number }>();

/** Minimum gap between automatic suggestions in one room. */
const PROPOSAL_COOLDOWN_MS = 60_000;

/**
 * Looks at what the professor has said recently and offers a diagram if the
 * content warrants one.
 *
 * Runs on a timer, off the translation path. Audio latency is the one number
 * this product cannot afford to regress, and a speculative visualisation call
 * is exactly the kind of work that would quietly eat it.
 */
export async function proposeVisualFor(room: Room): Promise<void> {
  if (room.isEnded || !isConfigured()) return;

  const state = proposalState.get(room.meta.id) ?? { lastIndex: 0, lastAt: 0 };
  if (Date.now() - state.lastAt < PROPOSAL_COOLDOWN_MS) return;

  // Yield to live translation.
  //
  // The plan allows four concurrent requests and one utterance fans out to
  // every language in the room, so a speculative 700-token diagram spec can sit
  // in front of the sentence a student is waiting to hear. Audio latency is the
  // one number this product cannot afford to regress; a diagram suggestion can
  // always wait for the next cooldown.
  const gate = gateStatus();
  if (gate.waiting > 0 || gate.inFlight >= gate.limit - 1) {
    return;
  }

  const recent = room.accumulator.recentUtterances(12);
  if (recent.length <= state.lastIndex) return;

  const fresh = recent.slice(state.lastIndex);
  const text = fresh.map((u) => u.text).join(' ').trim();

  // Too little new speech to judge.
  if (text.length < 120) return;

  proposalState.set(room.meta.id, { lastIndex: recent.length, lastAt: Date.now() });

  const draft = await draftSpec(text);
  if (!draft || !draft.visualise) return;

  room.proposeVisual({
    id: randomUUID(),
    lectureId: room.meta.id,
    kind: draft.kind ?? 'wolfram',
    title: draft.title ?? 'Suggested diagram',
    expression: draft.expression,
    query: draft.query,
    domain: draft.domain,
    altText: { [LANGUAGES[room.meta.instructionLang].code]: draft.altText ?? draft.title ?? '' },
    sourceUtteranceId: fresh[fresh.length - 1]?.id,
    status: 'proposed',
  });
}

export function resetProposalState(lectureId: string): void {
  proposalState.delete(lectureId);
}
