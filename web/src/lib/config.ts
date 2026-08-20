/**
 * Where the realtime server lives.
 *
 * Two deployment shapes are supported, and the difference is one env var:
 *
 *   Single host  - the Node server serves the built frontend too. Same origin,
 *                  so VITE_SERVER_URL is unset and every request is relative.
 *
 *   Split host   - the frontend is on a static/edge platform (Vercel) and the
 *                  server is somewhere that can hold a WebSocket open for an
 *                  hour. VITE_SERVER_URL points at that server.
 *
 * The split shape is the one Vercel requires. Vercel runs serverless functions:
 * they cannot hold a persistent socket, they do not share memory between
 * invocations, and they time out long before a lecture ends. The lecture rooms
 * in `server/src/rooms.ts` are live in-memory objects with a professor and a set
 * of listeners attached, which is precisely what serverless has nowhere to put.
 */

const configured = (import.meta.env.VITE_SERVER_URL ?? '').trim().replace(/\/+$/, '');

/** Base URL for REST calls. Empty string means "same origin". */
export const SERVER_URL = configured;

/** Absolute URL for a REST path. */
export function apiUrl(path: string): string {
  return `${SERVER_URL}${path}`;
}

/** Absolute URL for the WebSocket endpoint. */
export function socketUrl(): string {
  if (SERVER_URL) {
    return `${SERVER_URL.replace(/^http/, 'ws')}/ws`;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws`;
}

/**
 * True when the page is served over HTTPS but the server is not.
 *
 * Browsers refuse a `ws://` connection from an `https://` page, and the error
 * they report is opaque. This is the single most likely way a split deployment
 * fails, so the UI checks for it explicitly and says so.
 */
export function hasMixedContentProblem(): boolean {
  if (!SERVER_URL) return false;
  return location.protocol === 'https:' && SERVER_URL.startsWith('http://');
}
