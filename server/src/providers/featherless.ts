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

/* ------------------------------------------------------------------ *
 * Concurrency gate
 * ------------------------------------------------------------------ */

/**
 * Caps in-flight requests to what the plan allows.
 *
 * Featherless reports a concurrency limit per plan - 4 on Feather Chat - and
 * exceeding it returns 429. This app can blow through that without trying: one
 * utterance fans out to every language in the room simultaneously, so a lecture
 * with Hindi, Bengali, French and English listeners is already at the ceiling
 * before the visualisation drafter wakes up and asks for a fifth.
 *
 * Queueing is strictly better than the alternative here. A translation that
 * waits 200ms for a slot still arrives in time; one that 429s is retried after
 * a backoff, or lost to passthrough - and the student hears the original
 * English instead of their own language.
 */
class Gate {
  private active = 0;
  private queue: Array<() => void> = [];

  constructor(private limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  get inFlight(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }
}

const gate = new Gate(config.featherless.concurrency);

/** Current gate pressure, surfaced by /api/health for debugging a slow demo. */
export function gateStatus(): { inFlight: number; waiting: number; limit: number } {
  return {
    inFlight: gate.inFlight,
    waiting: gate.waiting,
    limit: config.featherless.concurrency,
  };
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
  return gate.run(() => chatUnguarded(messages, opts));
}

async function chatUnguarded(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
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

/**
 * Streaming completion.
 *
 * Worth the extra code because of where the time actually goes. Measured
 * against this provider, a short translation takes ~1.8s in total but produces
 * its first token after ~0.6s. Waiting for the whole response means a student
 * stares at nothing for the full 1.8s; streaming puts words on their screen in
 * a third of that, and the rest arrives while they are already reading.
 *
 * `onDelta` receives text fragments as they arrive. The full text is returned.
 */
export async function chatStream(
  messages: ChatMessage[],
  opts: ChatOptions,
  onDelta: (fragment: string, soFar: string) => void,
): Promise<string> {
  if (!isConfigured()) {
    throw new FeatherlessError('FEATHERLESS_API_KEY is not set', undefined, false);
  }

  return gate.run(async () => {
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
          stream: true,
          temperature: opts.temperature ?? 0.2,
          max_tokens: opts.maxTokens ?? 512,
          ...(opts.stop ? { stop: opts.stop } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new FeatherlessError(
          `Featherless returned ${res.status}: ${body.slice(0, 300)}`,
          res.status,
          res.status === 429 || res.status >= 500,
        );
      }
      if (!res.body) throw new FeatherlessError('Featherless returned no stream body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let text = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Server-sent events: one JSON payload per `data:` line.
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line.startsWith('data:')) continue;

          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;

          try {
            const json = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const fragment = json.choices?.[0]?.delta?.content;
            if (fragment) {
              text += fragment;
              onDelta(fragment, text);
            }
          } catch {
            // Keep-alive or a fragment split across reads; the buffer handles it.
          }
        }
      }

      return text.trim();
    } catch (err) {
      if (err instanceof FeatherlessError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
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
  });
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

/**
 * Confirms the key is accepted, using the cheapest call that proves it.
 *
 * Deliberately *not* done by listing models: Featherless serves 40,000+ of them
 * and `/v1/models` is a 7.7 MB response that takes several seconds. Using that
 * as an auth check means a valid key looks broken whenever the download is
 * slow, which is exactly the false alarm a diagnostic must not produce.
 */
export async function checkAuth(): Promise<{ ok: boolean; detail: string }> {
  if (!isConfigured()) return { ok: false, detail: 'FEATHERLESS_API_KEY is not set' };
  try {
    const reply = await chat(
      [
        { role: 'system', content: 'Reply with exactly one word: OK' },
        { role: 'user', content: 'ping' },
      ],
      { maxTokens: 16, timeoutMs: 45_000 },
    );
    return { ok: true, detail: reply.slice(0, 60) };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Lists model ids.
 *
 * The response is large - see `checkAuth` - so the timeout is generous and
 * callers should treat this as an optional lookup rather than a health check.
 * Throws so a caller can tell "no models" apart from "the request failed".
 */
export async function listModels(): Promise<string[]> {
  if (!isConfigured()) throw new FeatherlessError('FEATHERLESS_API_KEY is not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${config.featherless.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.featherless.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new FeatherlessError(`Featherless returned ${res.status} listing models`, res.status);
    }
    const json = (await res.json()) as { data?: Array<{ id?: string }> };
    return (json.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
  } catch (err) {
    if (err instanceof FeatherlessError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      throw new FeatherlessError('Timed out listing models (the catalogue is ~8 MB)');
    }
    throw new FeatherlessError(err instanceof Error ? err.message : 'Could not list models');
  } finally {
    clearTimeout(timer);
  }
}

/** Non-throwing variant for endpoints that only want a best-effort list. */
export async function tryListModels(): Promise<string[]> {
  try {
    return await listModels();
  } catch {
    return [];
  }
}
