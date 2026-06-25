/**
 * reconcile — Walk every session in the active project's DB and compare its
 * ports against the daemon's v2 state. If the daemon's ports differ from
 * what the DB has (e.g. an external process reclaimed them between
 * shutdowns), persist the new ports, rewrite the worktree `.env`,
 * and stash an entry in `reallocatedQueue` for the renderer's
 * `bootstrap:reallocated` IPC to pick up.
 *
 * v2 replaces the v1 `/sync/declare` endpoint with the `/sync` snapshot
 * + SSE. This reconciliation runs once per boot, after daemon connect
 * + register. Quietly no-ops when the DB doesn't exist yet (fresh
 * install) or when v2 is not available.
 *
 * Extracted from main.ts (Approach A: state stays in main.ts, passed as params).
 */
import { eq } from "drizzle-orm";
import process from "node:process";
import { log } from "../../plugins/logger.js";
import { ensureActiveDb } from "../../plugins/db/index.js";
import * as schema from "../../plugins/db/schema.js";
import type { V2PortServiceHandle } from "../../plugins/v2-port-service.js";
import { writePortsToEnv } from "../../plugins/port-write-env.js";

export interface ReconcileContext {
  activeProjectPath: string | null;
  v2PortService: V2PortServiceHandle | null;
  cachedDaemonPort: number;
  globalDbHandle: { db: ReturnType<typeof import("../../plugins/db/global.js").openGlobalDb> extends { db: infer T } ? T : never } | null;
  reallocatedQueue: Array<{
    sessionId: string;
    oldPorts: Record<string, number>;
    newPorts: Record<string, number>;
  }>;
  clientId: string;
}

export async function reconcileAndDeclareSessions(
  ctx: ReconcileContext,
): Promise<void> {
  if (!ctx.activeProjectPath) return;
  if (!ctx.v2PortService || ctx.cachedDaemonPort <= 0) {
    log.info("reconcile: v2 not available, skipping (v1 routes removed in F10-2a)");
    return;
  }
  let db: ReturnType<typeof ensureActiveDb>;
  try {
    db = ensureActiveDb(ctx.activeProjectPath);
  } catch (err) {
    log.warn({ err }, "reconcile: DB unavailable, skipping");
    return;
  }

  let rows: Array<{
    id: string;
    projectId: string;
    worktreePath: string;
    ports: string | null;
  }>;
  try {
    rows = db
      .select({
        id: schema.sessions.id,
        projectId: schema.sessions.projectId,
        worktreePath: schema.sessions.worktreePath,
        ports: schema.sessions.ports,
      })
      .from(schema.sessions)
      .all();
  } catch (err) {
    log.warn({ err }, "reconcile: failed to read sessions");
    return;
  }
  if (rows.length === 0) return;

  const rowsBySessionId = new Map(rows.map((r) => [r.id, r]));

  // Build a set of sessionIds known to the v2PortService's local cache,
  // so we can match daemon sessions to DB rows by unified sessionId.
  const knownBySid = new Map<string, { sessionId: string }>();
  for (const known of ctx.v2PortService.listKnownSessions()) {
    knownBySid.set(known.sessionId, { sessionId: known.sessionId });
  }

  // Fetch daemon state via v2 /sync (raw fetch — matches the pattern
  // used by db.ts and v2-port-service.ts).
  let daemonSessions: Array<{
    sessionId: string;
    projectRoot: string;
    displayName: string;
    status: string;
    ports: Record<string, number>;
  }> = [];
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.cachedDaemonPort}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: ctx.clientId, pid: process.pid, lastSeq: 0 }),
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "reconcile: v2 /sync non-2xx");
      return;
    }
    const body = (await res.json()) as {
      sessions?: typeof daemonSessions;
    };
    daemonSessions = body?.sessions ?? [];
  } catch (err) {
    log.warn({ err }, "reconcile: v2 /sync failed");
    return;
  }

  for (const ds of daemonSessions) {
    // Match daemon session → DB row by unified sessionId.
    // If we don't have a local mapping for this sessionId, skip
    // (it belongs to another Electron instance).
    const known = knownBySid.get(ds.sessionId);
    if (!known) continue;
    const row = rowsBySessionId.get(known.sessionId);
    if (!row) continue;
    if (ds.status !== "active") continue; // Only reconcile active sessions.
    const oldPorts = row.ports
      ? (JSON.parse(row.ports) as Record<string, number>)
      : {};
    const newPorts = ds.ports;
    const keys1 = Object.keys(oldPorts);
    const keys2 = Object.keys(newPorts);
    const portsEqual = keys1.length === keys2.length && keys1.every((k) => oldPorts[k] === newPorts[k]);
    if (portsEqual) continue;

    ctx.reallocatedQueue.push({
      sessionId: row.id,
      oldPorts,
      newPorts,
    });
    try {
      const project = ctx.globalDbHandle?.db
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, row.projectId))
        .get();
      db.update(schema.sessions)
        .set({ ports: JSON.stringify(newPorts) })
        .where(eq(schema.sessions.id, row.id))
        .run();
      if (project) {
        writePortsToEnv(row.worktreePath, newPorts, project.path);
      }
    } catch (err) {
      log.warn(
        { err, sessionId: row.id },
        "reconcile: persist reallocated ports failed",
      );
    }
  }
}
