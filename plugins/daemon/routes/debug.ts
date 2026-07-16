// @ts-nocheck
/**
 * Debug routes — client-focused state inspection + test-only mutation helpers.
 *
 *   GET  /debug/clients         client list with heartbeat status
 *   POST /debug/simulate-stale  { clientId } — set heartbeat to 0 (test only)
 *   POST /debug/trigger-cleanup — force a stale-client sweep (test only)
 *
 * v1 debug endpoints (/debug/state, /debug/invariants, /debug/ports, /debug/wal)
 * were removed in F10-2b along with daemon-state session/port methods.
 * Use v2 /debug/state-v2 for session/port inspection.
 */
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import { type DaemonContext, HEARTBEAT_TIMEOUT_MS, cleanupStaleClients } from "../context.js";
import { zodErrorHandler } from "../middleware/error.js";

const SimulateStaleSchema = z.object({
  clientId: z.string().min(1, "clientId required"),
});

export function registerDebug(app: Hono, ctx: DaemonContext): void {
  app.get("/debug/clients", (c) => {
    const now = Date.now();
    const clients = ctx.state.listClients().map((cl) => ({
      clientId: cl.clientId,
      pid: cl.pid,
      projectPaths: cl.projectPaths,
      lastHeartbeat: cl.lastHeartbeat,
      heartbeatAge: now - cl.lastHeartbeat,
      isStale: now - cl.lastHeartbeat > HEARTBEAT_TIMEOUT_MS,
    }));

    const staleCount = clients.filter((cl) => cl.isStale).length;

    return c.json({
      success: true,
      clients,
      heartbeatTimeout: HEARTBEAT_TIMEOUT_MS,
      staleCount,
    });
  });

  app.post(
    "/debug/simulate-stale",
    zValidator("json", SimulateStaleSchema, zodErrorHandler),
    (c) => {
      const { clientId } = c.req.valid("json");
      const client = ctx.state.getClient(clientId);
      if (!client) {
        return c.json({ success: false, error: "Client not found" }, 404);
      }
      // Direct mutation is intentional for this debug helper — there's no
      // "staleHeartbeatAt" method on DaemonState, and adding one would be
      // over-engineered for a test-only endpoint.
      client.lastHeartbeat = 0;
      return c.json({
        success: true,
        message: `Client ${clientId} heartbeat set to 0, will be cleaned up on next check`,
      });
    },
  );

  app.post("/debug/trigger-cleanup", async (c) => {
    await cleanupStaleClients(ctx);
    return c.json({ success: true, message: "Cleanup triggered" });
  });
}
