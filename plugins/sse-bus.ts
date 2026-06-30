// @ts-nocheck
/**
 * SSE event bus — 新架构 §7.3.
 *
 * Ring buffer of recent events for Last-Event-ID replay, plus a publish()
 * function that all v2 routes call after mutating state.
 *
 * Event shape:
 *   {
 *     seq: number,            // monotonically increasing per daemon lifetime
 *     event: string,          // type name (port-reassigned, etc.)
 *     data: object,           // payload (JSON-serializable)
 *     ts: number              // ms epoch
 *   }
 *
 * Replay semantics:
 *   - lastEventId is the highest seq the client has ack'd
 *   - if lastEventId is in the buffer, replay events after it
 *   - if lastEventId is outside the buffer (overflowed or daemon restarted),
 *     emit a single `resync-required` control signal — client must do full
 *     /sync (§7.3 "lastSeq 超出缓冲范围的降级")
 *
 * Sequence monotonicity is per-daemon-lifetime only; not preserved across
 * restarts (per §7.3, client must use /sync after restart).
 */
import { SSE_REPLAY_BUFFER } from "./constants.js";

export type EventName =
  | "port-reassigned"
  | "ownership-revoked"
  | "state-changed"
  | "port-released"
  | "session-created"
  | "session-renamed"
  | "session-deleting"
  | "session-purged"
  | "resync-required"
  | "hello"
  | "heartbeat";

export interface DaemonEvent {
  seq: number;
  event: EventName;
  data: Record<string, unknown>;
  ts: number;
}

export class SseBus {
  private buffer: DaemonEvent[] = [];
  private seq = 0;
  private subscribers = new Set<(e: DaemonEvent) => void>();

  /** Publish an event. Assigns seq if not provided. Returns the event with seq. */
  publish(
    event: EventName,
    data: Record<string, unknown>,
    seq?: number,
  ): DaemonEvent {
    const finalSeq = seq ?? ++this.seq;
    const e: DaemonEvent = {
      seq: finalSeq,
      event,
      data,
      ts: Date.now(),
    };
    this.buffer.push(e);
    if (this.buffer.length > SSE_REPLAY_BUFFER) this.buffer.shift();
    for (const sub of this.subscribers) {
      try {
        sub(e);
      } catch {
        /* subscriber errors are non-fatal */
      }
    }
    return e;
  }

  /** Current seq counter (next event's seq will be this + 1). */
  lastSeq(): number {
    return this.seq;
  }

  /**
   * Replay events since lastEventId. Returns:
   *   - empty array: lastEventId >= buffer[0].seq (already ack'd everything)
   *   - subset of buffer: lastEventId is in the middle
   * If lastEventId < buffer[0].seq (overflowed / restart), returns null —
   * caller should emit `resync-required`.
   */
  replaySince(lastEventId: number): DaemonEvent[] | null {
    if (lastEventId < 0) lastEventId = 0;
    if (this.buffer.length === 0) {
      // No events ever published — even lastEventId=0 is "all ack'd"
      return [];
    }
    const firstSeq = this.buffer[0]!.seq;
    if (lastEventId < firstSeq - 1) {
      // Overflow or restart — can't replay
      return null;
    }
    return this.buffer.filter((e) => e.seq > lastEventId);
  }

  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(handler: (e: DaemonEvent) => void): () => void {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }

  /** Number of active subscribers (for /metrics). */
  subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Snapshot of buffer (for /debug/state). */
  snapshot(): DaemonEvent[] {
    return [...this.buffer];
  }

  /** Reset (for tests). */
  reset(): void {
    this.buffer = [];
    this.seq = 0;
    this.subscribers.clear();
  }
}
