/**
 * GET /health — daemon liveness probe.
 *
 * Returns `{ status: "ok", daemonPort }` where daemonPort is the OS-assigned
 * port if port=0 was used. Used by DaemonManager to detect readiness.
 */
import { Hono } from "hono";
import type { DaemonContext } from "../context.js";

export function registerHealth(app: Hono, _ctx: DaemonContext): void {
  app.get("/health", (c) => {
    return c.json({ success: true, status: "ok", daemonPort: _ctx.actualPort });
  });
}