/**
 * Hono typed client — type-safe RPC to the AgentDock daemon.
 *
 * Phase 2: replaces ad-hoc fetch wrappers with `hc<AppType>`. The Hono
 * client's proxy is generated from the daemon's Hono app shape, so every
 * route appears as a method and the JSON body/response types are inferred
 * from the zod schemas registered in plugins/daemon/routes/*.
 *
 * Usage (Electron main, Phase 3+):
 *   import { createDaemonClient } from "./hono-client.js";
 *
 *   const client = createDaemonClient(`http://127.0.0.1:${daemonPort}`);
 *   const res = await client.sessions.$post({
 *     json: { clientId, sessionId, projectPath, worktreePath },
 *   });
 *   if (!res.ok) throw new Error("allocate failed");
 *   const data = await res.json(); // typed!
 *
 * Why `hc<AppType>` over the hand-rolled DaemonClient class:
 *   - End-to-end type safety: if a route's zod schema changes, callers get
 *     a TypeScript error at the call site, not a runtime 400.
 *   - No manual method per route — Hono generates them from the app.
 *   - The body/response types flow through zod, so we can't drift.
 *
 * Why AppType comes from `./daemon/app.js`:
 *   - plugins/daemon/app.ts exports both `createApp(ctx)` and `AppType`.
 *   - The Hono client uses the inferred type of the routes, which is the
 *     contract between daemon and consumer.
 *   - plugins/daemon.ts (re-export) preserves the AppType surface for
 *     Electron main, so consumers don't need to know the directory layout.
 */
import { hc } from "hono/client";
import type { AppType } from "../../plugins/daemon/app.js";

/**
 * Build a type-safe Hono client for the daemon at the given base URL.
 * The returned proxy exposes one method per daemon route, with full
 * request/response typing derived from the daemon's zod schemas.
 *
 * @param baseUrl - The daemon's HTTP base URL, e.g. "http://127.0.0.1:54321".
 *                  Must NOT have a trailing slash.
 */
export function createDaemonClient(baseUrl: string) {
  return hc<AppType>(baseUrl);
}

/** Inferred type of the Hono client. Useful for mocking in tests. */
export type DaemonHonoClient = ReturnType<typeof createDaemonClient>;

// Re-export AppType so consumers don't need to know the daemon/ subdir path.
export type { AppType };
