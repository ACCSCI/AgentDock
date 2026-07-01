import { existsSync } from "node:fs";
import type { AgentDockConfig, HookLifecycleEvent } from "./config.js";
import {
  createHookEngine,
  createHookRegistry,
  type HookContext,
  type HookReport,
} from "./hook-engine.js";
import type { SessionPorts } from "./daemon-state.js";
import { writePortsToEnv } from "./port-write-env.js";
import {
  createResourceSyncService,
  type SyncReport,
} from "./resource-sync.js";
import {
  createWorktree,
  getWorktreePath,
  removeWorktree,
} from "./worktree.js";
import { verifyCommitPoint } from "./v2-port-service.js";

/**
 * Abstract port service interface for session lifecycle.
 * Decouples lifecycle from concrete port implementation.
 */
export interface PortService {
  allocateSession(params: {
    sessionId: string;
    projectPath: string;
    worktreePath: string;
    portKeys?: string[];
    /**
     * User-supplied display name (新架构 §4.1 — 自由文本). Optional —
     * implementations fall back to `sessionId` when omitted. The v2
     * service forwards this to `/session/create`'s `displayName` field
     * so the daemon stores the user's name verbatim (the renderer
     * passes this through from `name` in `sessions:create`).
     */
    displayName?: string;
  }): Promise<SessionPorts>;
  releaseSession(sessionId: string): Promise<void>;
  /**
   * v2-only (新架构 §4.2). Called after `removeWorktree` succeeds, before
   * `afterDeleteSession` hooks. v1 PortService implementations may omit
   * this — the orchestrator no-ops when the method is absent.
   *
   * v2 semantics: POST /session/purge to drop the session's three-table
   * entries. Must come AFTER the worktree is gone so the daemon's
   * "worktree still owned" guard doesn't reject the purge.
   */
  completeDeletion?(sessionId: string): Promise<void>;
}

// --- Step event types ---
export type StepName = "beforeCreateSession" | "createWorktree" | "syncResources" | "allocatePorts" | "afterCreateSession"
  | "beforeDeleteSession" | "releasePorts" | "removeWorktree" | "afterDeleteSession";

export interface StepEvent {
  step: StepName;
  status: "running" | "done" | "error";
  duration?: number;
  error?: string;
}

// --- Input/Output types ---
export interface CreateSessionInput {
  projectId: string;
  projectPath: string;
  sessionId: string;
  sessionName: string;
  baseBranch?: string;
  config: AgentDockConfig;
  onStep?: (event: StepEvent) => void;
  /** Called immediately after the worktree is created on disk, before slow hooks run.
   *  The API handler uses this to insert the DB row early, closing the auto-sync race window. */
  onWorktreeReady?: (worktreePath: string, branch: string) => void;
  /** Called when an async background hook completes. */
  onBackgroundHookComplete?: (report: HookReport) => void;
}

export interface CreateSessionResult {
  sessionId: string;
  worktreePath: string;
  branch: string;
  ports: SessionPorts;
  syncReport: SyncReport;
  hookReports: HookReport[];
  duration: number;
  /** Promise that resolves when async background hooks complete.
   *  Resolves immediately if there are no async hooks. */
  backgroundHookPromise: Promise<HookReport>;
}

export interface DeleteSessionInput {
  sessionId: string;
  projectPath: string;
  worktreePath: string;
  config: AgentDockConfig;
  /**
   * Git branch currently backing the worktree. May differ from
   * `agentdock/<sessionId>` if the session was renamed (8ec663a). When
   * omitted, removeWorktree falls back to `agentdock/<sessionId>` and
   * leaves the real branch dangling.
   */
  currentBranch?: string;
  onStep?: (event: StepEvent) => void;
}

export interface DeleteSessionResult {
  sessionId: string;
  hookReports: HookReport[];
  success: boolean;
}

export interface SessionLifecycle {
  create(input: CreateSessionInput): Promise<CreateSessionResult>;
  remove(input: DeleteSessionInput): Promise<DeleteSessionResult>;
}

/**
 * Create a SessionLifecycle orchestrator.
 * Dependencies are injected to keep the orchestrator testable.
 */
export function createSessionLifecycle(deps?: {
  portService?: PortService;
}): SessionLifecycle {
  const resourceSyncService = createResourceSyncService();
  const hookRegistry = createHookRegistry();
  const hookEngine = createHookEngine(hookRegistry);

  function buildHookContext(
    event: HookLifecycleEvent,
    input: { projectId: string; sessionId: string; projectPath: string; worktreePath: string },
  ): HookContext {
    return {
      event,
      sessionId: input.sessionId,
      projectId: input.projectId,
      projectPath: input.projectPath,
      worktreePath: input.worktreePath,
      payload: {},
    };
  }

  function log(sessionId: string, msg: string) {
    // Swallow EPIPE from console.log: this orchestrator is called by
    // long-running fire-and-forget IPC handlers, and the parent
    // stdout pipe can close mid-flight (window closed → Electron tears
    // down stdio). Without this guard the EPIPE bubbles up as an
    // uncaught exception and Electron shows a "JavaScript error
    // occurred in the main process" dialog.
    try {
      console.log(`[SessionLifecycle] ${sessionId} → ${msg}`);
    } catch {
      // pipe gone — nothing useful to do here.
    }
  }

  function emit(onStep: ((e: StepEvent) => void) | undefined, event: StepEvent) {
    try {
      onStep?.(event);
    } catch {
      // onStep is typically `webContents.send(...)` — if the renderer
      // window is gone, that throws ERR_IPC_CHANNEL_CLOSED. The
      // lifecycle must continue running its cleanup steps regardless.
    }
  }

  async function create(input: CreateSessionInput): Promise<CreateSessionResult> {
    const start = Date.now();
    const { projectId, projectPath, sessionId, sessionName, baseBranch, config, onStep, onWorktreeReady, onBackgroundHookComplete } = input;
    const hookReports: HookReport[] = [];

    hookRegistry.loadFromConfig(config.hooks as Record<string, import("./config.js").HookDefinition[]>);
    const worktreePath = getWorktreePath(projectPath, sessionId);

    log(sessionId, `create "${sessionName}" (project: ${projectPath})`);

    // Step 1: BeforeCreateSession hooks
    emit(onStep, { step: "beforeCreateSession", status: "running" });
    const beforeStepStart = Date.now();
    const beforeCtx = buildHookContext("beforeCreateSession", { projectId, sessionId, projectPath, worktreePath });
    const beforeReport = await hookEngine.execute("beforeCreateSession", beforeCtx);
    hookReports.push(beforeReport);
    const beforeDuration = Date.now() - beforeStepStart;
    if (!beforeReport.success) {
      log(sessionId, `beforeCreateSession ✗ FAILED (${beforeDuration}ms)`);
      emit(onStep, { step: "beforeCreateSession", status: "error", duration: beforeDuration, error: "hook failed (required)" });
      throw new Error("beforeCreateSession hook failed (required)");
    }
    log(sessionId, `beforeCreateSession ✓ ${beforeDuration}ms`);
    emit(onStep, { step: "beforeCreateSession", status: "done", duration: beforeDuration });

    // Step 2: CreateWorktree (Core)
    emit(onStep, { step: "createWorktree", status: "running" });
    const wtStepStart = Date.now();
    const wt = createWorktree(projectPath, sessionId, baseBranch);
    const wtDuration = Date.now() - wtStepStart;
    log(sessionId, `createWorktree ✓ ${wtDuration}ms (${wt.branch})`);
    emit(onStep, { step: "createWorktree", status: "done", duration: wtDuration });

    // Notify caller that the worktree exists on disk — allows early DB insert
    // to prevent auto-sync from re-inserting the session during long hooks.
    onWorktreeReady?.(wt.worktreePath, wt.branch);

    try {
      // Step 3: SyncResources (Core)
      emit(onStep, { step: "syncResources", status: "running" });
      const syncStepStart = Date.now();
      const syncReport = await resourceSyncService.syncAll(projectPath, wt.worktreePath, config.resources.sync);
      const syncDuration = Date.now() - syncStepStart;
      log(sessionId, `syncResources ✓ ${syncDuration}ms (${syncReport.results.length} resources)`);
      emit(onStep, { step: "syncResources", status: "done", duration: syncDuration });

      // Step 4: AllocatePorts (Core)
      emit(onStep, { step: "allocatePorts", status: "running" });
      const portsStepStart = Date.now();
      if (!deps?.portService) throw new Error("portService is required");
      const portKeys = config.env?.ports?.length ? config.env.ports : undefined;
      // F6 — pass user-supplied displayName through so the v2 service
      // can forward it to /session/create. v1 implementations ignore it.
      const ports = await deps.portService.allocateSession({
        sessionId,
        projectPath,
        worktreePath: wt.worktreePath,
        portKeys,
        displayName: sessionName,
      });
      writePortsToEnv(wt.worktreePath, ports);
      // §4.2 — 提交点值匹配 (内联校验). writePortsToEnv 后立即读回
      // .env 与 daemon claim 返回的端口逐项比对, 不一致立即抛错 (不
      // 等 reconciler 30s+ 后兜底). syncResources 的 mergeEnvFileSync
      // 可能把旧端口值合并进来, 仅按"键数 == N"会误判为已提交.
      verifyCommitPoint(wt.worktreePath, ports);
      const portsDuration = Date.now() - portsStepStart;
      const firstKey = Object.keys(ports)[0] ?? "?";
      log(sessionId, `allocatePorts ✓ ${portsDuration}ms (${Object.keys(ports).length} ports, ${firstKey}:${ports[firstKey]})`);
      emit(onStep, { step: "allocatePorts", status: "done", duration: portsDuration });

      // Step 5: AfterCreateSession hooks
      // Determine if afterCreateSession should run async (background)
      const afterHooks = hookRegistry.getHooks("afterCreateSession");
      const hasAsyncHook = afterHooks.some((h) => h.async);

      emit(onStep, { step: "afterCreateSession", status: "running" });
      const afterStepStart = Date.now();
      const afterCtx = buildHookContext("afterCreateSession", { projectId, sessionId, projectPath, worktreePath: wt.worktreePath });

      if (hasAsyncHook) {
        // Async mode: fire-and-forget, don't block the response
        log(sessionId, "afterCreateSession → async (non-blocking)");
        const backgroundPromise = hookEngine.execute("afterCreateSession", afterCtx).then((report) => {
          const duration = Date.now() - afterStepStart;
          hookReports.push(report);
          if (report.success) {
            log(sessionId, `afterCreateSession ✓ ${duration}ms (background)`);
            emit(onStep, { step: "afterCreateSession", status: "done", duration });
          } else {
            log(sessionId, `afterCreateSession ✗ FAILED (${duration}ms) (background)`);
            emit(onStep, { step: "afterCreateSession", status: "error", duration, error: "hook failed" });
          }
          onBackgroundHookComplete?.(report);
          return report;
        });

        const totalDuration = Date.now() - start;
        log(sessionId, `create complete ✓ ${totalDuration}ms (hooks running in background)`);
        return {
          sessionId, worktreePath: wt.worktreePath, branch: wt.branch, ports, syncReport,
          hookReports, duration: totalDuration, backgroundHookPromise: backgroundPromise,
        };
      }

      // Sync mode: await the hook (backward compatible)
      const afterReport = await hookEngine.execute("afterCreateSession", afterCtx);
      hookReports.push(afterReport);
      const afterDuration = Date.now() - afterStepStart;

      if (!afterReport.success) {
        log(sessionId, `afterCreateSession ✗ FAILED (${afterDuration}ms)`);
        log(sessionId, `  exitCode: ${afterReport.exitCode}`);
        log(sessionId, `  stdout: ${afterReport.stdout?.slice(0, 500)}`);
        log(sessionId, `  stderr: ${afterReport.stderr?.slice(0, 500)}`);
        log(sessionId, `  error: ${afterReport.error}`);
        emit(onStep, { step: "afterCreateSession", status: "error", duration: afterDuration, error: "hook failed (required)" });
        log(sessionId, "ROLLBACK: releasing ports + removing worktree");
        try {
          if (deps?.portService) {
            await deps.portService.releaseSession(sessionId);
          }
        } catch (e) { log(sessionId, `  rollback releasePorts failed: ${e}`); }
        // wt.branch is the freshly-created branch — passing it explicitly
        // keeps the rollback consistent with future renamed-session semantics.
        try { await removeWorktree(projectPath, sessionId, { currentBranch: wt.branch, force: true }); } catch (e) { log(sessionId, `  rollback removeWorktree failed: ${e}`); }
        throw new Error("afterCreateSession hook failed (required)");
      }
      log(sessionId, `afterCreateSession ✓ ${afterDuration}ms`);
      emit(onStep, { step: "afterCreateSession", status: "done", duration: afterDuration });

      const totalDuration = Date.now() - start;
      log(sessionId, `create complete ✓ ${totalDuration}ms`);
      return {
        sessionId, worktreePath: wt.worktreePath, branch: wt.branch, ports, syncReport,
        hookReports, duration: totalDuration,
        // Sync mode: the hook已经在上面 await 完成，没有后台任务在跑。
        // 必须返回 undefined（而非 Promise.resolve(...)），否则
        // sessions.ts 的 `if (!result.backgroundHookPromise)` 判定为 false，
        // 既不会通过 process.nextTick 发送 complete 事件，也不会触发
        // onBackgroundHookComplete（那个回调只在 async 分支调用）——
        // 结果前端 mutationFn 的 Promise 永不 resolve，"+"号一直转圈。
        backgroundHookPromise: undefined,
      };
    } catch (err) {
      log(sessionId, "ROLLBACK: releasing ports + removing worktree");
      try {
        if (deps?.portService) {
          await deps.portService.releaseSession(sessionId);
        }
      } catch (e) { log(sessionId, `  rollback releasePorts failed: ${e}`); }
      // `wt` is in scope here because createWorktree runs BEFORE this try
      // block — passing wt.branch keeps rollback consistent with rename.
      try {
        await removeWorktree(projectPath, sessionId, {
          currentBranch: wt.branch,
          force: true,
        });
      } catch (e) { log(sessionId, `  rollback removeWorktree failed: ${e}`); }
      // v2-only: also drop the three-table row. v1 omits this method.
      try {
        if (deps?.portService?.completeDeletion) {
          await deps.portService.completeDeletion(sessionId);
        }
      } catch (e) { log(sessionId, `  rollback completeDeletion failed: ${e}`); }
      throw err;
    }
  }

  async function remove(input: DeleteSessionInput): Promise<DeleteSessionResult> {
    const { sessionId, projectPath, worktreePath, config, currentBranch, onStep } = input;
    const hookReports: HookReport[] = [];
    const start = Date.now();

    hookRegistry.loadFromConfig(config.hooks as Record<string, import("./config.js").HookDefinition[]>);

    log(sessionId, `remove (project: ${projectPath})`);

    // Step 1: BeforeDeleteSession hooks
    emit(onStep, { step: "beforeDeleteSession", status: "running" });
    const beforeStepStart = Date.now();
    const beforeCtx = buildHookContext("beforeDeleteSession", { projectId: "", sessionId, projectPath, worktreePath });
    const beforeReport = await hookEngine.execute("beforeDeleteSession", beforeCtx);
    hookReports.push(beforeReport);
    const beforeDuration = Date.now() - beforeStepStart;
    if (!beforeReport.success) {
      log(sessionId, `beforeDeleteSession ✗ FAILED (${beforeDuration}ms)`);
      emit(onStep, { step: "beforeDeleteSession", status: "error", duration: beforeDuration, error: "hook failed (required)" });
      throw new Error("beforeDeleteSession hook failed (required)");
    }
    log(sessionId, `beforeDeleteSession ✓ ${beforeDuration}ms`);
    emit(onStep, { step: "beforeDeleteSession", status: "done", duration: beforeDuration });

    // Step 2: ReleasePorts (Core)
    emit(onStep, { step: "releasePorts", status: "running" });
    const portsStepStart = Date.now();
    if (deps?.portService) {
      await deps.portService.releaseSession(sessionId);
    }
    const portsDuration = Date.now() - portsStepStart;
    log(sessionId, `releasePorts ✓ ${portsDuration}ms`);
    emit(onStep, { step: "releasePorts", status: "done", duration: portsDuration });

    // Step 3: RemoveWorktree (Core)
    emit(onStep, { step: "removeWorktree", status: "running" });
    const wtStepStart = Date.now();
    let worktreeRemoved = false;
    if (existsSync(worktreePath)) {
      // Forward currentBranch so a renamed session's real branch (not
      // `agentdock/<sessionId>`) is deleted alongside the worktree.
      // Note: removeWorktree handles process killing internally.
      try {
        await removeWorktree(projectPath, sessionId, { currentBranch, force: true });
        worktreeRemoved = true;
      } catch (rmErr) {
        // On Windows, EBUSY/EPERM means a process still holds a file handle.
        // Log and continue — the orphan cleaner will retry later. Don't let
        // a locked directory block the rest of the deletion flow (DB + daemon
        // cleanup would otherwise be skipped, leaving a ghost session).
        log(sessionId, `removeWorktree ✗ ${rmErr} — continuing (orphan will retry)`);
        emit(onStep, { step: "removeWorktree", status: "error", duration: Date.now() - wtStepStart, error: String(rmErr) });
      }
    } else {
      worktreeRemoved = true;
    }
    if (worktreeRemoved) {
      const wtDuration = Date.now() - wtStepStart;
      log(sessionId, `removeWorktree ✓ ${wtDuration}ms`);
      emit(onStep, { step: "removeWorktree", status: "done", duration: wtDuration });
    }

    // Step 3.5: CompleteDeletion (v2-only, 新架构 §4.2).
    // v1 PortService omits this method → no-op. v2 calls /session/purge
    // here so the daemon's 3-table entries are dropped AFTER the worktree
    // is gone (matches the daemon's `deleting → purged` state machine).
    if (deps?.portService?.completeDeletion) {
      try {
        await deps.portService.completeDeletion(sessionId);
      } catch (e) {
        log(sessionId, `completeDeletion ✗ ${e}`);
      }
    }

    // Step 4: AfterDeleteSession hooks — failure doesn't affect result
    emit(onStep, { step: "afterDeleteSession", status: "running" });
    const afterStepStart = Date.now();
    const afterCtx = buildHookContext("afterDeleteSession", { projectId: "", sessionId, projectPath, worktreePath });

    // Determine if afterDeleteSession should run async (background)
    const afterDeleteHooks = hookRegistry.getHooks("afterDeleteSession");
    const hasAsyncDeleteHook = afterDeleteHooks.some((h) => h.async);

    if (hasAsyncDeleteHook) {
      // Async mode: fire-and-forget, don't block the response
      log(sessionId, "afterDeleteSession → async (non-blocking)");
      const backgroundDeletePromise = hookEngine.execute("afterDeleteSession", afterCtx).then((report) => {
        const duration = Date.now() - afterStepStart;
        hookReports.push(report);
        if (report.success) {
          log(sessionId, `afterDeleteSession ✓ ${duration}ms (background)`);
          emit(onStep, { step: "afterDeleteSession", status: "done", duration });
        } else {
          log(sessionId, `afterDeleteSession ✗ FAILED (${duration}ms) (background)`);
          emit(onStep, { step: "afterDeleteSession", status: "error", duration, error: "hook failed" });
        }
        return report;
      });
      // Don't await — return early so caller can proceed
      const totalDuration = Date.now() - start;
      log(sessionId, `remove complete ✓ ${totalDuration}ms (hooks running in background)`);
      return {
        sessionId, worktreePath, hookReports, duration: totalDuration,
        backgroundHookPromise: backgroundDeletePromise,
      };
    }

    // Sync mode: await the hook
    const afterReport = await hookEngine.execute("afterDeleteSession", afterCtx);
    hookReports.push(afterReport);
    const afterDuration = Date.now() - afterStepStart;
    if (!afterReport.success) {
      log(sessionId, `afterDeleteSession ✗ FAILED (${afterDuration}ms) — ignored`);
    } else {
      log(sessionId, `afterDeleteSession ✓ ${afterDuration}ms`);
    }
    emit(onStep, { step: "afterDeleteSession", status: afterReport.success ? "done" : "error", duration: afterDuration });

    const totalDuration = Date.now() - start;
    log(sessionId, `remove complete ✓ ${totalDuration}ms`);
    return { sessionId, hookReports, success: true };
  }

  return { create, remove };
}
