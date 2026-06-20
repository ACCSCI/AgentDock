/**
 * Daemon API v2 — 新架构 §13.1.
 *
 * Routes mounted alongside the existing v1 surface (Phase 0-4 kept the v1
 * routes for backward compat). Each handler mutates stateV2 inside
 * Mutex.runExclusive("state", …) so concurrent writes are serialized even
 * across `await` points (§6.1 "串行性靠什么").
 *
 * Endpoint summary:
 *   GET  /health              — protocolVersion, capabilities, state, pid, port
 *   POST /sync                — full snapshot + lastSeq ack (snapshotSeq on read)
 *   POST /session/create      — new session, owner=fencingToken=1, status=creating
 *   POST /session/activate    — commit point reached, status=active, lease=null
 *   POST /session/rename      — displayName only (id/path/branch untouched)
 *   POST /session/delete      — phase 1: status=deleting, release all ports
 *   POST /session/purge       — phase 2: drop 3-table entries after physical cleanup
 *   POST /session/heartbeat   — refresh session lease (§4.4)
 *   POST /takeover            — fencingToken bump, swap clientId/pid (§6.1)
 *   POST /claim               — claim N ports (fenced); supports bindFailed hint
 *   POST /release             — release N ports (fenced)
 *   POST /reassign            — manual force-reassign, ignores preferredPort
 *   GET  /events              — SSE (P5: placeholder; flushes a single hello frame)
 *   GET  /debug/state         — full v2 state snapshot for observability
 *   GET  /metrics             — counters (P10: stub returns zeros)
 *
 * Errors (§13.2) are returned as { success:false, error:{ code, message } }.
 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { DaemonContext } from "../context.js";
import {
  LEASE_TTL_MS,
  PROTOCOL_VERSION,
} from "../../constants.js";
import {
  CURRENT_SCHEMA_VERSION,
  PortConflictError,
  StaleOwnerError,
  type DaemonStateV2,
} from "../../daemon-state-v2.js";
import { isPortAvailable, pickFreePort } from "../../port-allocator.js";
import { zodErrorHandler } from "../middleware/error.js";

const SESSION_ID_RE = /^[a-zA-Z0-9-_]+$/;

const PROTOCOL_VERSION_STR = String(PROTOCOL_VERSION);

// ---------------------------------------------------------------------------
// /health — upgraded with §2 capabilities and lifecycle state
// ---------------------------------------------------------------------------

const HEALTH_CAPABILITIES = [
  "port-allocation",
  "session-registry",
  "claim-port",
  "fencing",
  "lifecycle-lease",
] as const;

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
      snapshotSeq: ctx.lastSeq,
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

// ---------------------------------------------------------------------------
// /session/* — lifecycle (§4.2)
// ---------------------------------------------------------------------------

const SessionCreateSchema = z.object({
  clientId: z.string().min(1, "clientId required"),
  pid: z.number().int().positive(),
  projectRoot: z.string().min(1, "projectRoot required"),
  displayName: z.string().max(128).optional(),
});

const SessionActivateSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE, "Invalid sessionId"),
  fencingToken: z.number().int().positive(),
});

const SessionRenameSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE, "Invalid sessionId"),
  fencingToken: z.number().int().positive(),
  displayName: z.string().min(1).max(128),
});

const SessionDeleteSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE, "Invalid sessionId"),
  fencingToken: z.number().int().positive(),
});

const SessionPurgeSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE, "Invalid sessionId"),
  fencingToken: z.number().int().positive(),
});

const SessionHeartbeatSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE, "Invalid sessionId"),
  fencingToken: z.number().int().positive(),
  phase: z.enum(["creating", "deleting"]).optional(),
});

export function registerSessionsV2(app: Hono, ctx: DaemonContext): void {
  app.post(
    "/session/create",
    zValidator("json", SessionCreateSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      const result = await ctx.mutex.runExclusive("state", () => {
        const sessionId = crypto.randomUUID();
        const displayName =
          body.displayName?.trim() || sessionId.slice(0, 8);
        ctx.stateV2.createSession({
          sessionId,
          projectRoot: body.projectRoot,
          displayName,
          clientId: body.clientId,
          pid: body.pid,
          leaseExpiresAt: Date.now() + LEASE_TTL_MS,
        });
        ctx.walV2.persist(ctx.stateV2);
        return {
          sessionId,
          fencingToken: ctx.stateV2.getOwner(sessionId)?.fencingToken ?? 1,
        };
      });
      return c.json({ success: true, ...result });
    },
  );

  app.post(
    "/session/activate",
    zValidator("json", SessionActivateSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      try {
        await ctx.mutex.runExclusive("state", () => {
          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);
          ctx.stateV2.activateSession(body.sessionId);
          ctx.walV2.persist(ctx.stateV2);
        });
        return c.json({ success: true });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  app.post(
    "/session/rename",
    zValidator("json", SessionRenameSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      try {
        await ctx.mutex.runExclusive("state", () => {
          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);
          ctx.stateV2.renameSession(body.sessionId, body.displayName);
          ctx.walV2.persist(ctx.stateV2);
        });
        return c.json({ success: true });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  app.post(
    "/session/delete",
    zValidator("json", SessionDeleteSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      try {
        await ctx.mutex.runExclusive("state", () => {
          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);
          ctx.stateV2.beginDelete(body.sessionId, Date.now() + LEASE_TTL_MS);
          ctx.walV2.persist(ctx.stateV2);
        });
        return c.json({ success: true });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  app.post(
    "/session/purge",
    zValidator("json", SessionPurgeSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      try {
        await ctx.mutex.runExclusive("state", () => {
          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);
          ctx.stateV2.purgeSession(body.sessionId);
          ctx.walV2.persist(ctx.stateV2);
        });
        return c.json({ success: true });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  app.post(
    "/session/heartbeat",
    zValidator("json", SessionHeartbeatSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      try {
        await ctx.mutex.runExclusive("state", () => {
          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);
          ctx.stateV2.renewLease(body.sessionId, LEASE_TTL_MS);
          ctx.walV2.persist(ctx.stateV2);
        });
        return c.json({ success: true });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// /takeover — fencingToken bump (§6.1)
// ---------------------------------------------------------------------------

const TakeoverSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE),
  clientId: z.string().min(1),
  pid: z.number().int().positive(),
  fencingToken: z.number().int().positive(),
});

export function registerTakeover(app: Hono, ctx: DaemonContext): void {
  app.post(
    "/takeover",
    zValidator("json", TakeoverSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      try {
        const result = await ctx.mutex.runExclusive("state", () => {
          const r = ctx.stateV2.takeover(
            body.sessionId,
            body.clientId,
            body.pid,
            body.fencingToken,
          );
          ctx.walV2.persist(ctx.stateV2);
          return r;
        });
        return c.json({ success: true, ...result });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );
}

// ---------------------------------------------------------------------------
// /claim /release /reassign — port ops (§3.3, §3.4, §6.2)
// ---------------------------------------------------------------------------

const ClaimSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE),
  fencingToken: z.number().int().positive(),
  requestedPort: z.number().int().min(1).max(65535).optional(),
  name: z.string().min(1).max(64).default("PORT"),
  bindFailed: z.boolean().optional().default(false),
});

const ReleaseSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE),
  fencingToken: z.number().int().positive(),
  port: z.number().int().min(1).max(65535),
});

const ReassignSchema = z.object({
  sessionId: z.string().min(1).regex(SESSION_ID_RE),
  fencingToken: z.number().int().positive(),
});

export function registerClaim(app: Hono, ctx: DaemonContext): void {
  app.post(
    "/claim",
    zValidator("json", ClaimSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      try {
        const result = await ctx.mutex.runExclusive("state", async () => {
          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);

          // §5.2 — RECOVERING only allows recovery claims (handled at /sync
          // level); new claims during RECOVERING must wait. For now the
          // v1 surface handles RECOVERING — we keep the v2 path open.
          // TODO P4: integrate state-aware RECOVERING gate.

          const requested = body.requestedPort;
          if (requested !== undefined) {
            // Try the requested port first
            const owner = ctx.stateV2.getPortOwner(requested);
            if (owner && owner.sessionId !== body.sessionId) {
              return await conflictBranch(
                ctx.stateV2,
                body.sessionId,
                body.name,
                body.bindFailed ? requested : undefined,
              );
            }
            // Idempotent for same session — no probe needed
            if (owner && owner.sessionId === body.sessionId) {
              ctx.walV2.persist(ctx.stateV2);
              return { port: requested, picked: false };
            }
            // Free per registry — bind probe (§3.3)
            if (!(await isPortAvailable(requested))) {
              return await conflictBranch(
                ctx.stateV2,
                body.sessionId,
                body.name,
                body.bindFailed ? requested : undefined,
              );
            }
            // Reserve it
            ctx.stateV2.claimPort(body.sessionId, requested, body.name);
            ctx.walV2.persist(ctx.stateV2);
            return { port: requested, picked: false };
          }

          // No requested port → allocate a fresh free one
          const picked = await pickFreePort(
            ctx.stateV2.listAllPorts().map((p) => p.port),
          );
          ctx.stateV2.claimPort(body.sessionId, picked, body.name);
          ctx.walV2.persist(ctx.stateV2);
          return { port: picked, picked: true };
        });
        return c.json({ success: true, ...result });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  app.post(
    "/release",
    zValidator("json", ReleaseSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      try {
        await ctx.mutex.runExclusive("state", () => {
          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);
          ctx.stateV2.releasePort(body.sessionId, body.port);
          ctx.walV2.persist(ctx.stateV2);
        });
        return c.json({ success: true });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );

  app.post(
    "/reassign",
    zValidator("json", ReassignSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      try {
        const result = await ctx.mutex.runExclusive("state", async () => {
          ctx.stateV2.assertFencingToken(body.sessionId, body.fencingToken);
          // Release all old ports, pick new ones for each name
          const oldPorts = ctx.stateV2.getSessionPorts(body.sessionId);
          const oldNames = ctx.stateV2.getSessionPortNames(body.sessionId);
          ctx.stateV2.releaseAllPorts(body.sessionId);
          const excluded = new Set(ctx.stateV2.listAllPorts().map((p) => p.port));
          const newPorts: Record<string, number> = {};
          for (const name of oldNames) {
            const p = await pickFreePort([...excluded]);
            ctx.stateV2.claimPort(body.sessionId, p, name);
            newPorts[name] = p;
            excluded.add(p);
          }
          ctx.walV2.persist(ctx.stateV2);
          return { ports: newPorts, oldPorts };
        });
        return c.json({ success: true, ...result });
      } catch (err) {
        return mapError(c, err);
      }
    },
  );
}

async function conflictBranch(
  state: DaemonStateV2,
  sessionId: string,
  name: string,
  /** If bindFailed was set, caller already knows requestedPort is taken —
   * skip re-probing and pick a fresh one immediately. */
  skipProbePort: number | undefined,
): Promise<{ port: number; picked: true }> {
  const excluded = new Set(state.listAllPorts().map((p) => p.port));
  if (skipProbePort !== undefined) excluded.add(skipProbePort);
  const picked = await pickFreePort([...excluded]);
  state.claimPort(sessionId, picked, name);
  return { port: picked, picked: true };
}

// ---------------------------------------------------------------------------
// /events — SSE (P5 full impl, this is the §7.3 frame format placeholder)
// ---------------------------------------------------------------------------

export function registerEvents(app: Hono, ctx: DaemonContext): void {
  app.get("/events", (c) => {
    const lastEventId = Number(c.req.header("Last-Event-ID") ?? "0") || 0;
    return streamSSE(c, async (stream) => {
      // P5 will replace this with a ring-buffer replay + a subscribe loop.
      // For now, send a single hello frame so clients can probe the channel.
      await stream.writeSSE({
        event: "hello",
        id: String(ctx.lastSeq),
        data: JSON.stringify({ seq: ctx.lastSeq, state: ctx.stateV2.state }),
      });
      // Keep the connection open with periodic heartbeats (5s) so
      // middleboxes don't drop it. P5 replaces this with the proper
      // subscription model.
      const interval = setInterval(() => {
        stream
          .writeSSE({
            event: "heartbeat",
            id: String(ctx.lastSeq),
            data: JSON.stringify({ t: Date.now() }),
          })
          .catch(() => {
            /* client gone — interval will be cleared by onAbort below */
          });
      }, 5_000);
      stream.onAbort(() => clearInterval(interval));
      // Block until aborted — the interval keeps the stream alive.
      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });
      clearInterval(interval);
      // Suppress "unused" linting on lastEventId — full replay lives in P5.
      void lastEventId;
    });
  });
}

// ---------------------------------------------------------------------------
// /debug/state — full v2 snapshot for §11.1 observability
// ---------------------------------------------------------------------------

export function registerDebugState(app: Hono, ctx: DaemonContext): void {
  app.get("/debug/state", (c) => {
    // Prefer v2 state (新架构 truth source); fall back to v1 state if v2 is
    // empty (during transitional period where some routes still write only
    // to v1). This keeps v1 /debug/state consumers seeing their data while
    // v2 clients get the canonical registry.
    const v2 = ctx.stateV2.serialize();
    const v2HasData = Object.keys(v2.sessions).length > 0;

    if (v2HasData) {
      const v1Sessions: Record<string, unknown> = {};
      for (const [id, sess] of Object.entries(v2.sessions)) {
        v1Sessions[id] = {
          sessionId: id,
          worktreePath: `${sess.projectRoot}/.agentdock/worktrees/${id}`,
          projectPath: sess.projectRoot,
          ports: Object.fromEntries(
            ctx.stateV2.getSessionPorts(id).map((p) => [
              ctx.stateV2.getPortOwner(p)?.name ?? "?",
              p,
            ]),
          ),
          ownerClientId: ctx.stateV2.getOwner(id)?.clientId,
          createdAt: new Date(sess.createdAt).toISOString(),
        };
      }
      const allocatedPorts = ctx.stateV2.listAllPorts().map((p) => p.port);
      return c.json({
        success: true,
        schemaVersion: CURRENT_SCHEMA_VERSION,
        lifecycleState: ctx.stateV2.state,
        port: ctx.actualPort || ctx.port,
        pid: process.pid,
        v2Sessions: v2.sessions,
        v2Owners: v2.owners,
        v2Ports: v2.ports,
        metrics: ctx.metrics,
        lastSeq: ctx.lastSeq,
        startedAt: ctx.startedAt,
        state: {
          sessions: v1Sessions,
          clients: Object.fromEntries(
            ctx.stateV2.listOwners().map((o) => [
              o.clientId,
              {
                clientId: o.clientId,
                pid: o.pid,
                projectPaths: [],
                lastHeartbeat: Date.now(),
              },
            ]),
          ),
          allocatedPorts,
          worktreeIndex: Object.fromEntries(
            Object.entries(v1Sessions).map(([id]) => [
              `${(v2.sessions[id]?.projectRoot ?? "")}/.agentdock/worktrees/${id}`,
              id,
            ]),
          ),
        },
        stats: {
          sessionCount: Object.keys(v2.sessions).length,
          clientCount: ctx.stateV2.listOwners().length,
          allocatedPortCount: allocatedPorts.length,
        },
      });
    }

    // v2 empty — fall through to v1 state for the legacy view.
    // v1 surface only; v2 fields are empty markers.
    const v1Debug = ctx.state.toDebugObject();
    return c.json({
      success: true,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      lifecycleState: ctx.stateV2.state,
      port: ctx.actualPort || ctx.port,
      pid: process.pid,
      v2Sessions: {},
      v2Owners: {},
      v2Ports: {},
      metrics: ctx.metrics,
      lastSeq: ctx.lastSeq,
      startedAt: ctx.startedAt,
      state: v1Debug,
      stats: ctx.state.getStats(),
    });
  });
}

// ---------------------------------------------------------------------------
// /metrics — P10 placeholder; real counters in P10
// ---------------------------------------------------------------------------

export function registerMetrics(app: Hono, ctx: DaemonContext): void {
  app.get("/metrics", (c) => {
    return c.json({
      success: true,
      claimCount: ctx.metrics.claimCount,
      conflictCount: ctx.metrics.conflictCount,
      releaseCount: ctx.metrics.releaseCount,
      heartbeatTimeoutCount: ctx.metrics.heartbeatTimeoutCount,
      activeSessionCount: ctx.metrics.activeSessionCount,
      sseConnections: ctx.metrics.sseConnections,
    });
  });
}

// ---------------------------------------------------------------------------
// Error mapping — §13.2 codes
// ---------------------------------------------------------------------------

function mapError(c: Parameters<Parameters<Hono["post"]>[1]>[0], err: unknown) {
  if (err instanceof StaleOwnerError) {
    return c.json(
      {
        success: false,
        error: {
          code: "STALE_OWNER",
          message: err.message,
          currentToken: err.currentToken,
        },
      },
      409,
    );
  }
  if (err instanceof PortConflictError) {
    return c.json(
      {
        success: false,
        error: {
          code: "PORT_CONFLICT",
          message: err.message,
          port: err.port,
          ownerSessionId: err.ownerSessionId,
        },
      },
      409,
    );
  }
  if (err instanceof Error && err.message.includes("not found")) {
    return c.json(
      {
        success: false,
        error: { code: "UNKNOWN_SESSION", message: err.message },
      },
      404,
    );
  }
  return c.json(
    {
      success: false,
      error: { code: "INTERNAL", message: (err as Error).message },
    },
    500,
  );
}

// ---------------------------------------------------------------------------
// Public mount helper — wire all v2 routes
// ---------------------------------------------------------------------------

export function registerV2(app: Hono, ctx: DaemonContext): void {
  registerHealthV2(app, ctx);
  registerSyncV2(app, ctx);
  registerSessionsV2(app, ctx);
  registerTakeover(app, ctx);
  registerClaim(app, ctx);
  registerEvents(app, ctx);
  registerDebugState(app, ctx);
  registerMetrics(app, ctx);
}
