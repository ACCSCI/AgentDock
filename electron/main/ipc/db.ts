/**
 * DB IPC handlers — direct Drizzle queries against the project's SQLite.
 *
 * Single-instance architecture: no daemon, no SSE, no v2 service.
 * Session discovery is simple: scan disk worktrees, check DB, insert if missing.
 */
import { eq, asc } from "drizzle-orm";
import { ipcMain } from "electron";
import { nanoid } from "nanoid";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { IPC_CHANNELS } from "../../shared/api-types.js";
import * as schema from "../../../plugins/db/schema.js";
import {
  ensureActiveDb,
  getActiveDb,
} from "../../../plugins/db/index.js";
import { validateProjectPath } from "../../../plugins/path-validation.js";
import {
  removeWorktree,
  scanDiskWorktrees,
} from "../../../plugins/worktree.js";
import { log } from "../../../plugins/logger.js";

export interface DbContext {
  getProjectPath: () => string | null;
  setProjectPath: (path: string) => void;
  /** Global projects DB (machine-level, not per-project). */
  getGlobalDb: () => import("../../../plugins/db/index.js").DrizzleDb | null;
  /** Session manager for checking creation status. */
  getSessionManager?: () => import("../session-manager.js").SessionManager | null;
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
 * Check if a worktree directory is "complete" (exists, has .git, non-empty).
 */
function isDirectoryComplete(dirPath: string): boolean {
  try {
    return existsSync(dirPath)
      && existsSync(join(dirPath, ".git"))
      && readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

/**
 * Full project sync — simple single-instance logic:
 *   1. Scan disk worktrees
 *   2. For each: if not in DB and directory is complete, insert DB record
 *   3. Remove stale DB rows (worktree gone from disk)
 *   4. Reset stale backgroundHookStatus
 */
export async function syncProject(
  projectPath: string,
  ctx: DbContext,
  force = false,
): Promise<void> {
  const last = lastScanAt.get(projectPath) ?? 0;
  if (!force && Date.now() - last < SCAN_THROTTLE_MS) return;
  lastScanAt.set(projectPath, Date.now());

  const db = ensureActiveDb(projectPath);
  const sessionManager = ctx.getSessionManager?.();

  // 1. Project lookup from global DB (with path normalization)
  const globalDb = ctx.getGlobalDb();
  const normalizedPath = projectPath
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/^([A-Z]):/i, (_, d: string) => d.toLowerCase() + ":");

  let project = globalDb
    ? globalDb
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.path, projectPath))
      .get()
    : undefined;

  // If not found with exact path, try fuzzy match
  if (!project && globalDb) {
    const allProjects = globalDb
      .select({ id: schema.projects.id, path: schema.projects.path, name: schema.projects.name, createdAt: schema.projects.createdAt })
      .from(schema.projects)
      .all();
    project = allProjects.find((p) => {
      const pNorm = p.path
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .replace(/^([A-Z]):/i, (_, d: string) => d.toLowerCase() + ":");
      return pNorm === normalizedPath;
    });
  }

  log.info(
    { projectPath, normalizedPath, found: !!project, projectId: project?.id },
    "syncProject: project lookup",
  );

  // Auto-register project if missing
  if (!project && globalDb) {
    const name = projectPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || projectPath;

    // Register new project in global DB
    try {
      const id = nanoid(8);
      globalDb.insert(schema.projects).values({ id, name, path: projectPath }).run();
      project = globalDb
        .select()
        .from(schema.projects)
        .where(eq(schema.projects.id, id))
        .get();
      log.warn(
        { projectPath, id },
        "syncProject: auto-registered project in global DB",
      );
    } catch (err) {
      log.error(
        { err, projectPath },
        "syncProject: auto-register failed; aborting sync",
      );
      return;
    }
  }
  if (!project) return;

  // 2. Single-DB architecture: project_id migration removed
  // Each session keeps its original project_id from when it was created

  // 3. Scan disk worktrees
  let disk: ReturnType<typeof scanDiskWorktrees> = [];
  try {
    disk = scanDiskWorktrees(projectPath);
  } catch (err) {
    log.warn({ err, projectPath }, "syncProject: scanDiskWorktrees failed");
  }
  const diskWtIds = new Set(disk.map((w) => w.sessionId));

  log.info(
    { projectPath, diskCount: disk.length, diskIds: [...diskWtIds] },
    "syncProject: disk worktrees",
  );

  // 4. Existing DB rows for this project
  const existingRows = db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.projectId, project.id))
    .all();
  const existingIds = new Set(existingRows.map((r) => r.id));
  const existingPaths = new Set(existingRows.map((r) => r.worktreePath));

  log.info(
    { projectPath, projectId: project.id, existingCount: existingRows.length, existingIds: [...existingIds] },
    "syncProject: existing sessions",
  );

  // 5. Insert discovered worktrees not yet in DB
  for (const wt of disk) {
    if (existingIds.has(wt.sessionId) || existingPaths.has(wt.worktreePath)) continue;

    // Worktree exists on disk + directory is complete → insert DB record
    // But skip if session is still being created in SessionManager
    const dirComplete = isDirectoryComplete(wt.worktreePath);
    const sessionInProgress = sessionManager?.getSession(wt.sessionId);
    if (dirComplete && !sessionInProgress) {
      try {
        db.insert(schema.sessions)
          .values({
            id: wt.sessionId,
            projectId: project.id,
            name: wt.sessionId,
            branch: wt.branch,
            worktreePath: wt.worktreePath,
            backgroundHookStatus: null,
          })
          .run();
        log.info(
          { sessionId: wt.sessionId, projectPath },
          "syncProject: inserted discovered worktree",
        );
      } catch (err) {
        log.warn({ err, sessionId: wt.sessionId }, "syncProject: insert failed");
      }
    } else if (sessionInProgress) {
      log.debug(
        { sessionId: wt.sessionId, status: sessionInProgress.status },
        "syncProject: skipping session still in progress",
      );
    }
    // Incomplete worktrees are not inserted (handled by orphan detection elsewhere)
  }

  // 6. Clean up stale DB sessions (worktree gone from disk)
  // But skip sessions that are still being created in SessionManager
  log.info(
    { projectPath, existingCount: existingRows.length, diskCount: disk.length },
    "syncProject: checking stale sessions",
  );
  for (const row of existingRows) {
    const onDisk = diskWtIds.has(row.id);
    const inProgress = sessionManager?.getSession(row.id);
    log.debug(
      { sessionId: row.id, onDisk, inProgress: !!inProgress, worktreePath: row.worktreePath },
      "syncProject: session check",
    );
    if (onDisk) continue;
    // Skip if session is still being created (check both SessionManager AND DB status)
    if (inProgress) {
      log.debug(
        { sessionId: row.id, status: inProgress.status },
        "syncProject: skipping delete for session still in progress",
      );
      continue;
    }
    // Also skip sessions with status "creating" or "deleting" in DB.
    // SessionManager registration may not have happened yet for brand-new
    // sessions whose lifecycle runs asynchronously via setImmediate.
    if (row.status === "creating" || row.status === "deleting") {
      log.debug(
        { sessionId: row.id, status: row.status },
        "syncProject: skipping delete for session with transitional status",
      );
      continue;
    }
    try {
      db.delete(schema.sessions).where(eq(schema.sessions.id, row.id)).run();
      log.info({ sessionId: row.id, projectPath }, "syncProject: removed stale DB session (worktree gone)");
    } catch (err) {
      log.warn({ err, sessionId: row.id }, "syncProject: delete stale session failed");
    }
  }

  // 7. Reset stale backgroundHookStatus ("running" → null after restart)
  for (const row of existingRows) {
    if (diskWtIds.has(row.id) && row.backgroundHookStatus === "running") {
      db.update(schema.sessions)
        .set({ backgroundHookStatus: null })
        .where(eq(schema.sessions.id, row.id))
        .run();
    }
  }
  // Note: cross-project cleanup removed — existingRows is already filtered by projectId
}

export function registerDb(ctx: DbContext): void {
  ipcMain.handle(IPC_CHANNELS["db:init"], async (_e, body: { projectPath: string }) => {
    if (!body?.projectPath) throw new Error("projectPath required");
    const safePath = validateProjectPath(body.projectPath);
    ctx.setProjectPath(safePath);
    // Single-DB architecture: no need to reset the DB handle when switching projects
    // The database is at a fixed path and shared across all projects
    lastScanAt.clear();
    log.info({ projectPath: safePath }, "db initialized");
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS["db:projects:list"], async () => {
    const db = getDb(ctx);
    const projectPath = ctx.getProjectPath();
    log.info({ projectPath }, "db:projects:list called");
    if (projectPath) {
      await syncProject(projectPath, ctx);
    }
    // Projects live in the global DB; sessions live in the per-project DB.
    const globalDb = ctx.getGlobalDb();
    const allProjects = globalDb
      ? globalDb.select().from(schema.projects).all()
      : [];
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
        userStatus: s.userStatus ?? null,
        lastActivatedAt: s.lastActivatedAt ?? null,
        // Return real status from DB: "creating" | "active" | "deleting" | null
        // null = legacy row without status field
        status: s.status ?? null,
        // Parse steps JSON for frontend consumption
        steps: s.steps ? JSON.parse(s.steps) : null,
      })),
    }));
  });

  ipcMain.handle(IPC_CHANNELS["db:projects:create"], (_e, body: { name: string; path: string }) => {
    if (!body?.name || !body?.path) throw new Error("name and path required");
    const safePath = validateProjectPath(body.path);
    const globalDb = ctx.getGlobalDb();
    if (!globalDb) throw new Error("Global DB not initialized");

    // Check if a project with the same path already exists (normalized comparison)
    const normalizedPath = safePath
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .replace(/^([A-Z]):/i, (_, d: string) => d.toLowerCase() + ":");

    const allProjects = globalDb.select().from(schema.projects).all();
    const existing = allProjects.find((p) => {
      const pNorm = p.path
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .replace(/^([A-Z]):/i, (_, d: string) => d.toLowerCase() + ":");
      return pNorm === normalizedPath;
    });

    if (existing) {
      // Return the existing project instead of creating a duplicate
      log.info({ path: safePath, existingId: existing.id }, "db:projects:create: project already exists");
      return existing;
    }

    const id = nanoid(8);
    globalDb.insert(schema.projects).values({ id, name: body.name, path: safePath }).run();
    return globalDb.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
  });

  ipcMain.handle(IPC_CHANNELS["db:projects:delete"], async (_e, projectId: string) => {
    if (!projectId) throw new Error("projectId required");
    // Project lookup from the global DB.
    const globalDb = ctx.getGlobalDb();
    const project = globalDb
      ? globalDb.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
      : undefined;
    if (!project) return { deleted: 0, sessionIds: [], failed: [] };
    // Sessions from the per-project DB.
    const db = getDb(ctx);
    const sessionsForProject = db
      .select().from(schema.sessions).where(eq(schema.sessions.projectId, projectId)).all();
    const failed: Array<{ sessionId: string; stage: string; error: string }> = [];
    for (const s of sessionsForProject) {
      try {
        await removeWorktree(project.path, s.id, { currentBranch: s.branch, force: true });
      } catch (err) {
        log.warn({ err, sessionId: s.id }, "db:projects:delete removeWorktree failed");
        failed.push({ sessionId: s.id, stage: "removeWorktree", error: err instanceof Error ? err.message : String(err) });
      }
    }
    db.delete(schema.sessions).where(eq(schema.sessions.projectId, projectId)).run();
    // Project record is in the global DB.
    globalDb?.delete(schema.projects).where(eq(schema.projects.id, projectId)).run();
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
    await syncProject(projectPath, ctx, true);
    const db = getActiveDb();
    if (!db) return { synced: 0 };
    return { synced: db.select().from(schema.sessions).all().length };
  });
}
