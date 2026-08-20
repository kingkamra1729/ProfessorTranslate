import type { GlossaryTerm } from '@suvidha/shared';
import { chatWithRetry, isConfigured } from '../providers/featherless.js';
import { isFirecrawlConfigured, scrapeToMarkdown } from '../providers/firecrawl.js';
import { config } from '../config.js';

/**
 * Glossary construction from course material.
 *
 * Term protection is only as good as the term list, and a term list is exactly
 * the kind of thing nobody has time to write. So: point this at the syllabus
 * URL, the lecture notes page, or a pasted chapter, and it returns the
 * vocabulary that must survive translation.
 *
 * The professor still reviews the result. An auto-extracted list is a first
 * draft - it will over-collect ("introduction", "chapter") and occasionally
 * miss the one term the lecture is actually about.
 */

const EXTRACT_SYSTEM = [
  'You extract technical vocabulary from university course material.',
  '',
  'Return ONE JSON array and nothing else. No markdown fence, no commentary.',
  '',
  'Each element:',
  '{',
  '  "term": string,        // canonical form, lower case unless it is a proper noun',
  '  "aliases": string[],   // plural forms, abbreviations, and the ways speech recognition mis-hears it',
  '  "gloss": string        // one short clause explaining it, in English',
  '}',
  '',
  'Rules:',
  '- Include only vocabulary that is specific to the subject. A student meets these words in the textbook and the exam.',
  '- Exclude ordinary academic words: introduction, chapter, example, problem, lecture, syllabus, assignment, definition, theorem, exercise.',
  '- Include multi-word terms as single entries: "partial differential equation", not "partial" and "equation".',
  '- In "aliases", think about what automatic speech recognition does to the term when spoken aloud. "pseudocode" is heard as "sudo code"; "eigenvalue" as "eigen value" and "igen value"; "SVD" as "S V D". These aliases are the difference between a protected term and a mistranslated one.',
  '- At most 40 entries. Prefer the terms a lecturer would actually say out loud.',
  '- Keep each "gloss" under 15 words. A long gloss costs entries: the reply is cut off at a token limit, and a verbose thirtieth entry means there is no fortieth.',
].join('\n');

interface ExtractedTerm {
  term?: string;
  aliases?: string[];
  gloss?: string;
}

/**
 * Parses the model's JSON array, tolerating a truncated response.
 *
 * Generation stops at the token limit regardless of where the JSON is, so a
 * long list arrives cut off mid-object and `JSON.parse` rejects the whole
 * thing. Returning nothing in that case throws away thirty perfectly good terms
 * because the thirty-first was incomplete - which is what this used to do, and
 * it failed silently, reporting an empty glossary rather than an error.
 *
 * So on a parse failure we retreat to the last complete object and close the
 * array there.
 */
function parseJsonArray(raw: string): ExtractedTerm[] {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  text = text.replace(/^<think>[\s\S]*?<\/think>\s*/i, '');

  const start = text.indexOf('[');
  if (start < 0) return [];

  const end = text.lastIndexOf(']');
  if (end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) return parsed as ExtractedTerm[];
    } catch {
      /* Fall through to truncation recovery. */
    }
  }

  // Recovery: keep everything up to the last `}` that closes a complete entry.
  const body = text.slice(start);
  const lastComplete = body.lastIndexOf('}');
  if (lastComplete < 0) return [];

  try {
    const repaired = `${body.slice(0, lastComplete + 1)}]`;
    const parsed = JSON.parse(repaired);
    if (Array.isArray(parsed)) {
      console.warn(
        `[glossary] model output was truncated; recovered ${parsed.length} complete entries`,
      );
      return parsed as ExtractedTerm[];
    }
  } catch {
    /* Genuinely unparseable. */
  }
  return [];
}

/**
 * Generates the alias forms that are mechanical rather than acoustic.
 *
 * The model is asked for the ones that need judgement - homophones and
 * mishearings. Plurals and hyphen variants are cheaper to derive here than to
 * spend model tokens on, and doing so deterministically means they are never
 * forgotten.
 */
function derivedAliases(term: string): string[] {
  const out = new Set<string>();
  const lower = term.toLowerCase();

  if (!lower.endsWith('s')) out.add(`${lower}s`);
  if (lower.endsWith('y')) out.add(`${lower.slice(0, -1)}ies`);
  if (lower.endsWith('x')) out.add(`${lower}es`);
  if (lower.includes('-')) out.add(lower.replace(/-/g, ' '));
  if (lower.includes(' ')) out.add(lower.replace(/ /g, '-'));

  // Initialisms are dictated letter by letter: "SVD" arrives as "S V D".
  if (/^[A-Z]{2,6}$/.test(term)) out.add(term.split('').join(' '));

  out.delete(lower);
  return [...out];
}

export interface GlossarySource {
  url?: string;
  text?: string;
  subject?: string;
}

export async function buildGlossaryFromSource(src: GlossarySource): Promise<GlossaryTerm[]> {
  let material = (src.text ?? '').trim();

  if (!material && src.url) {
    if (!isFirecrawlConfigured()) {
      throw new Error(
        'A URL was given but FIRECRAWL_API_KEY is not set. Paste the course text instead.',
      );
    }
    material = await scrapeToMarkdown(src.url);
  }

  if (!material) {
    throw new Error('Provide either a URL or some course text');
  }

  if (!isConfigured()) {
    throw new Error(
      'FEATHERLESS_API_KEY is not set, so terms cannot be extracted. Use a built-in subject pack instead.',
    );
  }

  // Keep the request bounded; a syllabus page carries plenty of signal in its
  // first few thousand words and the tail is usually policies and dates.
  const excerpt = material.slice(0, 12_000);
  const preamble = src.subject ? `Subject: ${src.subject}\n\n` : '';

  const raw = await chatWithRetry(
    [
      { role: 'system', content: EXTRACT_SYSTEM },
      { role: 'user', content: `${preamble}${excerpt}` },
    ],
    {
      model: config.featherless.reasoningModel,
      temperature: 0.1,
      maxTokens: 4000,
      // Three thousand tokens at roughly 45 tokens/second is over a minute of
      // generation, so this gets a much longer leash than anything on the
      // audio path. It runs once, before the lecture starts.
      timeoutMs: config.featherless.slowTimeoutMs * 2,
    },
  );

  const extracted = parseJsonArray(raw);
  const seen = new Set<string>();
  const terms: GlossaryTerm[] = [];

  for (const item of extracted) {
    const term = String(item.term ?? '').trim();
    if (!term || term.length > 60) continue;

    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const modelAliases = Array.isArray(item.aliases)
      ? item.aliases.map((a) => String(a).trim()).filter(Boolean)
      : [];

    terms.push({
      id: `auto-${terms.length}`,
      term,
      aliases: [...new Set([...modelAliases, ...derivedAliases(term)])],
      gloss: item.gloss ? { en: String(item.gloss) } : undefined,
      source: 'auto',
    });
  }

  return terms;
}
