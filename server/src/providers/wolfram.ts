import { config } from '../config.js';

/**
 * Wolfram rendering.
 *
 * Two routes are supported, in preference order:
 *
 *   1. A CloudDeploy'd APIFunction. This is the good one - arbitrary Wolfram
 *      Language, so `VectorPlot`, `Plot3D`, `StreamPlot` and friends are all
 *      available and the expression can be tuned per lecture.
 *   2. The Wolfram|Alpha Simple API, which takes a natural-language query and
 *      returns a rendered image. Nothing to deploy, works with only an app ID.
 *
 * If neither is configured the caller falls back to plotting in the browser,
 * which handles ordinary y = f(x) curves perfectly well and costs nothing.
 */

export interface WolframResult {
  /** A `data:` URI holding the rendered image. */
  dataUri: string;
  source: 'cloud' | 'alpha';
}

export function isWolframConfigured(): boolean {
  return Boolean(config.wolfram.cloudApiUrl || config.wolfram.appId);
}

async function fetchAsDataUri(
  url: string,
  timeoutMs: number,
): Promise<{ dataUri: string; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Wolfram returned ${res.status}: ${body.slice(0, 200)}`);
    }

    const contentType = res.headers.get('content-type') ?? 'image/png';
    if (!contentType.startsWith('image/')) {
      const body = await res.text().catch(() => '');
      throw new Error(`Expected an image, got ${contentType}: ${body.slice(0, 200)}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    return {
      dataUri: `data:${contentType};base64,${buf.toString('base64')}`,
      contentType,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Evaluates a Wolfram Language expression through a deployed APIFunction.
 *
 * The deployed function is expected to accept an `expr` parameter and return an
 * image. `scripts/wolfram-deploy.wl` in this repo contains the one-liner that
 * creates it.
 */
export async function renderWolframExpression(expression: string): Promise<WolframResult> {
  if (!config.wolfram.cloudApiUrl) {
    throw new Error('WOLFRAM_CLOUD_API_URL is not set');
  }
  const url = `${config.wolfram.cloudApiUrl}${
    config.wolfram.cloudApiUrl.includes('?') ? '&' : '?'
  }expr=${encodeURIComponent(expression)}`;

  const { dataUri } = await fetchAsDataUri(url, config.wolfram.timeoutMs);
  return { dataUri, source: 'cloud' };
}

/**
 * Renders a natural-language query through the Wolfram|Alpha Simple API.
 *
 * `background` and `fontsize` are set so the returned image sits legibly on the
 * dark lecture view without a white card around it.
 */
export async function renderAlphaQuery(query: string): Promise<WolframResult> {
  if (!config.wolfram.appId) {
    throw new Error('WOLFRAM_APP_ID is not set');
  }
  const params = new URLSearchParams({
    appid: config.wolfram.appId,
    i: query,
    background: 'F7F7F8',
    foreground: 'black',
    fontsize: '16',
    width: '900',
    units: 'metric',
  });

  const { dataUri } = await fetchAsDataUri(
    `https://api.wolframalpha.com/v1/simple?${params.toString()}`,
    config.wolfram.timeoutMs,
  );
  return { dataUri, source: 'alpha' };
}

/**
 * Short textual answer for a query, used to build the spoken description that
 * accompanies every graphic.
 */
export async function alphaShortAnswer(query: string): Promise<string | null> {
  if (!config.wolfram.appId) return null;
  const params = new URLSearchParams({ appid: config.wolfram.appId, i: query, units: 'metric' });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.wolfram.timeoutMs);
  try {
    const res = await fetch(`https://api.wolframalpha.com/v1/result?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.text()).trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Renders by whichever route is available, most precise first.
 *
 *   1. Wolfram Cloud with the expression - exact, if an endpoint is deployed.
 *   2. Alpha with the expression - Alpha parses Wolfram Language, so
 *      `Plot[Exp[-x/4] Sin[3x], {x, 0, 20}]` gives exactly the requested curve.
 *   3. Alpha with the natural-language query - the loosest route, and the one
 *      most likely to come back 501 "did not understand your input".
 *
 * Step 2 is the one worth calling out. It was missing originally, so a spec
 * carrying a perfectly good Wolfram expression still fell through to prose,
 * and Alpha rejected it. An exact expression should never lose to a paraphrase.
 */
export async function render(
  expression: string | undefined,
  query: string,
): Promise<WolframResult> {
  const errors: string[] = [];

  if (expression && config.wolfram.cloudApiUrl) {
    try {
      return await renderWolframExpression(expression);
    } catch (err) {
      errors.push(`cloud: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (config.wolfram.appId) {
    for (const [label, input] of [
      ['alpha-expression', expression],
      ['alpha-query', query],
    ] as const) {
      if (!input?.trim()) continue;
      try {
        return await renderAlphaQuery(input);
      } catch (err) {
        errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  throw new Error(errors.length > 0 ? errors.join('; ') : 'No Wolfram credentials configured');
}
