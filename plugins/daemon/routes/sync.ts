/**
 * Sync/declare route — bulk session synchronization.
 *
 *   POST /sync/declare { clientId, sessions: [...] }
 *     → {
 *         success: true,
 *         results: [{ sessionId, ports, status }, ...],
 *         orphans: [sessionId, ...]
 *       }
 *
 * This is the most complex route. For each declared session we either:
 *   - return "existing"   if it matches and ports are still bindable
 *   - return "reallocated" if it matches but ports are taken → reallocate
 *   - return "reclaimed"  if previous owner was stale → take ownership
 *   - return "foreign"    if another live client owns it (no change)
 *   - return "conflict"   if worktreePath claimed by different sessionId
 *   - return "allocated"  if new — use provided ports if bindable, else allocate
 *
 * Orphans: sessions in state but not declared and whose owner client no
 * longer exists. Clients use this to clean up after restarts.
 */
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import path from "node:path";
import { z } from "zod";
import { isPortAvailable } from "../../port-allocator.js";
import { PORT_KEYS_DEFAULT } from "../../config.js";
import {
  HEARTBEAT_TIMEOUT_MS,
  type DaemonContext,
} from "../context.js";
import { zodErrorHandler } from "../middleware/error.js";

const SESSION_ID_RE = /^[a-zA-Z0-9-_]+$/;

const DeclareSchema = z.object({
  clientId: z.string().min(1, "clientId required"),
  // Empty array is valid — declare with no sessions means "I have no sessions
  // right now, please clean up orphans if any." Original daemon behavior was
  // an empty sessions loop returning empty results.
  sessions: z
    .array(
      z.object({
        sessionId: z.string().min(1),
        worktreePath: z.string().min(1),
        projectPath: z.string().min(1),
        ports: z.record(z.string(), z.number()).nullable().optional(),
        portKeys: z.array(z.string()).optional(),
      }),
    )
    .default([]),
});

interface DeclareResult {
  sessionId: string;
  ports: Record<string, number>;
  status: string;
}

export function registerSync(app: Hono, ctx: DaemonContext): void {
  app.post(
    "/sync/declare",
    zValidator("json", DeclareSchema, zodErrorHandler),
    async (c) => {
      const { clientId, sessions: declaredSessions } = c.req.valid("json");

      try {
        const syncResult = await ctx.mutex.runExclusive("state", async () => {
          const results: DeclareResult[] = [];

          for (const decl of declaredSessions) {
            // Per-session validation (zod validated the shape, but regex
            // and absolute path checks happen here so a single bad entry
            // doesn't reject the whole batch).
            if (
              !decl.sessionId ||
              !decl.worktreePath ||
              !decl.projectPath ||
              !SESSION_ID_RE.test(decl.sessionId) ||
              !path.isAbsolute(decl.worktreePath)
            ) {
              results.push({
                sessionId: decl.sessionId ?? "",
                ports: {},
                status: "error",
              });
              continue;
            }

            const normalizedWtPath = path.resolve(decl.worktreePath);
            const normalizedProjPath = path.resolve(decl.projectPath);

            const existing = ctx.state.getSession(decl.sessionId);
            if (existing) {
              const ownership = ctx.state.getSessionOwnership(
                decl.sessionId,
                clientId,
                Date.now(),
                HEARTBEAT_TIMEOUT_MS,
              );

              if (ownership === "owned") {
                ctx.state.claimSession(
                  decl.sessionId,
                  clientId,
                  ctx.state.getClient(clientId)?.pid ?? existing.ownerPid,
                );

                // Check if the session's ports are still bindable. If not,
                // reallocate and report "reallocated" so the client knows
                // to update .env and notify the user.
                const portKeys = Object.keys(existing.ports);
                const portsStillAvailable = await Promise.all(
                  portKeys.map((key) => isPortAvailable(existing.ports[key])),
                ).then((rs) => rs.every(Boolean));

                if (!portsStillAvailable) {
                  const excluded = ctx.state.getExcludedPorts();
                  for (const key of portKeys) excluded.add(existing.ports[key]);
                  const allocated = await ctx.state.allocatePorts(
                    portKeys.length,
                    excluded,
                  );
                  const newPorts: Record<string, number> = {};
                  portKeys.forEach((key, i) => {
                    newPorts[key] = allocated[i];
                  });
                  ctx.state.reassignSession(decl.sessionId, newPorts);
                  ctx.wal.persist(ctx.state);
                  results.push({
                    sessionId: decl.sessionId,
                    ports: newPorts,
                    status: "reallocated",
                  });
                } else {
                  results.push({
                    sessionId: decl.sessionId,
                    ports: existing.ports,
                    status: "existing",
                  });
                }
                continue;
              }

              if (ownership === "reclaimable") {
                ctx.state.claimSession(
                  decl.sessionId,
                  clientId,
                  ctx.state.getClient(clientId)?.pid ?? existing.ownerPid,
                );
                results.push({
                  sessionId: decl.sessionId,
                  ports: existing.ports,
                  status: "reclaimed",
                });
                continue;
              }

              results.push({
                sessionId: decl.sessionId,
                ports: existing.ports,
                status: "foreign",
              });
              continue;
            }

            // New session.
            const duplicate = ctx.state.findDuplicate(normalizedWtPath);
            if (duplicate) {
              results.push({
                sessionId: decl.sessionId,
                ports: ctx.state.getSession(duplicate)!.ports,
                status: "conflict",
              });
              continue;
            }

            const rawKeys = Array.isArray(decl.portKeys) ? decl.portKeys : [];
            const dedupedKeys = [...new Set(rawKeys)].filter((k) => k.trim().length > 0);
            const keys = dedupedKeys.length > 0 ? dedupedKeys : Object.keys(decl.ports ?? {});
            const effectiveKeys = keys.length > 0 ? keys : [...PORT_KEYS_DEFAULT];

            const hasAllPorts =
              !!decl.ports &&
              effectiveKeys.every((key) => typeof decl.ports![key] === "number");
            const providedPortsAreBindable = hasAllPorts
              ? (
                  await Promise.all(
                    effectiveKeys.map((key) => isPortAvailable(decl.ports![key])),
                  )
                ).every(Boolean)
              : false;
            const needsRealloc =
              !hasAllPorts ||
              !providedPortsAreBindable ||
              effectiveKeys.some((key) => ctx.state.isPortAllocated(decl.ports![key]));

            let ports: Record<string, number>;
            if (hasAllPorts && !needsRealloc) {
              ports = decl.ports!;
            } else {
              const excluded = ctx.state.getExcludedPorts();
              if (hasAllPorts) {
                for (const key of effectiveKeys) excluded.add(decl.ports![key]);
              }
              const allocated = await ctx.state.allocatePorts(
                effectiveKeys.length,
                excluded,
              );
              ports = {};
              effectiveKeys.forEach((key, i) => {
                ports[key] = allocated[i];
              });
            }

            ctx.state.allocateSession({
              sessionId: decl.sessionId,
              worktreePath: normalizedWtPath,
              projectPath: normalizedProjPath,
              ports,
              ownerClientId: clientId,
              ownerPid: ctx.state.getClient(clientId)?.pid ?? 0,
            });
            results.push({ sessionId: decl.sessionId, ports, status: "allocated" });
          }

          // Orphan detection: declaredIds excludes anything the current client
          // already owns. Anything left in state with a non-existent owner
          // client is an orphan.
          const declaredIds = new Set(declaredSessions.map((s) => s.sessionId));
          const orphans: string[] = [];
          for (const session of ctx.state.listSessions()) {
            if (!declaredIds.has(session.sessionId) && session.ownerClientId !== clientId) {
              const owner = ctx.state.getClient(session.ownerClientId);
              if (!owner) {
                orphans.push(session.sessionId);
              }
            }
          }

          ctx.wal.persist(ctx.state);
          return { results, orphans };
        });

        return c.json({ success: true, ...syncResult });
      } catch (err) {
        return c.json(
          { success: false, error: err instanceof Error ? err.message : "Unknown error" },
          500,
        );
      }
    },
  );
}