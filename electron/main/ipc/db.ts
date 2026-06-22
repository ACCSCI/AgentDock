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
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
import type { V2PortServiceHandle } from "../../../plugins/v2-port-service.js";
import { PORT_KEYS_DEFAULT } from "../../../plugins/config.js";

export interface DbContext {
  getProjectPath: () => string | null;
  setProjectPath: (path: string) => void;
  getClientId: () => string;
  /** Foreign-session tracking — mirrors master's _sessionStatuses. */
  getSessionStatus: (sessionId: string) => string;
  setSessionStatus: (sessionId: string, status: string) => void;
  clearSessionStatuses: () => void;
  /** P9: v2 service when AGENTDOCK_V2=1, else null. Used for v2 /sync
   *  + releaseSession in place of the removed v1 endpoints. */
  getV2PortService: () => V2PortServiceHandle | null;
  /** P9: daemon port for direct v2 fetch to /sync. 0 if no daemon. */
  getDaemonPort: () => number;
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
 * §4.3.1 — Check if a worktree directory is "complete" (exists, has .git, non-empty).
 * Safe against EACCES/ENOTDIR by catching sync FS errors.
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
 * Fetch all v2 daemon sessions via /sync. Returns a map keyed by
 * worktreePath (so callers can match against DB rows).
 */
async function fetchV2Sessions(
  daemonPort: number,
  clientId: string,
): Promise<Map<string, { sessionId: string; projectRoot: string; ports: Record<string, number>; status: string }>> {
  const out = new Map<string, { sessionId: string; projectRoot: string; ports: Record<string, number>; status: string }>();
  if (daemonPort <= 0) return out;
  try {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, pid: process.pid, lastSeq: 0 }),
    });
    if (!res.ok) return out;
    const body = (await res.json()) as {
      sessions?: Array<{
        sessionId: string;
        projectRoot: string;
        displayName: string;
        status: string;
        ports: Record<string, number>;
      }>;
    };
    for (const s of body?.sessions ?? []) {
      // §4.3.1: 用 worktreePath 做 key（不是 projectRoot），
      // 因为 auto-insert 循环用 wt.worktreePath 做 lookup。
      // worktreePath = <projectRoot>/.agentdock/worktrees/<sessionId>
      const worktreePath = join(s.projectRoot, ".agentdock", "worktrees", s.sessionId);
      out.set(worktreePath, {
        sessionId: s.sessionId,
        projectRoot: s.projectRoot,
        ports: s.ports,
        status: s.status,
      });
    }
  } catch (err) {
    log.warn({ err }, "fetchV2Sessions: v2 /sync failed");
  }
  return out;
}

/**
 * Resolve the worktreePath → ports map for sessions known to the daemon.
 * Combines v2PortService's locally tracked sessions with the /sync
 * snapshot (so disk-worktree auto-discovery still gets ports for
 * sessions that exist on the daemon).
 */
function buildWorktreePorts(
  _v2: V2PortServiceHandle | null,
  v2Snapshot: Map<string, { sessionId: string; projectRoot: string; ports: Record<string, number> }>,
): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  // v2Snapshot 的 key 已经是 worktreePath（由 fetchV2Sessions 设置），
  // 直接用 key 做映射，与 syncProjectPortsToDb 的 row.worktreePath lookup 对齐。
  for (const [worktreePath, ds] of v2Snapshot) {
    out.set(worktreePath, ds.ports);
  }
  return out;
}

/**
 * §4.3.1 — 静默 takeover：无主但磁盘完整的 worktree，自动 claim 成自己的。
 *
 * 流程：
 *   1. 读 worktree/.env → 拿到 preferredPort
 *   2. v2 service allocateSession → daemon 创建新 session + 分配端口
 *   3. 重命名 git 分支 agentdock/<oldId> → agentdock/<newId>
 *   4. 更新本地 DB（删旧行，插新行）
 *   5. 写 .env（用 claim 实际返回的端口）
 *
 * 失败不影响 syncProject 继续执行——fallback 到标 orphan。
 */
async function silentTakeover(
  v2: V2PortServiceHandle,
  wt: { sessionId: string; worktreePath: string; branch: string },
  project: { id: string; path: string },
  db: ReturnType<typeof ensureActiveDb>,
): Promise<{ ports: Record<string, number> }> {
  const sessionId = wt.sessionId;
  const worktreePath = wt.worktreePath;

  // 1. 读 .env 获取 preferredPort（端口变量名 → 端口号）
  let preferredPorts: Record<string, number> = {};
  try {
    const envPath = join(worktreePath, ".env");
    if (existsSync(envPath)) {
      const envContent = readFileSync(envPath, "utf-8");
      for (const line of envContent.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim();
        const n = Number(val);
        if ((PORT_KEYS_DEFAULT as readonly string[]).includes(key) && Number.isFinite(n)) {
          preferredPorts[key] = n;
        }
      }
    }
  } catch (err) {
    log.warn({ err, sessionId }, "takeover: read .env failed");
  }

  // 2. 无条件 reclaim（daemon 有 → 换 owner；没有 → 创建新 session + claim 端口）
  const portKeys: string[] | undefined = Object.keys(preferredPorts).length > 0
    ? Object.keys(preferredPorts)
    : undefined;
  const ports = await v2.service.claimOrReuse({
    sessionId,
    projectPath: project.path,
    portKeys,
    displayName: sessionId,
  });

  log.info({ sessionId, ports }, "takeover: reclaimed in daemon");

  // 3. 更新本地 DB：只更新端口（sessionId 不变，不删不插）
  db.update(schema.sessions)
    .set({ ports: JSON.stringify(ports) })
    .where(eq(schema.sessions.id, sessionId))
    .run();

  // 4. 写 .env（用 claim 实际返回的端口）
  if (existsSync(worktreePath)) {
    writePortsToEnv(worktreePath, ports, project.path);
  }

  return { ports };
}

/**
 * Full project sync — mirrors origin/master `GET /api/projects` side-effects.
 * Reconciles disk worktrees ↔ DB ↔ daemon port state via v2 endpoints.
 */
async function syncProject(
  projectPath: string,
  ctx: DbContext,
  force = false,
): Promise<void> {
  const last = lastScanAt.get(projectPath) ?? 0;
  if (!force && Date.now() - last < SCAN_THROTTLE_MS) return;
  lastScanAt.set(projectPath, Date.now());

  const db = ensureActiveDb(projectPath);

  // 1. Fetch all v2 sessions from daemon /sync, plus locally-known
  //    sessions from v2PortService. The /sync route was added in
  //    P9 §7.3 and returns the full v2 state snapshot.
  const daemonPort = ctx.getDaemonPort();
  const clientId = ctx.getClientId();
  const v2 = ctx.getV2PortService();
  const v2Snapshot = await fetchV2Sessions(daemonPort, clientId);

  // Map worktreePath → ports for sessions known to the daemon.
  const worktreePorts = buildWorktreePorts(v2, v2Snapshot);

  // 2. Per-project sync (caller passes one project at a time).
  const project = db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.path, projectPath))
    .get();
  if (!project) return;

  // (a) Daemon ports → DB for existing rows (by worktreePath).
  syncProjectPortsToDb(db, project.id, worktreePorts);

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
  // §4.3.1: worktreePath → sessionId 的反查集（防止 takeover 后目录名≠sessionId 导致重复 insert）
  const existingPaths = new Set(existingRows.map((r) => r.worktreePath));

  for (const wt of disk) {
    if (existingIds.has(wt.sessionId) || existingPaths.has(wt.worktreePath)) continue;

    // §4.3.1: 判定 takeover / orphan — 看磁盘完整性，不依赖 daemon
    const daemonEntry = v2Snapshot.get(wt.worktreePath);
    const daemonPorts = daemonEntry?.ports ?? null;

    if (daemonEntry) {
      // daemon 认这个 worktree → 正常 insert
      try {
        db.insert(schema.sessions)
          .values({
            id: wt.sessionId,
            projectId: project.id,
            name: wt.sessionId,
            branch: wt.branch,
            worktreePath: wt.worktreePath,
            ports: daemonPorts ? JSON.stringify(daemonPorts) : null,
            backgroundHookStatus: null,
          })
          .run();
        ctx.setSessionStatus(wt.sessionId, daemonEntry.status);
        log.info(
          { sessionId: wt.sessionId, projectPath, status: daemonEntry.status },
          "syncProject: inserted disk worktree (daemon-known)",
        );
      } catch (err) {
        log.warn({ err, sessionId: wt.sessionId }, "syncProject: insert failed");
      }
      continue;
    }

    // daemon 不认 → 看磁盘完整性
    const dirComplete = isDirectoryComplete(wt.worktreePath);

    if (dirComplete && v2) {
      // §4.3.1 takeover：无主 + 完整 → 静默 claim 成自己的
      try {
        const result = await silentTakeover(v2, wt, project, db);
        ctx.setSessionStatus(wt.sessionId, "existing");
        log.info(
          { sessionId: wt.sessionId, ports: result.ports },
          "syncProject: takeover complete",
        );
      } catch (err) {
        log.warn({ err, sessionId: wt.sessionId }, "syncProject: takeover failed, fallback to orphan");
        // takeover 失败 → fallback: insert DB row + 标 orphan
        try {
          db.insert(schema.sessions)
            .values({
              id: wt.sessionId,
              projectId: project.id,
              name: wt.sessionId,
              branch: wt.branch,
              worktreePath: wt.worktreePath,
              ports: null,
              backgroundHookStatus: null,
            })
            .run();
          ctx.setSessionStatus(wt.sessionId, "orphan");
        } catch (err2) {
          log.warn({ err: err2, sessionId: wt.sessionId }, "syncProject: orphan fallback insert failed");
        }
      }
    } else {
      // §4.3.1 orphan：不完整 → 不进 sidebar，由 OrphanCleanModal 处理
      try {
        db.insert(schema.sessions)
          .values({
            id: wt.sessionId,
            projectId: project.id,
            name: wt.sessionId,
            branch: wt.branch,
            worktreePath: wt.worktreePath,
            ports: null,
            backgroundHookStatus: null,
          })
          .run();
        ctx.setSessionStatus(wt.sessionId, "orphan");
        log.info(
          { sessionId: wt.sessionId, projectPath },
          "syncProject: inserted orphan worktree",
        );
      } catch (err) {
        log.warn({ err, sessionId: wt.sessionId }, "syncProject: orphan insert failed");
      }
    }
  }

  // (d2) §4.3.1: Update runtime status for EXISTING rows.
  //      daemon 认 → 用 daemon 状态；daemon 不认 → 按磁盘完整性判定 takeover/orphan。
  //      如果是 takeover 且 v2 可用，重试 silentTakeover（上一轮可能因 RECOVERING 失败）。
  for (const row of existingRows) {
    const daemonEntry = v2Snapshot.get(row.worktreePath);
    if (daemonEntry) {
      ctx.setSessionStatus(row.id, daemonEntry.status);
      continue;
    }
    // daemon 不认 → 看磁盘完整性
    const dirComplete = isDirectoryComplete(row.worktreePath);

    if (!dirComplete) {
      ctx.setSessionStatus(row.id, "orphan");
      continue;
    }

    // 完整 + daemon 不认 → takeover。如果 v2 可用，重试 claim。
    if (v2) {
      const currentStatus = ctx.getSessionStatus(row.id);
      if (currentStatus !== "existing") {
        // 上一轮 takeover 可能因 RECOVERING 失败了，重试
        try {
          const wt = disk.find((d) => d.sessionId === row.id);
          if (wt) {
            const result = await silentTakeover(v2, wt, project, db);
            ctx.setSessionStatus(row.id, "existing");
            log.info(
              { sessionId: row.id },
              "syncProject: takeover retry succeeded",
            );
            continue;
          }
        } catch (err) {
          log.warn({ err, sessionId: row.id }, "syncProject: takeover retry failed");
        }
      }
    }
    ctx.setSessionStatus(row.id, "takeover");
  }

  // (e) Reconcile ports again — catch any newly inserted rows.
  syncProjectPortsToDb(db, project.id, worktreePorts);

  // (f) Clean up stale DB sessions (worktree gone from disk).
  //     §4.3.1: 只删本地 DB 行，不 release 端口（不依赖 daemon 状态）。
  for (const row of existingRows) {
    if (diskWtIds.has(row.id)) continue;
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
  worktreePorts: Map<string, Record<string, number>>,
): void {
  const rows = db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.projectId, projectId))
    .all();
  for (const row of rows) {
    const ports = worktreePorts.get(row.worktreePath);
    if (!ports) continue;
    const wantPorts = JSON.stringify(ports);
    if (row.ports === wantPorts) continue;
    db.update(schema.sessions).set({ ports: wantPorts }).where(eq(schema.sessions.id, row.id)).run();
    if (existsSync(row.worktreePath)) {
      try { writePortsToEnv(row.worktreePath, ports); } catch (err) {
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
      await syncProject(projectPath, ctx);
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
        userStatus: s.userStatus ?? null,
        lastActivatedAt: s.lastActivatedAt ?? null,
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
    const v2 = ctx.getV2PortService();
    const failed: Array<{ sessionId: string; stage: string; error: string }> = [];
    for (const s of sessionsForProject) {
      // v2: release ports via v2PortService (no-op if session is unknown).
      if (v2) {
        try {
          await v2.service.releaseSession(s.id);
        } catch (err) {
          log.warn({ err, sessionId: s.id }, "db:projects:delete v2 release failed");
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
    await syncProject(projectPath, ctx, true);
    const db = getActiveDb();
    if (!db) return { synced: 0 };
    return { synced: db.select().from(schema.sessions).all().length };
  });
}
