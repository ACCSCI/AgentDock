// @ts-nocheck
/**
 * Daemon API v2 — barrel that wires all sub-module routes.
 *
 * Routes mounted alongside the existing v1 surface (Phase 0-4 kept the v1
 * routes for backward compat). Each handler mutates stateV2 inside
 * Mutex.runExclusive("state", ...) so concurrent writes are serialized even
 * across `await` points (§6.1 "串行性靠什么").
 *
 * Errors (§13.2) are returned as { success:false, error:{ code, message } }.
 */
import type { Hono } from "hono";
import type { DaemonContext } from "../../context.js";
import { registerHealthV2, registerSyncV2 } from "./health.js";
import { registerSessionsV2, registerTakeover } from "./sessions.js";
import { registerClaim } from "./ports.js";
import { registerEvents } from "./events.js";
import { registerDebugState, registerMetrics } from "./debug.js";

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

// Re-export individual registrars for tests that import them directly
export { registerSessionsV2, registerTakeover } from "./sessions.js";
export { registerClaim } from "./ports.js";
