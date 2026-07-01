// @ts-nocheck
/**
 * Health & Sync routes for daemon API v2 (§13.1).
 */
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  Hono,
  type DaemonContext,
  PROTOCOL_VERSION_STR,
  HEALTH_CAPABILITIES,
  CURRENT_SCHEMA_VERSION,
  zodErrorHandler,
} from "./shared.js";

// ---------------------------------------------------------------------------
// /health — upgraded with §2 capabilities and lifecycle state
// ---------------------------------------------------------------------------

export function registerHealthV2(app: Hono, ctx: DaemonContext): void {
  app.get("/health", (c) => {
    const port = ctx.actualPort || ctx.port;
    // Superset of v1 /health (status, daemonPort, pid) plus v2 fields
    // (protocolVersion, schemaVersion, capabilities, state, startedAt).
    // Existing v1 clients see their fields unchanged; v2 clients get the
    // §2 capability negotiation surface.
    return c.json({
      success: true,
      status: "ok",
      daemonPort: port,
      pid: process.pid,
      port,
      protocolVersion: PROTOCOL_VERSION_STR,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      state: ctx.stateV2.state,
      capabilities: [...HEALTH_CAPABILITIES],
      startedAt: ctx.startedAt,
    });
  });
}

// ---------------------------------------------------------------------------
// /sync — full snapshot (read-only, also acts as client heartbeat)
// ---------------------------------------------------------------------------

const SyncSchema = z.object({
  clientId: z.string().min(1, "clientId required"),
  pid: z.number().int().positive("pid must be positive"),
  lastSeq: z.number().int().nonnegative().optional().default(0),
});

/**
 * Return the current v2 state for the client. The snapshotSeq tells the
 * client to apply this snapshot FIRST and discard any in-flight SSE events
 * with seq <= snapshotSeq (§7.3 ordering fix).
 *
 * Implementation note: this is a snapshot of stateV2 captured at the moment
 * of read. SSE event seq is a separate counter (incremented by P5).
 */
export function registerSyncV2(app: Hono, ctx: DaemonContext): void {
  app.post("/sync", zValidator("json", SyncSchema, zodErrorHandler), (c) => {
    const body = c.req.valid("json");
    return c.json({
      success: true,
      state: ctx.stateV2.state,
      // §7.3 — snapshotSeq 必须是当前 SSE seq 水位, client 据此过滤
      // "快照之后" 的增量事件 (seq > snapshotSeq). 用 sseBus.lastSeq()
      // 而非 ctx.lastSeq (后者初始 0 永不变, 会让 client 永远丢弃所有
      // seq>0 的增量, §11.3 #8 invariant 直接失效).
      snapshotSeq: ctx.sseBus.lastSeq(),
      sessions: ctx.stateV2.listSessions().map((s) => ({
        sessionId: s.sessionId,
        projectRoot: s.projectRoot,
        displayName: s.displayName,
        status: s.status,
        createdAt: s.createdAt,
        ports: Object.fromEntries(
          ctx.stateV2.getSessionPorts(s.sessionId).map((p) => [
            ctx.stateV2.getPortOwner(p)?.name ?? "?",
            p,
          ]),
        ),
      })),
      owners: ctx.stateV2.listOwners(),
      ports: ctx.stateV2.listAllPorts(),
      serverTime: Date.now(),
      // Echo the client's heartbeat so they can reconcile RTT
      lastSeq: body.lastSeq,
    });
  });
}
