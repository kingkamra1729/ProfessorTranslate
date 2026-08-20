import type { ClientMessage, ServerMessage } from '@suvidha/shared';
import { socketUrl } from './config';

/**
 * The lecture socket.
 *
 * Reconnects on its own, because the realistic failure here is a student's
 * phone switching from campus wifi to mobile data halfway through a lecture,
 * and the right response to that is for the audio to resume rather than for
 * them to discover a dead page five minutes later.
 */

export type SocketState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LectureSocketEvents {
  onMessage: (msg: ServerMessage) => void;
  onStateChange?: (state: SocketState) => void;
}

export class LectureSocket {
  private ws: WebSocket | null = null;
  private state: SocketState = 'closed';
  private shouldRun = false;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  /**
   * Messages sent before the socket opened.
   *
   * The join message is invariably the first thing a caller sends, and it is
   * sent the moment the component mounts - well before the handshake finishes.
   * Queueing means callers never have to think about readiness.
   */
  private outbox: ClientMessage[] = [];

  /** Replayed after a reconnect so the server knows who came back. */
  private rejoin: ClientMessage | null = null;

  constructor(private events: LectureSocketEvents) {}

  get currentState(): SocketState {
    return this.state;
  }

  private setState(next: SocketState): void {
    if (this.state === next) return;
    this.state = next;
    this.events.onStateChange?.(next);
  }

  connect(): void {
    this.shouldRun = true;
    this.open();
  }

  private open(): void {
    if (!this.shouldRun) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.setState(this.attempts === 0 ? 'connecting' : 'reconnecting');

    const ws = new WebSocket(socketUrl());
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.setState('open');

      if (this.rejoin) ws.send(JSON.stringify(this.rejoin));
      for (const msg of this.outbox.splice(0)) ws.send(JSON.stringify(msg));

      // Some proxies drop idle websockets after 30-60 seconds. A lecturer
      // pausing to write on the board is exactly that idle.
      this.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 20_000);
    };

    ws.onmessage = (event) => {
      try {
        this.events.onMessage(JSON.parse(String(event.data)) as ServerMessage);
      } catch {
        /* A malformed frame is not worth tearing the connection down for. */
      }
    };

    ws.onclose = () => {
      this.clearHeartbeat();
      this.ws = null;
      if (!this.shouldRun) {
        this.setState('closed');
        return;
      }
      this.setState('reconnecting');
      this.attempts++;
      const delay = Math.min(8000, 400 * 2 ** Math.min(this.attempts, 5));
      this.reconnectTimer = setTimeout(() => this.open(), delay);
    };

    ws.onerror = () => {
      /* 'close' always follows; handled there. */
    };
  }

  /**
   * Records the message that establishes this client's identity, so a
   * reconnect restores it automatically.
   */
  setRejoin(msg: ClientMessage): void {
    this.rejoin = msg;
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.outbox.push(msg);
      // Interim captions go stale in well under a second; a backlog of them
      // after a reconnect is noise, not history.
      if (this.outbox.length > 40) this.outbox.splice(0, this.outbox.length - 40);
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  close(): void {
    this.shouldRun = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHeartbeat();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
    this.setState('closed');
  }
}
