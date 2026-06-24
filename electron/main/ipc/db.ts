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
  getWorktreeBase,
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
  /** Global projects DB (machine-level, not per-project). */
  getGlobalDb: () => import("../../../plugins/db/index.js").DrizzleDb | null;
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
  const ports = await v2.claimOrReuse({
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
export async function syncProject(
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
  // Project lookup uses the global DB (projects no longer in per-project DBs).
  const globalDb = ctx.getGlobalDb();
  let project = globalDb
    ? globalDb
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.path, projectPath))
      .get()
    : undefined;

  // 自愈：boot 阶段 activeProjectPath = process.cwd() 不会写 global DB,
  // db:init IPC 也只清 lastScanAt 不写 global DB. 这里兜底注册让 syncProject
  // 走完全流程, 否则磁盘上的 worktree 永远不被发现 (PR #86 修复的"切换"
  // 路径覆盖不到"初次打开"路径).
  //
  // 宽松匹配: raw path 查不到时, 把 global DB 里所有 project 行拉出来跟
  // 规范化后的 projectPath 匹配 (处理遗留: path 字段可能带 forward slash
  // / 大小写不一致 / trailing slash). 找到任意匹配行就**复用其 id** —
  // 不重新生成 id, 不破坏已有 session/todo 行对老 project_id 的引用.
  // 这跟 db:projects:create (用 nanoid) 路径完全兼容, 因为老 id 会被保留.
  if (!project && globalDb) {
    const normalized = projectPath
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .replace(/^([A-Z]):/i, (_, d) => d.toLowerCase() + ":");
    const name = projectPath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || projectPath;

    // 1) 宽松匹配: 拉所有 projects 行, 自己规范化 path 后比较
    const allProjects = globalDb
      .select({ id: schema.projects.id, path: schema.projects.path, name: schema.projects.name })
      .from(schema.projects)
      .all();
    const matchByNormalized = allProjects.find((p) => {
      const pNorm = p.path
        .replace(/\\/g, "/")
        .replace(/\/+$/, "")
        .replace(/^([A-Z]):/i, (_, d) => d.toLowerCase() + ":");
      return pNorm === normalized;
    });
    if (matchByNormalized) {
      project = matchByNormalized;
      // 修 path 字段: 让 raw path 跟当前 projectPath 一致 (forward slash → backslash 等)
      if (matchByNormalized.path !== projectPath) {
        try {
          globalDb
            .update(schema.projects)
            .set({ path: projectPath, name })
            .where(eq(schema.projects.id, matchByNormalized.id))
            .run();
          log.warn(
            { projectPath, id: matchByNormalized.id, oldPath: matchByNormalized.path },
            "syncProject: repaired project path to canonical form",
          );
        } catch (err) {
          log.warn({ err, id: matchByNormalized.id }, "syncProject: path repair failed (non-fatal)");
        }
      }
      log.warn(
        { projectPath, id: matchByNormalized.id },
        "syncProject: re-using existing project (was missing from raw path lookup)",
      );
    } else {
      // 2) 新建: global DB 完全没记录. 用 nanoid (跟 db:projects:create 一致)
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
          "syncProject: auto-registered project in global DB (was missing)",
        );
      } catch (err) {
        log.error(
          { err, projectPath },
          "syncProject: auto-register failed; aborting sync",
        );
        return;
      }
    }
  }
  if (!project) return;

  // §4.3.2 迁移: per-project DB 里 session/todo 行的 project_id 引用的是
  // 旧 global DB 项目 id (legacy 状态: 老 nanoid id 被新代码替换成了 path
  // 散列 id, 但 session 行没跟着更新). 如果不迁移, syncProject 后续按
  // project.id 查 session 会查不到老行, 然后 INSERT 撞 UNIQUE.
  //
  // 启发式: per-project DB 是项目私有, 它的所有 session/todo 行**应该**都
  // 引用同一个 project id. 如果有不同 id 出现, 都是遗留状态, 统一迁移到
  // 当前 project.id. 但**只**对那些**只有一个不同老 id**的情况自动迁 —
  // 多个老 id 出现说明 per-project DB 被多个项目污染, 安全起见不自动处理
  // (留给用户手工清).
  try {
    const projectIds = db
      .selectDistinct({ projectId: schema.sessions.projectId })
      .from(schema.sessions)
      .all()
      .map((r) => r.projectId);
    const oldIds = projectIds.filter((id) => id !== project.id);
    if (oldIds.length === 1) {
      const oldId = oldIds[0];
      const updatedSessions = db
        .update(schema.sessions)
        .set({ projectId: project.id })
        .where(eq(schema.sessions.projectId, oldId))
        .run();
      const updatedTodos = db
        .update(schema.todos)
        .set({ projectId: project.id })
        .where(eq(schema.todos.projectId, oldId))
        .run();
      log.warn(
        { from: oldId, to: project.id, projectPath, sessions: updatedSessions.changes, todos: updatedTodos.changes },
        "syncProject: migrated per-project DB project_id references to current global project id",
      );
    } else if (oldIds.length > 1) {
      log.warn(
        { oldIds, currentId: project.id, projectPath },
        "syncProject: per-project DB has multiple legacy project_id refs — manual cleanup required",
      );
    }
  } catch (err) {
    log.warn({ err, projectPath }, "syncProject: project_id migration check failed (non-fatal)");
  }

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
        // Insert the session row now that the daemon has claimed the worktree.
        // Without this, takeover sessions are invisible to the sidebar.
        try {
          db.insert(schema.sessions)
            .values({
              id: wt.sessionId,
              projectId: project.id,
              name: wt.sessionId,
              branch: wt.branch,
              worktreePath: wt.worktreePath,
              ports: JSON.stringify(result.ports),
              backgroundHookStatus: null,
            })
            .run();
        } catch (insertErr) {
          log.warn(
            { err: insertErr, sessionId: wt.sessionId },
            "syncProject: takeover session insert failed",
          );
        }
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

  // (h) §4.3.2: 清理跨项目污染行. 历史数据可能含 worktree_path 指向其他
  //     project 的行 (e.g. seed 迁移前残留, 或用户复制粘贴别的项目 DB 覆盖过来).
  //     留着会污染 db:projects:list 返回 — 用 projectPath 派生 worktree base 过滤.
  //     必须在 (f) 之后做, 否则刚删的"磁盘没了"行跟这个清理逻辑重叠但原因不同.
  const expectedBase = getWorktreeBase(projectPath);
  // §4.3.2: path 比较前统一规范化 (separators → /, lowercase, 加 trailing /)
  // 否则 forward slash vs backslash + Windows 大小写不敏感会导致误删.
  const normalizeForCompare = (p: string) =>
    p.replace(/\\/g, "/").toLowerCase() + "/";
  const normalizedExpected = normalizeForCompare(expectedBase);
  for (const row of existingRows) {
    if (normalizeForCompare(row.worktreePath).startsWith(normalizedExpected)) continue;
    try {
      db.delete(schema.sessions).where(eq(schema.sessions.id, row.id)).run();
      log.warn(
        { sessionId: row.id, worktreePath: row.worktreePath, projectPath },
        "syncProject: removed cross-project session row",
      );
    } catch (err) {
      log.warn(
        { err, sessionId: row.id },
        "syncProject: cross-project delete failed",
      );
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
        runtimeStatus: ctx.getSessionStatus(s.id),
      })),
    }));
  });

  ipcMain.handle(IPC_CHANNELS["db:projects:create"], (_e, body: { name: string; path: string }) => {
    if (!body?.name || !body?.path) throw new Error("name and path required");
    const safePath = validateProjectPath(body.path);
    const id = nanoid(8);
    const globalDb = ctx.getGlobalDb();
    if (!globalDb) throw new Error("Global DB not initialized");
    globalDb.insert(schema.projects).values({ id, name: body.name, path: safePath }).run();
    return globalDb.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
  });

  ipcMain.handle(IPC_CHANNELS["db:projects:delete"], async (_e, projectId: string) => {
    if (!projectId) throw new Error("projectId required");
    // Project lookup is from the global DB.
    const globalDb = ctx.getGlobalDb();
    const project = globalDb
      ? globalDb.select().from(schema.projects).where(eq(schema.projects.id, projectId)).get()
      : undefined;
    if (!project) return { deleted: 0, sessionIds: [], failed: [] };
    // Sessions are from the per-project DB.
    const db = getDb(ctx);
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
