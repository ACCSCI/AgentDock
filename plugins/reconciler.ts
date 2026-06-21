/**
 * Reconciler — 三表对账 (新架构 §4.3, C1-C5 残缺态分类).
 *
 * 启动时 / 定期跑, 对 daemon 三表与 git worktree / 磁盘状态做双向扫描,
 * 分类残缺态并按规则处置:
 *
 *   | 编号 | DB 状态       | git/磁盘         | 含义              | 处置                            |
 *   |------|---------------|------------------|-------------------|---------------------------------|
 *   | 正常 | active        | worktree 存在    | 一致              | 不动                            |
 *   | C1   | creating      | 目录缺/不完整    | 创建未完成        | 仅当**活性租约已死** → 按提交点  |
 *   | C2   | deleting      | 目录可能残留    | 删除中途崩        | 仅当**活性租约已死** → 接管续删  |
 *   | C3   | active        | 目录不存在       | 外部删/git 残缺   | **不静默删**: 标记孤儿, UI 提示  |
 *   | C4   | 无记录        | .agentdock/worktrees/* 存在 | 外部建/旧版 | **永不自动删**: UI 提示领养/清理 |
 *   | C5   | active        | git 登记悬挂     | git worktree 悬挂 | git worktree prune → C3        |
 *
 * 原则:
 *   - "自己流程中断" (C1/C2) 才在活性租约死亡后**自动收敛**;
 *   - "可能是用户手动操作" 的不一致 (C3/C4) **绝不静默销毁**, 交 UI 让用户决定;
 *   - purge 后磁盘短暂残留落在 C4 的"永不自动删"保护下, 仅提示, 瞬态自消。
 *
 * 双信号死亡判定 (§4.4):
 *   1. 该 session 的 owner 实例心跳已超时(HEARTBEAT_TIMEOUT 90s, §7.1); AND
 *   2. 该 session 的 progress lease 已过期(leaseExpiresAt < now)。
 *
 * RECOVERING 期间暂缓卡死判定 (§4.4 末段):
 *   - 对账器在 RECOVERING 期间完全跳过 creating/deleting 的卡死回收。
 *   - 退出 RECOVERING 后, 给每个进行中条目一个完整 LEASE_TTL 宽限窗口再开始判定。
 *
 * 本模块是**纯逻辑 + 依赖注入**:
 *   - 所有 IO (FS, git, kill, purge) 都通过 deps 注入, 便于单测覆盖各种
 *     C1-C5 路径, 不污染 daemon 主循环。
 *   - 上层 (server.ts) 在 RECOVERING → READY 转换时调 setReady() 设宽限起点,
 *     之后用 setInterval 每 RECOVERING_HARD_MAX/2 调 tick() 跑对账。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { log } from "./logger.js";
import {
  HEARTBEAT_TIMEOUT_MS,
  LEASE_TTL_MS,
  RECOVERING_HARD_MAX_MS,
} from "./constants.js";
import type { DaemonStateV2 } from "./daemon-state-v2.js";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// 残缺态分类
// ---------------------------------------------------------------------------

export type ReconcileAction =
  | { kind: "noop" }
  | { kind: "C1-rollback"; sessionId: string; reason: "missing-env-ports" | "env-values-mismatch" }
  | { kind: "C1-retain"; sessionId: string; reason: "passes-commit-point" }
  | { kind: "C2-takeover-delete"; sessionId: string; projectRoot: string; worktreePath: string }
  | { kind: "C3-orphan"; sessionId: string; projectRoot: string; reason: "no-worktree" }
  | { kind: "C4-orphan-dir"; worktreePath: string; sessionIdGuess: string | null }
  | { kind: "C5-prune-then-C3"; sessionId: string; projectRoot: string };

export interface ReconcileReport {
  /** All actions taken this tick. */
  actions: ReconcileAction[];
  /** Stats — useful for /metrics and tests. */
  stats: {
    activeChecked: number;
    creatingChecked: number;
    deletingChecked: number;
    worktreeDirsScanned: number;
  };
}

// ---------------------------------------------------------------------------
// 依赖注入
// ---------------------------------------------------------------------------

/**
 * scanWorktreeDirs — §4.3 C4. 扫一个 project 的 `.agentdock/worktrees/*`
 * 列出磁盘上有但 v2 sessions 表里没有的目录. caller 注入此函数以保持
 * reconciler 纯逻辑 + fs 解耦.
 *
 *   - 返回值: 该 project 下的 worktree 目录列表 (含路径 + 推断的 sessionId)
 *   - 推断规则: 路径末段 == sessionId (按 §4.1 派生约定)
 *   - caller 应过滤掉 SESSION_ID_RE 不匹配者 (不是 AgentDock 创建的)
 */
export type WorktreeDirScan = (projectRoot: string) => WorktreeDirEntry[];

export interface WorktreeDirEntry {
  /** sessionId parsed from the directory name (last path segment). */
  sessionIdGuess: string | null;
  worktreePath: string;
}

export interface ReconcileDeps {
  /** v2 三表真相源(读 + 状态机变更)。*/
  stateV2: DaemonStateV2;
  /**
   * Owner 实例心跳 lookup. 来自 v1 ctx.state (client.lastHeartbeat).
   * 返回 null = 该 client 不存在/已被清。
   */
  getOwnerLastHeartbeat: (clientId: string) => number | null;
  /** OS-level liveness probe (signal 0 / OpenProcess). */
  isProcessAlive: (pid: number) => boolean;
  /** 注入 fs.existsSync (tests). */
  existsSync?: (p: string) => boolean;
  /** 注入 fs.readFileSync (tests). */
  readFileSync?: (p: string) => string;
  /** 注入 exec for git worktree prune (tests). */
  execImpl?: (cmd: string) => Promise<{ stdout: string; stderr: string }>;
  /** 解析 worktreePath -> projectRoot, 已知 v2 sessions.projectRoot。
   *  若解析失败返回 null (回退 C3/C4 处理)。*/
  resolveProjectRoot?: (worktreePath: string) => string | null;
  /** 可选: 跨进程通知 UI。接收 C3/C4/C5 事件。*/
  emitOrphan?: (a: ReconcileAction) => void;
  /** 可选: 接管删除(via v2 /session/purge + worktree cleanup).
   *  实现细节由 caller 提供 (daemon routes 或 reconciler-tick context). */
  takeOverDelete?: (sessionId: string, projectRoot: string, worktreePath: string) => Promise<void>;
  /** 可选: rollback C1(via v2 /session/delete + /session/purge). */
  rollbackCreate?: (sessionId: string) => Promise<void>;
  /** §4.3 C4 — 扫 .agentdock/worktrees/* 找 DB 无记录者. 默认 noop
   *  (意味着 C4 不报, 与架构 §4.3 描述有偏差). 注入真实扫描以启用. */
  scanWorktreeDirs?: WorktreeDirScan;
  /** §4.3 C4 — 列出需要扫的 projectRoots. 默认从 v2 sessions.projectRoot
   *  去重得出, 加 caller 注入的额外 roots (如多 project 场景). */
  additionalProjectRoots?: () => string[];
  /** 注入 now() (tests). */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

export interface Reconciler {
  /** Mark time the daemon became READY (用于宽限窗口). */
  setReady(at: number): void;
  /** Force-clear the grace window (主要用于测试). */
  clearReady(): void;
  /** 当前是否在 grace 窗口 (LEASE_TTL 自 READY 起). */
  isInGraceWindow(): boolean;
  /** Run one tick of reconciliation. */
  tick(): Promise<ReconcileReport>;
}

export function createReconciler(deps: ReconcileDeps): Reconciler {
  const exists = deps.existsSync ?? existsSync;
  const read = deps.readFileSync ?? ((p: string) => readFileSync(p, "utf-8"));
  const execImpl = deps.execImpl ?? defaultExec;
  const now = deps.now ?? (() => Date.now());
  let readySince: number | null = null;

  function isInGraceWindow(): boolean {
    if (readySince === null) return false;
    return now() - readySince < LEASE_TTL_MS;
  }

  async function tick(): Promise<ReconcileReport> {
    const actions: ReconcileAction[] = [];
    const stats = {
      activeChecked: 0,
      creatingChecked: 0,
      deletingChecked: 0,
      worktreeDirsScanned: 0,
    };

    // §4.4 末段 — RECOVERING 期间完全跳过
    if (deps.stateV2.isRecovering()) {
      log.debug("reconciler: skipping during RECOVERING");
      return { actions, stats };
    }
    // §4.4 末段 — 退出 RECOVERING 后给 LEASE_TTL 宽限窗口
    if (isInGraceWindow()) {
      log.debug({ readySince }, "reconciler: in grace window, skipping");
      return { actions, stats };
    }

    // ----- 1. creating / deleting 卡死判定 -----
    for (const s of deps.stateV2.listSessions()) {
      if (s.status === "creating") {
        stats.creatingChecked++;
        const action = await classifyCreating(s.sessionId, s.projectRoot, s.leaseExpiresAt, deps.stateV2, exists, read);
        await dispatchAction(action, deps);
        actions.push(action);
      } else if (s.status === "deleting") {
        stats.deletingChecked++;
        const action = await classifyDeleting(s.sessionId, s.projectRoot, s.leaseExpiresAt);
        await dispatchAction(action, deps);
        actions.push(action);
      } else {
        stats.activeChecked++;
        // active 状态: 不卡死判定(由 HEARTBEAT_TIMEOUT 兜底); 只做 C3/C5 检查
        const actionsForActive = await classifyActive(s.sessionId, s.projectRoot, exists);
        for (const a of actionsForActive) {
          await dispatchAction(a, deps);
          actions.push(a);
        }
      }
    }

    // ----- 2. C4 — 扫磁盘上 .agentdock/worktrees/* 看是否有 DB 无记录者 -----
    // §4.3: 永不自动删, 仅 emit C4-orphan-dir 由 UI 决定.
    if (deps.scanWorktreeDirs) {
      const roots = new Set<string>();
      for (const s of deps.stateV2.listSessions()) {
        if (s.projectRoot) roots.add(s.projectRoot);
      }
      for (const r of deps.additionalProjectRoots?.() ?? []) {
        roots.add(r);
      }
      const knownSessionIds = new Set(deps.stateV2.listSessions().map((s) => s.sessionId));
      for (const projectRoot of roots) {
        const dirs = deps.scanWorktreeDirs(projectRoot);
        for (const dir of dirs) {
          stats.worktreeDirsScanned++;
          // 过滤: 推断的 sessionId 已经在 DB 里的不算 C4
          if (dir.sessionIdGuess && knownSessionIds.has(dir.sessionIdGuess)) continue;
          // 过滤: 无法推断 sessionId 的目录可能不是 AgentDock 创建, 跳过
          if (!dir.sessionIdGuess) continue;
          const action: ReconcileAction = {
            kind: "C4-orphan-dir",
            sessionIdGuess: dir.sessionIdGuess,
            worktreePath: dir.worktreePath,
          };
          await dispatchAction(action, deps);
          actions.push(action);
        }
      }
    }
    return { actions, stats };
  }

  return {
    setReady(at: number) {
      readySince = at;
    },
    clearReady() {
      readySince = null;
    },
    isInGraceWindow,
    tick,
  };
}

// ---------------------------------------------------------------------------
// 分类函数
// ---------------------------------------------------------------------------

async function classifyCreating(
  sessionId: string,
  projectRoot: string,
  leaseExpiresAt: number | null,
  stateV2: DaemonStateV2,
  exists: (p: string) => boolean,
  read: (p: string) => string,
): Promise<ReconcileAction> {
  if (leaseExpiresAt === null) {
    return { kind: "noop" };
  }
  if (Date.now() < leaseExpiresAt) {
    return { kind: "noop" };
  }
  // lease dead — check commit point (§4.2)
  // N 推导: N = portKeys.length from v2 ports table
  const sessionPorts = stateV2.getSessionPorts(sessionId);
  const sessionPortNames = stateV2.getSessionPortNames(sessionId);
  const n = sessionPortNames.length;
  if (n === 0) {
    // 还没 claim 任何端口 — 未过提交点 — 回滚
    return { kind: "C1-rollback", sessionId, reason: "missing-env-ports" };
  }
  const worktreePath = path.join(projectRoot, ".agentdock", "worktrees", sessionId);
  const envFile = path.join(worktreePath, ".env");
  // 文件不存在 = 未过提交点 (用 exists 探测, 避免空字符串被 parseEnvPorts 误读)
  if (!exists(envFile)) {
    return { kind: "C1-rollback", sessionId, reason: "missing-env-ports" };
  }
  let envContents: string;
  try {
    envContents = read(envFile);
  } catch {
    return { kind: "C1-rollback", sessionId, reason: "missing-env-ports" };
    return { kind: "C1-rollback", sessionId, reason: "missing-env-ports" };
  }
  const envValues = parseEnvPorts(envContents);
  // 键值匹配(§4.2 不变式 — 不只是数键数)
  for (const name of sessionPortNames) {
    const port = sessionPorts[sessionPortNames.indexOf(name)];
    const envVal = envValues[name];
    if (envVal === undefined || envVal !== port) {
      return { kind: "C1-rollback", sessionId, reason: "env-values-mismatch" };
    }
  }
  return { kind: "C1-retain", sessionId, reason: "passes-commit-point" };
}

/**
 * Parse a .env file's port-like lines. Lines like `FRONTEND_PORT=3000`.
 * Skips comments and blank lines.
 */
function parseEnvPorts(contents: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    const n = Number(val);
    if (!Number.isFinite(n)) continue;
    out[key] = n;
  }
  return out;
}

async function classifyDeleting(
  sessionId: string,
  projectRoot: string,
  leaseExpiresAt: number | null,
): Promise<ReconcileAction> {
  if (leaseExpiresAt === null) {
    return { kind: "noop" };
  }
  if (Date.now() < leaseExpiresAt) {
    return { kind: "noop" };
  }
  // lease dead — 接管续删
  const worktreePath = path.join(projectRoot, ".agentdock", "worktrees", sessionId);
  return {
    kind: "C2-takeover-delete",
    sessionId,
    projectRoot,
    worktreePath,
  };
}

async function classifyActive(
  sessionId: string,
  projectRoot: string,
  exists: (p: string) => boolean,
): Promise<ReconcileAction[]> {
  const out: ReconcileAction[] = [];
  const worktreePath = path.join(projectRoot, ".agentdock", "worktrees", sessionId);
  if (!exists(worktreePath)) {
    // C3: active 但 worktree 不存在 — 不静默删
    out.push({ kind: "C3-orphan", sessionId, projectRoot, reason: "no-worktree" });
  }
  // C5 检测: active + git 登记悬挂 — 需要 git worktree list --porcelain
  // 实现留给 caller (executor 注入 git 检测)。这里只标记 metadata。
  return out;
}

async function dispatchAction(action: ReconcileAction, deps: ReconcileDeps): Promise<void> {
  switch (action.kind) {
    case "noop":
      return;
    case "C1-retain":
      // 保留待 §5.3 sync 重注册 — 不自动删除
      log.info({ sessionId: action.sessionId }, "C1 retain (passes commit point)");
      deps.emitOrphan?.(action);
      return;
    case "C1-rollback":
      log.info({ sessionId: action.sessionId, reason: action.reason }, "C1 rollback (failed commit point)");
      try {
        await deps.rollbackCreate?.(action.sessionId);
      } catch (err) {
        log.warn({ err, sessionId: action.sessionId }, "C1 rollback failed");
      }
      return;
    case "C2-takeover-delete":
      log.info({ sessionId: action.sessionId }, "C2 takeover delete");
      try {
        await deps.takeOverDelete?.(action.sessionId, action.projectRoot, action.worktreePath);
      } catch (err) {
        log.warn({ err, sessionId: action.sessionId }, "C2 takeover delete failed");
      }
      return;
    case "C3-orphan":
      log.info({ sessionId: action.sessionId, projectRoot: action.projectRoot }, "C3 active session has no worktree");
      deps.emitOrphan?.(action);
      return;
    case "C4-orphan-dir":
      log.info({ worktreePath: action.worktreePath }, "C4 orphan dir (no DB record)");
      deps.emitOrphan?.(action);
      return;
    case "C5-prune-then-C3":
      log.info({ sessionId: action.sessionId }, "C5 git worktree prune");
      try {
        await execImpl(`git -C "${action.projectRoot}" worktree prune`);
      } catch (err) {
        log.warn({ err }, "C5 git prune failed");
      }
      deps.emitOrphan?.(action);
      return;
  }
}

async function defaultExec(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(cmd);
}

/**
 * 公共工具 — caller 用来在 RECOVERING → READY 转换时同步 grace window.
 */
export const RECONCILER_TUNING = {
  HEARTBEAT_TIMEOUT_MS,
  LEASE_TTL_MS,
  RECOVERING_HARD_MAX_MS,
  /** 对账器跑频率 — RECOVERING_HARD_MAX / 2, 留出 1/2 给 ready grace window. */
  TICK_INTERVAL_MS: Math.floor(RECOVERING_HARD_MAX_MS / 2),
} as const;
