import { existsSync } from "node:fs";
import type { AgentDockConfig, HookLifecycleEvent } from "./config.js";
import {
  createHookEngine,
  createHookRegistry,
  type HookContext,
  type HookReport,
} from "./hook-engine.js";
import {
  assignSessionPorts,
  releaseSessionPorts,
  type SessionPorts,
} from "./port-registry.js";
import {
  createResourceSyncService,
  type SyncReport,
} from "./resource-sync.js";
import {
  createWorktree,
  getWorktreePath,
  removeWorktree,
} from "./worktree.js";

// --- Input/Output types ---
export interface CreateSessionInput {
  projectId: string;
  projectPath: string;
  sessionId: string;
  sessionName: string;
  baseBranch?: string;
  config: AgentDockConfig;
}

export interface CreateSessionResult {
  sessionId: string;
  worktreePath: string;
  branch: string;
  ports: SessionPorts;
  syncReport: SyncReport;
  hookReports: HookReport[];
  duration: number;
}

export interface DeleteSessionInput {
  sessionId: string;
  projectPath: string;
  worktreePath: string;
  config: AgentDockConfig;
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
  globalExcludedPorts?: Set<number>;
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

  async function create(input: CreateSessionInput): Promise<CreateSessionResult> {
    const start = Date.now();
    const { projectId, projectPath, sessionId, sessionName, baseBranch, config } = input;
    const hookReports: HookReport[] = [];

    // Load hooks from config
    hookRegistry.loadFromConfig(config.hooks as Record<string, import("./config.js").HookDefinition[]>);

    const worktreePath = getWorktreePath(projectPath, sessionId);

    // Step 1: BeforeCreateSession hooks
    const beforeCtx = buildHookContext("beforeCreateSession", { projectId, sessionId, projectPath, worktreePath });
    const beforeReport = await hookEngine.execute("beforeCreateSession", beforeCtx);
    hookReports.push(beforeReport);
    if (!beforeReport.success) {
      throw new Error("beforeCreateSession hook failed (required)");
    }

    // Step 2: CreateWorktree (Core)
    const wt = createWorktree(projectPath, sessionId, baseBranch);

    try {
      // Step 3: SyncResources (Core)
      const syncReport = await resourceSyncService.syncAll(
        projectPath,
        wt.worktreePath,
        config.resources.sync,
      );

      // Step 4: AllocatePorts (Core) — also writes ports to .env (PatchRuntimeConfig)
      const ports = await assignSessionPorts(
        projectPath,
        sessionId,
        wt.worktreePath,
        deps?.globalExcludedPorts,
      );

      // Step 6: AfterCreateSession hooks
      const afterCtx = buildHookContext("afterCreateSession", { projectId, sessionId, projectPath, worktreePath: wt.worktreePath });
      const afterReport = await hookEngine.execute("afterCreateSession", afterCtx);
      hookReports.push(afterReport);

      if (!afterReport.success) {
        // Rollback: release ports + remove worktree
        try { releaseSessionPorts(projectPath, sessionId); } catch {}
        try { removeWorktree(projectPath, sessionId, true); } catch {}
        throw new Error("afterCreateSession hook failed (required)");
      }

      return {
        sessionId,
        worktreePath: wt.worktreePath,
        branch: wt.branch,
        ports,
        syncReport,
        hookReports,
        duration: Date.now() - start,
      };
    } catch (err) {
      // If anything fails after worktree creation, clean up the worktree
      try { removeWorktree(projectPath, sessionId, true); } catch {}
      throw err;
    }
  }

  async function remove(input: DeleteSessionInput): Promise<DeleteSessionResult> {
    const { sessionId, projectPath, worktreePath, config } = input;
    const hookReports: HookReport[] = [];

    // Load hooks from config
    hookRegistry.loadFromConfig(config.hooks as Record<string, import("./config.js").HookDefinition[]>);

    // Step 1: BeforeDeleteSession hooks
    const beforeCtx = buildHookContext("beforeDeleteSession", {
      projectId: "", sessionId, projectPath, worktreePath,
    });
    const beforeReport = await hookEngine.execute("beforeDeleteSession", beforeCtx);
    hookReports.push(beforeReport);

    if (!beforeReport.success) {
      throw new Error("beforeDeleteSession hook failed (required)");
    }

    // Step 2: ReleasePorts (Core)
    releaseSessionPorts(projectPath, sessionId);

    // Step 3: RemoveWorktree (Core)
    if (existsSync(worktreePath)) {
      removeWorktree(projectPath, sessionId, true);
    }

    // Step 4: AfterDeleteSession hooks — failure doesn't affect result
    const afterCtx = buildHookContext("afterDeleteSession", {
      projectId: "", sessionId, projectPath, worktreePath,
    });
    const afterReport = await hookEngine.execute("afterDeleteSession", afterCtx);
    hookReports.push(afterReport);

    return {
      sessionId,
      hookReports,
      success: true,
    };
  }

  return { create, remove };
}
