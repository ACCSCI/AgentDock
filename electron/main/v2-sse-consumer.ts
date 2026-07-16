// @ts-nocheck
/**
 * v2 SSE Consumer — Electron main process.
 *
 * Reads `GET /events` from the daemon and forwards each event to a
 * callback (typically `webContents.send("daemon:events:push", ...)`).
 *
 * Why a hand-rolled parser instead of EventSource:
 *   - Electron's main process bundles Node, but `EventSource` is browser-only.
 *   - `undici`'s EventSource is large and adds a runtime dep.
 *   - The SSE wire format is small: text/event-stream with `event:`, `id:`,
 *     `data:` lines separated by `\n\n`. Hand-rolling it is ~60 lines and
 *     matches what `eventsource-parser` does internally.
 *
 * Reconnect / replay:
 *   - On disconnect, exponential backoff 500ms→1s→2s→5s→10s (cap 10s).
 *   - Every reconnect sends `Last-Event-ID: <lastSeq>`. Daemon uses
 *     `sseBus.replaySince(lastSeq)` to replay from the ring buffer.
 *   - If the daemon says `resync-required` (buffer overflow or restart),
 *     the consumer calls `onResyncRequired()` so the main process can
 *     fetch a fresh /sync and broadcast the snapshot to renderers.
 *
 * Port-change detection:
 *   - If the daemon port changes (e.g. daemon-manager restart), the next
 *     `start()` call resets `lastSeq = 0` so the consumer doesn't ask the
 *     new daemon to replay events it never published.
 */

export interface SseConsumerOptions {
  /** http://127.0.0.1:<port> */
  baseUrl: string;
  /** Called on every received event. */
  onEvent: (e: { event: string; seq: number; data: unknown }) => void;
  /** Called when the consumer reconnects (after a disconnect). */
  onReconnect?: () => void;
  /**
   * §5.3 — Called when the connection is lost (TCP closed, before a
   * reconnect is scheduled). Host should:
   *   1. Fetch /sync to get the authoritative three-table snapshot.
   *   2. Re-register all sessions via /claim to ensure the daemon still
   *      knows the client's owner identity.
   * The reconnect itself is automatic; this hook is for the host to do
   * recovery work that doesn't depend on the new SSE connection.
   */
  onDisconnect?: () => void;
  /** Called when the consumer fully stops (after stop() or unrecoverable error). */
  onClose?: () => void;
  /**
   * Called when the daemon emits `resync-required` (buffer overflow /
   * restart). The host should fetch /sync and broadcast the snapshot.
   */
  onResyncRequired?: () => void;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override setTimeout (tests). */
  setTimeoutImpl?: typeof setTimeout;
  /** Override clearTimeout (tests). */
  clearTimeoutImpl?: typeof clearTimeout;
  /** Override AbortController (tests). */
  abortControllerImpl?: typeof AbortController;
}

interface ParsedFrame {
  event: string;
  id: string;
  data: string;
}

const BACKOFF_STEPS_MS = [500, 1000, 2000, 5000, 10_000] as const;

/**
 * Parse a single SSE message (lines between \n\n separators).
 * Returns null if the buffer doesn't yet contain a complete event.
 */
export function parseSseFrame(buffer: string): { frame: ParsedFrame; rest: string } | null {
  // SSE uses \n\n, \r\n\r\n, or \r\r as event boundary. We treat any
  // double-newline as the boundary for simplicity (good enough for our
  // daemon which always emits \n\n via Hono's streamSSE).
  const boundary = buffer.indexOf("\n\n");
  if (boundary === -1) return null;
  const raw = buffer.slice(0, boundary);
  const rest = buffer.slice(boundary + 2);

  let event = "message";
  let id = "";
  const dataParts: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue; // comment / keep-alive
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("id:")) {
      id = line.slice(3).trim();
    } else if (line.startsWith("data:")) {
      dataParts.push(line.slice(5).trim());
    }
    // Unknown fields are ignored per spec.
  }
  return {
    frame: { event, id, data: dataParts.join("\n") },
    rest,
  };
}

export class SseConsumer {
  private lastSeq = 0;
  private connected = false;
  private stopped = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private currentController: AbortController | null = null;
  private subscribers = new Set<(e: { event: string; seq: number; data: unknown }) => void>();

  constructor(private readonly opts: SseConsumerOptions) {}

  start(): void {
    if (this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      this.opts.clearTimeoutImpl?.(this.reconnectTimer) ?? clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.currentController) {
      this.currentController.abort();
      this.currentController = null;
    }
    if (this.connected) {
      this.connected = false;
      this.opts.onClose?.();
    }
  }

  /** Reset the seq counter — call when the daemon port changes. */
  resetSeq(): void {
    this.lastSeq = 0;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getLastSeq(): number {
    return this.lastSeq;
  }

  /**
   * Add a per-renderer subscriber. Returns an unsubscribe function.
   * Each subscriber receives every event. Subscribers throwing do not
   * affect other subscribers.
   */
  subscribe(cb: (e: { event: string; seq: number; data: unknown }) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const AC = this.opts.abortControllerImpl ?? globalThis.AbortController;
    this.currentController = new AC();
    const url = `${this.opts.baseUrl}/events`;
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (this.lastSeq > 0) headers["Last-Event-ID"] = String(this.lastSeq);

    let res: Response;
    try {
      res = await fetchImpl(url, { headers, signal: this.currentController.signal });
    } catch (_err) {
      if (this.stopped) return;
      this.scheduleReconnect();
      return;
    }
    if (!res.ok || !res.body) {
      if (this.stopped) return;
      this.scheduleReconnect();
      return;
    }

    this.connected = true;
    this.reconnectAttempt = 0;
    this.opts.onReconnect?.();

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    try {
      while (!this.stopped) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // Drain all complete frames in the buffer.
        let parsed = parseSseFrame(buffer);
        while (parsed !== null) {
          buffer = parsed.rest;
          this.dispatch(parsed.frame);
          parsed = parseSseFrame(buffer);
        }
      }
    } catch {
      /* network error — fall through to reconnect */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
    if (this.stopped) return;
    // §5.3 — 断线立即触发 onDisconnect (host: fetch /sync, 重新 claim)
    if (this.connected) {
      this.connected = false;
      try {
        this.opts.onDisconnect?.();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[sse-consumer] onDisconnect threw:", err);
      }
    }
    this.scheduleReconnect();
  }

  private dispatch(frame: ParsedFrame): void {
    if (!frame.event) return;
    let data: unknown = frame.data;
    if (typeof frame.data === "string" && frame.data.length > 0) {
      try {
        data = JSON.parse(frame.data);
      } catch {
        data = frame.data;
      }
    }
    if (frame.id) {
      const seq = Number(frame.id);
      if (!Number.isNaN(seq) && seq > this.lastSeq) this.lastSeq = seq;
    }
    if (frame.event === "resync-required") {
      this.opts.onResyncRequired?.();
    }
    const payload = { event: frame.event, seq: this.lastSeq, data };
    this.opts.onEvent(payload);
    for (const sub of this.subscribers) {
      try {
        sub(payload);
      } catch {
        /* per-subscriber error — non-fatal */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) return;
    const step = BACKOFF_STEPS_MS[Math.min(this.reconnectAttempt, BACKOFF_STEPS_MS.length - 1)];
    this.reconnectAttempt++;
    const setT = this.opts.setTimeoutImpl ?? setTimeout;
    this.reconnectTimer = setT(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, step);
  }
}
