/**
 * Hono app factory — assembles the daemon's HTTP server.
 *
 * createApp(ctx) returns a Hono instance with all routes mounted and all
 * middleware applied in the same order as the original daemon.ts:
 *
 *   1. hostGuard         127.0.0.1 / localhost only
 *   2. originGuard       OPTIONS preflight + reject POST-with-Origin
 *   3. errorEnvelope     catches thrown errors → {success:false, error}
 *   4. routes/*          health, ports, registry, clients, sessions, sync, debug
 *
 * AppType is exported so the Electron main process (Phase 2) can build a
 * type-safe Hono client via `hc<AppType>(daemonUrl)`.
 */
import { Hono } from "hono";
import type { DaemonContext } from "./context.js";
import { errorEnvelope } from "./middleware/error.js";
import { hostGuard } from "./middleware/host.js";
import { originGuard } from "./middleware/origin.js";
import { registerClients } from "./routes/clients.js";
import { registerDebug } from "./routes/debug.js";
import { registerHealth } from "./routes/health.js";
import { registerPorts } from "./routes/ports.js";
import { registerRegistry } from "./routes/registry.js";
import { registerSessions } from "./routes/sessions.js";
import { registerSync } from "./routes/sync.js";
import { registerV2 } from "./routes/v2.js";

export function createApp(ctx: DaemonContext): Hono {
  const app = new Hono();

  // Order matters: Host first (cheap header check), then Origin/CSRF, then
  // error envelope (catches anything in routes below), then route handlers.
  app.use("*", hostGuard);
  app.use("*", originGuard);
  app.use("*", errorEnvelope);

  // v2 routes — 新架构 §13.1. Mounted BEFORE v1 so they take precedence
  // on overlapping paths (/health, /debug/state). v1 routes remain as
  // backward-compat for any client still using the old API.
  registerV2(app, ctx);

  registerHealth(app, ctx);
  registerPorts(app, ctx);
  registerRegistry(app, ctx);
  registerClients(app, ctx);
  registerSessions(app, ctx);
  registerSync(app, ctx);
  registerDebug(app, ctx);

  // 404 for unknown routes — preserves the original daemon's
  // `this.json(res, 404, { success: false, error: "Not found" })` behavior.
  app.notFound((c) => {
    return c.json({ success: false, error: "Not found" }, 404);
  });

  return app;
}

/**
 * Type-only export used by `hc<AppType>(daemonUrl)` in the Electron main.
 * Keeping it as a type alias avoids `typeof createApp` so consumers don't
 * accidentally invoke it server-side.
 */
export type AppType = ReturnType<typeof createApp>;