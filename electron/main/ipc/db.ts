/**
 * DB IPC handlers — direct Drizzle queries against the project's SQLite.
 *
 * These run in the main process (Node + node:sqlite) and serve the
 * renderer's CRUD needs. The same DB is also read by the daemon for
 * session operations, but session-related writes go through the daemon
 * (so port allocation stays consistent). Project + worktree metadata
 * (which doesn't need port coordination) lives in this module.
 *
 * `db:projects:list` mirrors origin/master `GET /api/projects` — it does
 * a full disk-to-DB sync on every call (throttled to 5 s per project):
 *   1. scanDiskWorktrees → discover worktree dirs missing from DB
 *   2. declareDiscoveredSession → tell daemon → get allocated ports
 *   3. Clean up stale DB rows (worktree gone from disk)
 *   4. Reset stale backgroundHookStatus
 */
import { eq, asc } from "drizzle-orm";
import { ipcMain } from "electron";
import { nanoid } from "nanoid";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { IPC_CHANNELS } from "../../shared/api-types.js";
import * as schema from "../../../plugins/db/schema.js";
import {
  ensureActiveDb,
  getActiveDb,
  resetActiveDb,
} from "../../../plugins/db/index.js";
import { validateProjectPath } from "../../../plugins/path-validation.js";
import {
  removeWorktree,
  scanDiskWorktrees,
} from "../../../plugins/worktree.js";
import { writePortsToEnv } from "../../../plugins/port-write-env.js";
import { log } from "../../../plugins/logger.js";
import type { DaemonHonoClient } from "../hono-client.js";

export interface DbContext {
  getProjectPath: () => string | null;
  setProjectPath: (path: string) => void;
  getDaemonClient: () => DaemonHonoClient | null;
  getClientId: () => string;
  /** Foreign-session tracking — mirrors master's _sessionStatuses. */
  getSessionStatus: (sessionId: string) => string;
  setSessionStatus: (sessionId: string, status: string) => void;
  clearSessionStatuses: () => void;
}

let dbBindingBroken = false;
let dbBindingError: string | null = null;

const lastScanAt = new Map<string, number>();
const SCAN_THROTTLE_MS = 5_000;

function getDb(ctx: DbContext) {
  if (dbBindingBroken) {
    throw new Error(
      `node:sqlite unavailable. ${dbBindingError ?? "Built-in SQLite module failed to load."} ` +
        `Make sure NODE_OPTIONS=--experimental-sqlite is set when launching Electron (Node 22.x in Electron 42 still gates the module behind a flag).`,
    );
  }
  const projectPath = ctx.getProjectPath();
  if (!projectPath) {
    throw new Error("DB not initialized: call db:init with a projectPath first");
  }
  try {
    return ensureActiveDb(projectPath);
  } catch (err) {
    dbBindingBroken = true;
    dbBindingError = err instanceof Error ? err.message : String(err);
    throw new Error(`node:sqlite unavailable: ${dbBindingError}`);
  }
}

/**
 * Full project sync — mirrors origin/master `GET /api/projects` side-effects.
 * Reconciles disk worktrees ↔ DB ↔ daemon port state.
 */
async function syncProject(
  projectPath: string,
  daemonClient: DaemonHonoClient | null,
  force = false,
): Promise<void> {
  const last = lastScanAt.get(projectPath) ?? 0;
  if (!force && Date.now() - last < SCAN_THROTTLE_MS) return;
  lastScanAt.set(projectPath, Date.now());

  const db = ensureActiveDb(projectPath);

  // 1. Fetch all known sessions from daemon.
  const daemonSessions = new Map<string, { ports: Record<string, number>; worktreePath: string }>();
  if (daemonClient) {
    try {
      const res = await daemonClient.sessions.list.$get();
      if (res.ok) {
        const body = (await res.json()) as {
          sessions: Array<{ sessionId: string; ports: Record<string, number>; worktreePath: string }>;
        };
        for (const s of body.sessions) {
          daemonSessions.set(s.sessionId, { ports: s.ports, worktreePath: s.worktreePath });
        }
      }
    } catch (err) {
      log.warn({ err, projectPath }, "syncProject: daemon /sessions/list failed");
    }
  }

  // 2. Per-project sync (caller passes one project at a time).
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.path, projectPath))
    .get();
  if (!project) return;

  // (a) Daemon ports → DB for existing rows.
  syncProjectPortsToDb(db, project.id, daemonSessions);

  // (b) Scan disk worktrees.
  let disk: ReturnType<typeof scanDiskWorktrees> = [];
  try {
    disk = scanDiskWorktrees(projectPath);
  } catch (err) {
    log.warn({ err, projectPath }, "syncProject: scanDiskWorktrees failed");
  }
  const diskWtIds = new Set(disk.map((w) => w.sessionId));

  // (c)(d) Auto-insert discovered worktrees not yet in DB.
  const existingRows = db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.projectId, project.id))
    .all();
  const existingIds = new Set(existingRows.map((r) => r.id));

  for (const wt of disk) {
    if (existingIds.has(wt.sessionId)) continue;

    // Declare to daemon — it may already know this session's ports.
    let daemonResult: { ports: Record<string, number>; status: string } | null = null;
    if (daemonClient) {
      try {
        const declareRes = await daemonClient.sync.declare.$post({
          json: {
            clientId: "auto-discover",
            sessions: [{ sessionId: wt.sessionId, worktreePath: wt.worktreePath, projectPath }],
          },
        });
        if (declareRes.ok) {
          const body = (await declareRes.json()) as {
            results: Array<{ sessionId: string; ports: Record<string, number>; status: string }>;
          };
          daemonResult = body.results.find((r) => r.sessionId === wt.sessionId) ?? null;
        }
      } catch (err) {
        log.warn({ err, sessionId: wt.sessionId }, "syncProject: declareDiscoveredSession failed");
      }
    }

    try {
      db.insert(schema.sessions)
        .values({
          id: wt.sessionId,
          projectId: project.id,
          name: wt.sessionId,
          branch: wt.branch,
          worktreePath: wt.worktreePath,
          ports: daemonResult?.ports ? JSON.stringify(daemonResult.ports) : null,
          backgroundHookStatus: null,
        })
        .run();
      // Track the runtime ownership status from the daemon's declare response.
      const status = daemonResult?.status ?? "orphan";
      ctx.setSessionStatus(wt.sessionId, status);
      if (daemonResult?.ports && wt.worktreePath && existsSync(wt.worktreePath)) {
        writePortsToEnv(wt.worktreePath, daemonResult.ports, projectPath);
      }
      log.info(
        { sessionId: wt.sessionId, projectPath, status },
        "syncProject: declared disk worktree",
      );
    } catch (err) {
      log.warn({ err, sessionId: wt.sessionId }, "syncProject: insert failed");
    }
  }

  // (e) Reconcile ports again — catch any newly inserted rows.
  syncProjectPortsToDb(db, project.id, daemonSessions);

  // (f) Clean up stale DB sessions (worktree gone from disk).
  for (const row of existingRows) {
    if (diskWtIds.has(row.id)) continue;
    if (daemonClient) {
      try {
        await daemonClient.sessions.release.$post({
          json: { clientId: "auto-discover", sessionId: row.id },
        });
      } catch (err) {
        log.warn({ err, sessionId: row.id }, "syncProject: release stale session failed");
      }
    }
    try {
      db.delete(schema.sessions).where(eq(schema.sessions.id, row.id)).run();
      log.info({ sessionId: row.id, projectPath }, "syncProject: removed stale DB session (worktree gone)");
    } catch (err) {
      log.warn({ err, sessionId: row.id }, "syncProject: delete stale session failed");
    }
  }

  // (g) Reset stale backgroundHookStatus ("running" → null after restart).
  for (const row of existingRows) {
    if (diskWtIds.has(row.id) && row.backgroundHookStatus === "running") {
      db.update(schema.sessions)
        .set({ backgroundHookStatus: null })
        .where(eq(schema.sessions.id, row.id))
        .run();
    }
  }
}

function syncProjectPortsToDb(
  db: ReturnType<typeof ensureActiveDb>,
  projectId: string,
  daemonSessions: Map<string, { ports: Record<string, number>; worktreePath: string }>,
): void {
  const rows = db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.projectId, projectId))
    .all();
  for (const row of rows) {
    const ds = daemonSessions.get(row.id);
    if (!ds) continue;
    const wantPorts = JSON.stringify(ds.ports);
    if (row.ports === wantPorts) continue;
    db.update(schema.sessions).set({ ports: wantPorts }).where(eq(schema.sessions.id, row.id)).run();
    if (ds.worktreePath && existsSync(ds.worktreePath)) {
      try { writePortsToEnv(ds.worktreePath, ds.ports); } catch (err) {
        log.warn({ err, sessionId: row.id }, "syncProject: writePortsToEnv failed");
      }
    }
  }
}

export function registerDb(ctx: DbContext): void {
  ipcMain.handle(IPC_CHANNELS["db:init"], async (_e, body: { projectPath: string }) => {
    if (!body?.projectPath) throw new Error("projectPath required");
    const safePath = validateProjectPath(body.projectPath);
    ctx.setProjectPath(safePath);
    resetActiveDb();
    lastScanAt.clear();
    ctx.clearSessionStatuses();
    log.info({ projectPath: safePath }, "db initialized");
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS["db:projects:list"], async () => {
    const db = getDb(ctx);
    const projectPath = ctx.getProjectPath();
    if (projectPath) {
      await syncProject(projectPath, ctx.getDaemonClient());
    }
    const allProjects = db.select().from(schema.projects).all();
    const sessionRows = db
      .select()
      .from(schema.sessions)
      .orderBy(asc(schema.sessions.sortOrder))
      .all();
    return allProjects.map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      createdAt: p.createdAt,
      sessions: sessionRows.filter((s) => s.projectId === p.id).map((s) => ({
        id: s.id,
        projectId: s.projectId,
        name: s.name,
        branch: s.branch,
        worktreePath: s.worktreePath,
        ports: s.ports ? JSON.parse(s.ports) : null,
        backgroundHookStatus: s.backgroundHookStatus ?? null,
        createdAt: s.createdAt,
        runtimeStatus: ctx.getSessionStatus(s.id),
      })),
    }));
  });

  ipcMain.handle(IPC_CHANNELS["db:projects:create"], (_e, body: { name: string; path: string }) => {
    if (!body?.name || !body?.path) throw new Error("name and path required");
    const db = getDb(ctx);
    const safePath = validateProjectPath(body.path);
    const id = nanoid(8);
    db.insert(schema.projects).values({ id, name: body.name, path: safePath }).run();
    return db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
  });

  ipcMain.handle(IPC_CHANNELS["db:projects:delete"], async (_e, projectId: string) => {
    if (!projectId) throw new Error("projectId required");
    const db = getDb(ctx);
    const project = db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get();
    if (!project) return { deleted: 0, sessionIds: [], failed: [] };
    const sessionsForProject = db
      .select().from(schema.sessions).where(eq(schema.sessions.projectId, projectId)).all();
    const daemonClient = ctx.getDaemonClient();
    const clientId = ctx.getClientId();
    const failed: Array<{ sessionId: string; stage: string; error: string }> = [];
    for (const s of sessionsForProject) {
      if (daemonClient) {
        try {
          await daemonClient.sessions.release.$post({ json: { clientId, sessionId: s.id } });
        } catch (err) {
          log.warn({ err, sessionId: s.id }, "db:projects:delete daemon release failed");
          failed.push({ sessionId: s.id, stage: "daemon-release", error: err instanceof Error ? err.message : String(err) });
        }
      }
      try {
        await removeWorktree(project.path, s.id, { currentBranch: s.branch, force: true });
      } catch (err) {
        log.warn({ err, sessionId: s.id }, "db:projects:delete removeWorktree failed");
        failed.push({ sessionId: s.id, stage: "removeWorktree", error: err instanceof Error ? err.message : String(err) });
      }
    }
    db.delete(schema.sessions).where(eq(schema.sessions.projectId, projectId)).run();
    db.delete(schema.projects).where(eq(schema.projects.id, projectId)).run();
    return { deleted: sessionsForProject.length, sessionIds: sessionsForProject.map((s) => s.id), failed };
  });

  ipcMain.handle(IPC_CHANNELS["db:sessions:reorder"], (_e, body: { projectId: string; sessionIds: string[] }) => {
    if (!body?.projectId || !Array.isArray(body.sessionIds)) throw new Error("projectId and sessionIds[] required");
    const db = getDb(ctx);
    db.transaction((tx) => {
      body.sessionIds.forEach((id, idx) => {
        tx.update(schema.sessions).set({ sortOrder: idx }).where(eq(schema.sessions.id, id)).run();
      });
    });
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS["sync:project"], async () => {
    const projectPath = ctx.getProjectPath();
    if (!projectPath) throw new Error("db:init must be called first");
    getDb(ctx);
    await syncProject(projectPath, ctx.getDaemonClient(), true);
    const db = getActiveDb();
    if (!db) return { synced: 0 };
    return { synced: db.select().from(schema.sessions).all().length };
  });
}
