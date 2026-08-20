import { config } from '../config.js';

/**
 * Minimal client for Featherless AI, which speaks the OpenAI chat-completions
 * dialect. Deliberately hand-rolled rather than pulling in the OpenAI SDK: the
 * only endpoint this app needs is `/chat/completions`, and a live interpreter
 * cares far more about a hard deadline than about client features.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Overrides the default deadline. Past this, we abandon the request. */
  timeoutMs?: number;
  /** Sequences that end generation early. */
  stop?: string[];
}

export class FeatherlessError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'FeatherlessError';
  }
}

export function isConfigured(): boolean {
  return Boolean(config.featherless.apiKey);
}

/**
 * One chat completion.
 *
 * Throws rather than returning a sentinel on failure, because every caller has
 * a different idea of what to do when the model is unavailable: the live
 * translator falls back to passthrough so the lecture keeps moving, while the
 * glossary builder simply reports the error to the professor.
 */
export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  if (!isConfigured()) {
    throw new FeatherlessError('FEATHERLESS_API_KEY is not set', undefined, false);
  }

  const timeoutMs = opts.timeoutMs ?? config.featherless.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${config.featherless.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.featherless.apiKey}`,
      },
      body: JSON.stringify({
        model: opts.model ?? config.featherless.model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 512,
        ...(opts.stop ? { stop: opts.stop } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // 429 and 5xx are worth another attempt; 4xx generally is not.
      const retryable = res.status === 429 || res.status >= 500;
      throw new FeatherlessError(
        `Featherless returned ${res.status}: ${body.slice(0, 300)}`,
        res.status,
        retryable,
      );
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new FeatherlessError('Featherless response contained no message content');
    }
    return content.trim();
  } catch (err) {
    if (err instanceof FeatherlessError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      // A late translation is worse than no translation - the lecture has moved
      // on and the student would hear an answer to a question nobody asked.
      throw new FeatherlessError(`Timed out after ${timeoutMs}ms`, undefined, true);
    }
    throw new FeatherlessError(
      err instanceof Error ? err.message : 'Unknown Featherless failure',
      undefined,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

/** One retry on retryable failures, with a short fixed backoff. */
export async function chatWithRetry(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  try {
    return await chat(messages, opts);
  } catch (err) {
    if (err instanceof FeatherlessError && err.retryable) {
      await new Promise((r) => setTimeout(r, 350));
      return chat(messages, opts);
    }
    throw err;
  }
}

/** Lists model ids, used by the setup screen to confirm the key works. */
export async function listModels(): Promise<string[]> {
  if (!isConfigured()) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${config.featherless.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.featherless.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
