// @ts-nocheck
/**
 * SSE events route for daemon API v2 (§7.3).
 */
import { type DaemonContext, type Hono, streamSSE } from "./shared.js";

// ---------------------------------------------------------------------------
// /events — SSE (P5 full impl, this is the §7.3 frame format placeholder)
// ---------------------------------------------------------------------------

export function registerEvents(app: Hono, ctx: DaemonContext): void {
  app.get("/events", (c) => {
    const lastEventId = Number(c.req.header("Last-Event-ID") ?? "0") || 0;
    return streamSSE(c, async (stream) => {
      // Step 1: replay events since lastEventId from ring buffer
      const replay = ctx.sseBus.replaySince(lastEventId);
      if (replay === null) {
        // Buffer overflowed or daemon restart — send resync-required signal
        await stream.writeSSE({
          event: "resync-required",
          id: "0",
          data: JSON.stringify({ reason: "buffer-overflow" }),
        });
        // After resync-required, also stream a snapshot hint so client can
        // immediately call /sync without waiting for the next event.
      } else {
        for (const e of replay) {
          await stream.writeSSE({
            event: e.event,
            id: String(e.seq),
            data: JSON.stringify(e.data),
          });
        }
        // Hello frame confirms replay done, client should treat all replayed
        // events as already applied.
        await stream.writeSSE({
          event: "hello",
          id: String(ctx.sseBus.lastSeq()),
          data: JSON.stringify({
            seq: ctx.sseBus.lastSeq(),
            state: ctx.stateV2.state,
            replayedCount: replay.length,
          }),
        });
      }

      // Step 2: subscribe to live events until client aborts
      ctx.metrics.sseConnections++;
      const unsub = ctx.sseBus.subscribe(async (e) => {
        try {
          await stream.writeSSE({
            event: e.event,
            id: String(e.seq),
            data: JSON.stringify(e.data),
          });
        } catch {
          unsub();
        }
      });

      // Periodic heartbeat (5s) so middleboxes don't drop the connection
      const heartbeatInterval = setInterval(() => {
        try {
          ctx.sseBus.publish("heartbeat", { t: Date.now() });
        } catch {
          /* bus error is non-fatal */
        }
      }, 5_000);

      // Block until client aborts
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          clearInterval(heartbeatInterval);
          unsub();
          ctx.metrics.sseConnections = Math.max(0, ctx.metrics.sseConnections - 1);
          resolve();
        });
      });
    });
  });
}
