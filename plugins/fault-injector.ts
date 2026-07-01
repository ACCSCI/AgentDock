// @ts-nocheck
/**
 * Fault injection — 新架构 §11.2.
 *
 * Provides test-only endpoints that simulate real-world failures:
 *   - crashDaemon:    exit the process (Daemon restart path)
 *   - grabPort(p):    bind a port externally (forces bind probe to fail)
 *   - stallOwner(ms): freeze the next claim/reassign for `ms` ms
 *   - partitionClient(): drop the connection (heartbeat timeout)
 *
 * Gating: NODE_ENV=test OR an explicit `enableFaultInjection: true` flag
 * in DaemonOptions. Production builds MUST strip these endpoints.
 *
 * The injector uses a plain object for its state so endpoint handlers can
 * mutate it without escaping closures.
 */
import { createServer, type Server } from "node:net";
import type { Hono } from "hono";

export interface FaultInjectorState {
  /** Master switch — must be true to enable ANY fault endpoint. */
  enabled: boolean;
  /** Active externally-bound grabbers keyed by port. */
  grabbedPorts: Map<number, Server>;
  /** 0 = not stalled; >0 = unstall at this wall-clock ms. */
  stallExpiresAt: number;
}

export function createFaultInjectorState(
  opts: Partial<FaultInjectorState> = {},
): FaultInjectorState {
  return {
    enabled: opts.enabled ?? process.env.NODE_ENV === "test",
    grabbedPorts: opts.grabbedPorts ?? new Map(),
    stallExpiresAt: opts.stallExpiresAt ?? 0,
  };
}

/** Async wait until stall expires (no-op if not stalled). */
export async function waitForUnstall(state: FaultInjectorState): Promise<void> {
  while (Date.now() < state.stallExpiresAt) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Release all grabbed ports. */
export async function cleanupFaults(state: FaultInjectorState): Promise<void> {
  for (const [port, srv] of state.grabbedPorts) {
    await new Promise<void>((r) => srv.close(() => r()));
    state.grabbedPorts.delete(port);
  }
}

/**
 * Mount fault-injection endpoints on the given Hono app. Endpoints return
 * 404 when disabled, so test code can probe without checking the flag.
 */
export function registerFaultEndpoints(
  app: Hono,
  state: FaultInjectorState,
): void {
  // Register specific routes FIRST so they take precedence over the wildcard.
  // Hono matches in registration order — wildcard last is the catch-all 404.

  app.post("/__inject/crashDaemon", (c) => {
    if (!state.enabled) return c.json({ success: false }, 404);
    setImmediate(() => process.exit(1));
    return c.json({ success: true, message: "daemon will crash" });
  });

  app.post("/__inject/grabPort", async (c) => {
    if (!state.enabled) return c.json({ success: false }, 404);
    const body = (await c.req.json().catch(() => null)) as { port?: number } | null;
    if (!body || typeof body.port !== "number") {
      return c.json({ success: false, error: "port required" }, 400);
    }
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(body.port, "127.0.0.1", () => resolve());
      });
      state.grabbedPorts.set(body.port, server);
      return c.json({ success: true, port: body.port });
    } catch (err) {
      return c.json({ success: false, error: (err as Error).message }, 500);
    }
  });

  app.post("/__inject/stallOwner", async (c) => {
    if (!state.enabled) return c.json({ success: false }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { ms?: number };
    const ms = body.ms ?? 5000;
    state.stallExpiresAt = Date.now() + ms;
    setTimeout(() => {
      state.stallExpiresAt = 0;
    }, ms);
    return c.json({ success: true, stallMs: ms });
  });

  app.post("/__inject/partitionClient", (c) => {
    if (!state.enabled) return c.json({ success: false }, 404);
    return c.json({
      success: true,
      message: "partitionClient stub — would close all SSE connections",
    });
  });

  app.post("/__inject/releasePort", async (c) => {
    if (!state.enabled) return c.json({ success: false }, 404);
    const body = (await c.req.json().catch(() => null)) as { port?: number } | null;
    if (!body || typeof body.port !== "number") {
      return c.json({ success: false, error: "port required" }, 400);
    }
    const srv = state.grabbedPorts.get(body.port);
    if (!srv) return c.json({ success: false, error: "port not grabbed" }, 404);
    await new Promise<void>((r) => srv.close(() => r()));
    state.grabbedPorts.delete(body.port);
    return c.json({ success: true, port: body.port });
  });

  // Wildcard catch-all for unknown /__inject/* paths — must be LAST so the
  // specific routes above take precedence.
  app.post("/__inject/*", (c) => {
    if (!state.enabled) {
      return c.json({ success: false, error: "fault injection not enabled" }, 404);
    }
    return c.json({ success: false, error: "unknown inject endpoint" }, 404);
  });
}
