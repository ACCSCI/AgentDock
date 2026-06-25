/**
 * Debug and metrics routes for daemon API v2 (§11.1, P10).
 */
import {
  Hono,
  type DaemonContext,
  CURRENT_SCHEMA_VERSION,
  checkAllInvariants,
} from "./shared.js";

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
        lastSeq: ctx.sseBus.lastSeq(),
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

    // v2 empty — return minimal state with only client info.
    // v1 session/port methods were removed in F10-2b.
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
      lastSeq: ctx.sseBus.lastSeq(),
      startedAt: ctx.startedAt,
      state: {
        sessions: {},
        clients: Object.fromEntries(
          ctx.state.listClients().map((c) => [c.clientId, c]),
        ),
        allocatedPorts: [],
        worktreeIndex: {},
      },
      stats: {
        sessionCount: 0,
        clientCount: ctx.state.listClients().length,
        allocatedPortCount: 0,
      },
    });
  });

  // P2+ (二审修) — v2 不变式校验端点. v1 /debug/invariants 仍存在 (debug.ts),
  // 不同路径避免 Hono 路由覆盖 (v2 registerDebugState 在 v1 registerDebug 之前).
  // 路由名 /debug/invariants-v2; E2E helper 调这个端点跑 §11.3 的 8 条断言.
  // 失败返 503 + 详细 detail, 正常情况返 200 + ok=true + 每条 detail.
  app.get("/debug/invariants-v2", (c) => {
    // §3.5/§11.3 #1 — 运行时监听集合从 v2 已分配的端口派生
    // (RESERVED 必有 owner; 监听端口是 OS 视角, 在 probe-time 收集).
    // 这里用所有 v2 allocated ports 作为 listener 集合上界:
    //   - 真监听 ⊆ allocated, 所以 allocated ⊇ listener 时 #1 一定过
    //   - 真监听 ⊆ RESERVED, RESERVED ⊆ allocated, 所以仍成立
    // 真正的运行时监听由 E2E 用 probeRuntime 收集, 这里用 allocated 给 daemon
    // 端自检一个保守起点.
    const listeners = new Set<number>(
      ctx.stateV2.listAllPorts().map((p) => p.port),
    );
    const composite = checkAllInvariants(ctx.stateV2, listeners);
    if (!composite.ok) {
      return c.json(
        {
          success: false,
          error: {
            code: "INVARIANT_VIOLATION",
            message: `${composite.failed.length} invariant(s) violated`,
            failed: composite.failed,
          },
          results: composite.results,
        },
        503,
      );
    }
    return c.json({ success: true, ...composite });
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
