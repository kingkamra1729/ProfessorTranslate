import { config } from '../config.js';

/**
 * Firecrawl: turns a course page, syllabus or lecture-notes URL into clean
 * markdown, which the glossary builder then mines for technical vocabulary.
 *
 * This closes the most tedious gap in the product. Term protection only works
 * on terms the system knows about, and no lecturer is going to hand-type two
 * hundred entries before class. Pointing it at the course page they already
 * maintain gets most of the way there in one click.
 */

export function isFirecrawlConfigured(): boolean {
  return Boolean(config.firecrawl.apiKey);
}

export async function scrapeToMarkdown(url: string): Promise<string> {
  if (!isFirecrawlConfigured()) {
    throw new Error('FIRECRAWL_API_KEY is not set');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.firecrawl.timeoutMs);

  try {
    const res = await fetch(`${config.firecrawl.baseUrl}/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.firecrawl.apiKey}`,
      },
      body: JSON.stringify({
        url,
        formats: ['markdown'],
        onlyMainContent: true,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Firecrawl returned ${res.status}: ${body.slice(0, 300)}`);
    }

    const json = (await res.json()) as {
      success?: boolean;
      data?: { markdown?: string };
      error?: string;
    };

    const markdown = json.data?.markdown;
    if (!markdown) {
      throw new Error(json.error ?? 'Firecrawl returned no markdown');
    }
    return markdown;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Firecrawl timed out after ${config.firecrawl.timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
