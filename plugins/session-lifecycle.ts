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
  }): Promise<SessionPorts>;
  releaseSession(sessionId: string): Promise<void>;
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
    console.log(`[SessionLifecycle] ${sessionId} → ${msg}`);
  }

  function emit(onStep: ((e: StepEvent) => void) | undefined, event: StepEvent) {
    onStep?.(event);
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
      const ports = await deps.portService.allocateSession({ sessionId, projectPath, worktreePath: wt.worktreePath, portKeys });
      writePortsToEnv(wt.worktreePath, ports);
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
        emit(onStep, { step: "afterCreateSession", status: "error", duration: afterDuration, error: "hook failed (required)" });
        log(sessionId, "ROLLBACK: releasing ports + removing worktree");
        try {
          if (deps?.portService) {
            await deps.portService.releaseSession(sessionId);
          }
        } catch (e) { log(sessionId, `  rollback releasePorts failed: ${e}`); }
        try { await removeWorktree(projectPath, sessionId, true); } catch (e) { log(sessionId, `  rollback removeWorktree failed: ${e}`); }
        throw new Error("afterCreateSession hook failed (required)");
      }
      log(sessionId, `afterCreateSession ✓ ${afterDuration}ms`);
      emit(onStep, { step: "afterCreateSession", status: "done", duration: afterDuration });

      const totalDuration = Date.now() - start;
      log(sessionId, `create complete ✓ ${totalDuration}ms`);
      return {
        sessionId, worktreePath: wt.worktreePath, branch: wt.branch, ports, syncReport,
        hookReports, duration: totalDuration, backgroundHookPromise: Promise.resolve(afterReport),
      };
    } catch (err) {
      log(sessionId, "ROLLBACK: releasing ports + removing worktree");
      try {
        if (deps?.portService) {
          await deps.portService.releaseSession(sessionId);
        }
      } catch (e) { log(sessionId, `  rollback releasePorts failed: ${e}`); }
      try { await removeWorktree(projectPath, sessionId, true); } catch (e) { log(sessionId, `  rollback removeWorktree failed: ${e}`); }
      throw err;
    }
  }

  async function remove(input: DeleteSessionInput): Promise<DeleteSessionResult> {
    const { sessionId, projectPath, worktreePath, config, onStep } = input;
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
    if (existsSync(worktreePath)) {
      await removeWorktree(projectPath, sessionId, true);
    }
    const wtDuration = Date.now() - wtStepStart;
    log(sessionId, `removeWorktree ✓ ${wtDuration}ms`);
    emit(onStep, { step: "removeWorktree", status: "done", duration: wtDuration });

    // Step 4: AfterDeleteSession hooks — failure doesn't affect result
    emit(onStep, { step: "afterDeleteSession", status: "running" });
    const afterStepStart = Date.now();
    const afterCtx = buildHookContext("afterDeleteSession", { projectId: "", sessionId, projectPath, worktreePath });
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
