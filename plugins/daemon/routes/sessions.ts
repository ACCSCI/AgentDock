/**
 * Session lifecycle routes.
 *
 *   POST /sessions/allocate { clientId, sessionId, projectPath, worktreePath, portKeys? }
 *   POST /sessions/release  { clientId, sessionId }
 *   POST /sessions/reassign { clientId, sessionId }
 *   GET  /sessions/list
 *
 * Mutates DaemonState (sessions + ports) under the "state" mutex. Each
 * successful mutation calls ctx.wal.persist() so a daemon restart can
 * recover in-flight sessions.
 *
 * Status semantics (unchanged from the original daemon.ts):
 *   - "existing":   sessionId already known, return current ports
 *   - "allocated":  newly allocated this request
 *   - "conflict":   worktreePath already claimed by another session → 409
 *   - "foreign":    another live client owns this session → 403 (on reassign)
 *   - "reclaimed":  previous owner was stale, current client took over (reassign)
 *   - "reassigned": current client already owned, just got new ports
 *   - "missing":    sessionId not in state → 404
 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import path from "node:path";
import { z } from "zod";
import { PORT_KEYS_DEFAULT } from "../../config.js";
import {
  HEARTBEAT_TIMEOUT_MS,
  type DaemonContext,
} from "../context.js";
import { zodErrorHandler } from "../middleware/error.js";

const SESSION_ID_RE = /^[a-zA-Z0-9-_]+$/;

const AllocateSchema = z.object({
  clientId: z.string().min(1, "clientId required"),
  sessionId: z
    .string()
    .min(1)
    .regex(SESSION_ID_RE, "Invalid sessionId: only alphanumeric, dash, underscore allowed"),
  projectPath: z.string().min(1, "projectPath required"),
  worktreePath: z
    .string()
    .min(1)
    .refine((p) => path.isAbsolute(p), { message: "worktreePath must be absolute" }),
  portKeys: z.array(z.string()).optional(),
});

const ReleaseSchema = z.object({
  clientId: z.string().min(1, "clientId required"),
  sessionId: z.string().min(1, "sessionId required"),
});

const ReassignSchema = z.object({
  clientId: z.string().min(1, "clientId required"),
  sessionId: z.string().min(1, "sessionId required"),
});

export function registerSessions(app: Hono, ctx: DaemonContext): void {
  app.post(
    "/sessions/allocate",
    zValidator("json", AllocateSchema, zodErrorHandler),
    async (c) => {
      const body = c.req.valid("json");
      const normalizedWorktreePath = path.resolve(body.worktreePath);
      const normalizedProjectPath = path.resolve(body.projectPath);

      try {
        const result = await ctx.mutex.runExclusive("state", async () => {
          // Idempotent: if sessionId already known, return existing ports.
          const existing = ctx.state.getSession(body.sessionId);
          if (existing) {
            return { ports: existing.ports, status: "existing" as const };
          }

          // Reject duplicate worktreePath even if sessionId is new.
          const duplicate = ctx.state.findDuplicate(normalizedWorktreePath);
          if (duplicate) {
            return {
              error: `duplicate_worktree: worktreePath already claimed by session ${duplicate}`,
              status: "conflict" as const,
            };
          }

          // Decide which port keys to allocate. Explicit list wins; otherwise
          // PORT_KEYS_DEFAULT (FRONTEND_PORT, BACKEND_PORT, WS_PORT, etc.).
          const rawKeys = Array.isArray(body.portKeys) ? body.portKeys : [];
          const keys = [...new Set(rawKeys)].filter((k) => k.trim().length > 0);
          const finalKeys = keys.length > 0 ? keys : [...PORT_KEYS_DEFAULT];

          const excluded = ctx.state.getExcludedPorts();
          const allocated = await ctx.state.allocatePorts(finalKeys.length, excluded);
          const ports: Record<string, number> = {};
          finalKeys.forEach((key, i) => {
            ports[key] = allocated[i];
          });

          ctx.state.allocateSession({
            sessionId: body.sessionId,
            worktreePath: normalizedWorktreePath,
            projectPath: normalizedProjectPath,
            ports,
            ownerClientId: body.clientId,
            ownerPid: ctx.state.getClient(body.clientId)?.pid ?? 0,
          });
          ctx.wal.persist(ctx.state);
          return { ports, status: "allocated" as const };
        });

        if (result.status === "conflict") {
          return c.json({ success: false, error: result.error }, 409);
        }
        return c.json({ success: true, ports: result.ports });
      } catch (err) {
        return c.json(
          { success: false, error: err instanceof Error ? err.message : "Unknown error" },
          500,
        );
      }
    },
  );

  app.post(
    "/sessions/release",
    zValidator("json", ReleaseSchema, zodErrorHandler),
    async (c) => {
      const { clientId, sessionId } = c.req.valid("json");
      const result = await ctx.mutex.runExclusive("state", async () => {
        const ownership = ctx.state.getSessionOwnership(
          sessionId,
          clientId,
          Date.now(),
          HEARTBEAT_TIMEOUT_MS,
        );
        if (ownership === "missing") return { status: "missing" as const };
        if (ownership === "foreign") return { status: "forbidden" as const };

        ctx.state.releaseSession(sessionId);
        ctx.wal.persist(ctx.state);
        return { status: "released" as const };
      });

      if (result.status === "missing") {
        return c.json(
          { success: false, error: `Session ${sessionId} not found` },
          404,
        );
      }
      if (result.status === "forbidden") {
        return c.json(
          { success: false, error: `Session ${sessionId} is owned by another client` },
          403,
        );
      }
      return c.json({ success: true });
    },
  );

  app.post(
    "/sessions/reassign",
    zValidator("json", ReassignSchema, zodErrorHandler),
    async (c) => {
      const { clientId, sessionId } = c.req.valid("json");
      try {
        const result = await ctx.mutex.runExclusive("state", async () => {
          const session = ctx.state.getSession(sessionId);
          if (!session) return { status: "missing" as const };

          const ownership = ctx.state.getSessionOwnership(
            sessionId,
            clientId,
            Date.now(),
            HEARTBEAT_TIMEOUT_MS,
          );
          if (ownership === "foreign") return { status: "forbidden" as const };

          // Excluded set: all currently allocated ports + this session's old
          // ports (so we never hand the same port back).
          const excluded = ctx.state.getExcludedPorts();
          const oldPorts = session.ports;
          const oldKeys = Object.keys(oldPorts);
          for (const key of oldKeys) {
            excluded.add(oldPorts[key]);
          }

          const allocated = await ctx.state.allocatePorts(oldKeys.length, excluded);
          const newPorts: Record<string, number> = {};
          oldKeys.forEach((key, i) => {
            newPorts[key] = allocated[i];
          });

          if (ownership === "reclaimable") {
            ctx.state.claimSession(
              sessionId,
              clientId,
              ctx.state.getClient(clientId)?.pid ?? session.ownerPid,
            );
          }

          ctx.state.reassignSession(sessionId, newPorts);
          ctx.wal.persist(ctx.state);
          return {
            status: (ownership === "reclaimable" ? "reclaimed" : "reassigned") as
              | "reclaimed"
              | "reassigned",
            ports: newPorts,
          };
        });

        if (result.status === "missing") {
          return c.json(
            { success: false, error: `Session ${sessionId} not found` },
            404,
          );
        }
        if (result.status === "forbidden") {
          return c.json(
            { success: false, error: `Session ${sessionId} is owned by another client` },
            403,
          );
        }
        return c.json({ success: true, ports: result.ports, status: result.status });
      } catch (err) {
        return c.json(
          { success: false, error: err instanceof Error ? err.message : "Unknown error" },
          500,
        );
      }
    },
  );

  app.get("/sessions/list", (c) => {
    const sessions = ctx.state.listSessions().map((s) => ({
      sessionId: s.sessionId,
      worktreePath: s.worktreePath,
      projectPath: s.projectPath,
      ports: s.ports,
      ownerClientId: s.ownerClientId,
    }));
    return c.json({ success: true, sessions });
  });
}