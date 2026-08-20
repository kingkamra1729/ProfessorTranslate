/**
 * Where the realtime server lives.
 *
 * Normally: the same origin. Suvidha deploys as one service - the Node server
 * builds and serves this frontend - so every request is relative and there is
 * nothing to configure.
 *
 * VITE_SERVER_URL exists for the one case where the frontend is hosted
 * separately from the server. That arrangement needs a server that can hold a
 * WebSocket open for the length of a lecture, since a lecture room is a live
 * in-memory object with the professor's socket and every student's socket
 * attached; a serverless platform has nowhere to put it.
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
