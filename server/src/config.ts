import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

/**
 * Runtime configuration.
 *
 * Every external service is optional. Suvidha is meant to be demonstrable on a
 * laptop with no keys at all - speech capture and synthesis happen in the
 * browser and cost nothing - so a missing key degrades one feature rather than
 * breaking the app. `describeConfig()` reports what is actually wired so the UI
 * can tell the truth about which engine produced a given translation.
 */

const here = dirname(fileURLToPath(import.meta.url)); // server/src
export const repoRoot = resolve(here, '../..');
export const serverRoot = resolve(here, '..');

/**
 * Loads `.env` from the repository root as well as from `server/`.
 *
 * npm workspaces run each script with its own working directory, so a bare
 * `dotenv/config` finds `server/.env` when started through `npm run dev` and
 * nothing at all when started from the repo root. Checking both means a single
 * `.env` at the top level works however the process was launched - which is
 * what anyone cloning this will actually do.
 *
 * Real environment variables always win, so a hosting platform's dashboard
 * settings are never overridden by a stray file in the image.
 */
for (const candidate of [join(repoRoot, '.env'), join(serverRoot, '.env')]) {
  if (existsSync(candidate)) dotenv.config({ path: candidate });
}

function str(name: string, fallback = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function list(name: string): string[] {
  return str(name)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  port: num('PORT', 8787),

  /**
   * Origins allowed to call this server.
   *
   * Empty means "reflect whatever origin asks", which is right for local
   * development and for a hackathon demo where the Vercel preview URL changes
   * on every push. Set it in production to pin the deployment.
   */
  allowedOrigins: list('ALLOWED_ORIGINS'),

  /** Serves web/dist from this process, for single-host deployments. */
  serveStatic: str('SERVE_STATIC', 'auto'),

  featherless: {
    apiKey: str('FEATHERLESS_API_KEY'),
    baseUrl: str('FEATHERLESS_BASE_URL', 'https://api.featherless.ai/v1'),
    /**
     * Default is a mixture-of-experts model: ~30B total parameters but only ~3B
     * active per token, which is the property that matters here. Live
     * interpretation is latency-bound, not capability-bound - the sentences are
     * short and the hard vocabulary has already been masked out before the
     * model sees the text.
     */
    model: str('FEATHERLESS_MODEL', 'Qwen/Qwen3-30B-A3B-Instruct-2507'),
    /**
     * Model for glossary building and visualisation specs.
     *
     * Defaults to the same model as live translation, which is deliberate and
     * was measured rather than assumed. On a ~400-token structured generation:
     * this model returns clean JSON in ~9s, while Qwen3-235B-A22B and
     * Qwen3.5-27B both spent their whole token budget on internal reasoning and
     * returned an empty string. Bigger was not better; it was empty.
     *
     * Using one model everywhere also avoids the provider's model-switching
     * throttle, which returns 429 when a key hops between deployments.
     */
    reasoningModel: str('FEATHERLESS_REASONING_MODEL', 'Qwen/Qwen3-30B-A3B-Instruct-2507'),
    timeoutMs: num('FEATHERLESS_TIMEOUT_MS', 12_000),
    /**
     * Maximum simultaneous requests. Featherless reports this per plan via
     * /v1/plan - 4 on Feather Chat - and returns 429 above it.
     */
    concurrency: num('FEATHERLESS_CONCURRENCY', 4),
    /** Off-the-audio-path work: drafting diagrams, extracting a glossary. */
    slowTimeoutMs: num('FEATHERLESS_SLOW_TIMEOUT_MS', 90_000),
  },

  wolfram: {
    /** Wolfram|Alpha "Full Results" API app ID. */
    appId: str('WOLFRAM_APP_ID'),
    /** A CloudDeploy'd APIFunction URL, for arbitrary Wolfram Language plots. */
    cloudApiUrl: str('WOLFRAM_CLOUD_API_URL'),
    timeoutMs: num('WOLFRAM_TIMEOUT_MS', 15_000),
  },

  firecrawl: {
    apiKey: str('FIRECRAWL_API_KEY'),
    baseUrl: str('FIRECRAWL_BASE_URL', 'https://api.firecrawl.dev/v1'),
    timeoutMs: num('FIRECRAWL_TIMEOUT_MS', 30_000),
  },

  /**
   * Where lecture recordings are archived.
   *
   * Note for deployment: several hosts give a container an ephemeral filesystem
   * that resets on every deploy. Point DATA_DIR at a mounted disk if recordings
   * need to outlive a redeploy.
   */
  dataDir: str('DATA_DIR', join(repoRoot, 'data')),
};

export interface ServiceStatus {
  name: string;
  enabled: boolean;
  detail: string;
}

export function describeConfig(): ServiceStatus[] {
  return [
    {
      name: 'translation',
      enabled: Boolean(config.featherless.apiKey),
      detail: config.featherless.apiKey
        ? `Featherless · ${config.featherless.model}`
        : 'No FEATHERLESS_API_KEY — running in passthrough mode',
    },
    {
      name: 'visualisation',
      enabled: Boolean(config.wolfram.appId || config.wolfram.cloudApiUrl),
      detail: config.wolfram.cloudApiUrl
        ? 'Wolfram Cloud APIFunction'
        : config.wolfram.appId
          ? 'Wolfram|Alpha Full Results API'
          : 'No Wolfram credentials — plots render client-side only',
    },
    {
      name: 'glossary-import',
      enabled: Boolean(config.firecrawl.apiKey),
      detail: config.firecrawl.apiKey
        ? 'Firecrawl'
        : 'No FIRECRAWL_API_KEY — paste syllabus text instead of a URL',
    },
  ];
}
