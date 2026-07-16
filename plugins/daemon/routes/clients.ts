// @ts-nocheck
/**
 * Client lifecycle routes.
 *
 *   POST /client/register   { clientId, pid, projectPaths }
 *   POST /client/unregister { clientId }
 *   POST /client/heartbeat  { clientId }
 *
 * All three mutate DaemonState under the "state" mutex. Heartbeat additionally
 * throttles WAL persistence — we only write to disk every
 * HEARTBEAT_PERSIST_INTERVAL_MS per client to avoid hammering the FS.
 *
 * Note: the body validation regex for sessionId (alphanumeric + dash + underscore)
 * lives in /sessions/allocate, not here — clients don't carry that field.
 */
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { z } from "zod";
import { type DaemonContext, HEARTBEAT_PERSIST_INTERVAL_MS } from "../context.js";
import { zodErrorHandler } from "../middleware/error.js";

const RegisterSchema = z.object({
  clientId: z.string().min(1, "clientId required"),
  pid: z.number().int().positive("pid must be a positive integer"),
  projectPaths: z.array(z.string()).min(1, "projectPaths must be a non-empty array"),
});

const ClientIdSchema = z.object({
  clientId: z.string().min(1, "clientId required"),
});

export function registerClients(app: Hono, ctx: DaemonContext): void {
  app.post("/client/register", zValidator("json", RegisterSchema, zodErrorHandler), async (c) => {
    const { clientId, pid, projectPaths } = c.req.valid("json");
    await ctx.mutex.runExclusive("state", () => {
      ctx.state.registerClient(clientId, pid, projectPaths);
      ctx.lastPersistedHeartbeatAt.set(
        clientId,
        ctx.state.getClient(clientId)?.lastHeartbeat ?? Date.now(),
      );
      ctx.wal.persist(ctx.state);
    });
    return c.json({ success: true });
  });

  app.post("/client/unregister", zValidator("json", ClientIdSchema, zodErrorHandler), async (c) => {
    const { clientId } = c.req.valid("json");
    await ctx.mutex.runExclusive("state", () => {
      ctx.state.unregisterClient(clientId);
      ctx.lastPersistedHeartbeatAt.delete(clientId);
      ctx.wal.persist(ctx.state);
    });
    return c.json({ success: true });
  });

  app.post("/client/heartbeat", zValidator("json", ClientIdSchema, zodErrorHandler), async (c) => {
    const { clientId } = c.req.valid("json");
    await ctx.mutex.runExclusive("state", () => {
      const before = ctx.state.getClient(clientId)?.lastHeartbeat ?? 0;
      ctx.state.heartbeat(clientId);
      const after = ctx.state.getClient(clientId)?.lastHeartbeat ?? before;
      const lastPersisted = ctx.lastPersistedHeartbeatAt.get(clientId) ?? 0;
      if (after > before && after - lastPersisted >= HEARTBEAT_PERSIST_INTERVAL_MS) {
        ctx.lastPersistedHeartbeatAt.set(clientId, after);
        ctx.wal.persist(ctx.state);
      }
    });
    return c.json({ success: true });
  });
}
