// @ts-nocheck
/**
 * Hono app factory — assembles the daemon's HTTP server.
 *
 * createApp(ctx) returns a Hono instance with all routes mounted and all
 * middleware applied in the same order as the original daemon.ts:
 *
 *   1. hostGuard         127.0.0.1 / localhost only
 *   2. originGuard       OPTIONS preflight + reject POST-with-Origin
 *   3. errorEnvelope     catches thrown errors → {success:false, error}
 *   4. routes/*          health, v2, registry, clients, debug
 *
 * v1 routes (sessions/sync/ports) were removed in F10-2a.
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
import { registerRegistry } from "./routes/registry.js";
import { registerV2 } from "./routes/v2/index.js";
import { registerFaultEndpoints } from "../fault-injector.js";

export function createApp(ctx: DaemonContext): Hono {
  const app = new Hono();

  // Order matters: Host first (cheap header check), then Origin/CSRF, then
  // error envelope (catches anything in routes below), then route handlers.
  app.use("*", hostGuard);
  app.use("*", originGuard);
  app.use("*", errorEnvelope);

  // v2 routes — 新架构 §13.1. Primary API surface.
  // /health is mounted here via registerHealthV2 (§2 protocol surface).
  // The v1 registerHealth (from ./routes/health.ts) was removed in F10 — its
  // legacy v1-shape payload was a strict subset of registerHealthV2's, so
  // the v2 handler is the only one wired up.
  registerV2(app, ctx);

  // Fault injection (新架构 §11.2) — only active when NODE_ENV=test.
  // Gated at call-site for compile-time exclusion: when esbuild replaces
  // process.env.NODE_ENV with "production", the branch is dead-code-eliminated
  // so the fault-injector module's process.exit(1) never lands in prod binaries.
  if (process.env.NODE_ENV === "test") {
    registerFaultEndpoints(app, ctx.faults);
  }

  // Legacy /register + /unregister + /status (新架构 §13.1 末段).
  // 镜像到 ~/.agentdock/registry.json, 供 kill-all.ts 等运维脚本使用.
  // 数据已被 /client/register 吸收; 保留为兼容窗口, 旧版下线后删除.
  registerRegistry(app, ctx);
  registerClients(app, ctx);
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
