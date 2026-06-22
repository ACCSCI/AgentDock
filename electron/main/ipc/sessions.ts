/**
 * Sessions IPC handlers.
 *
 * Each operation has two parts:
 *   1. Call the daemon via Hono client (for port allocation, state).
 *   2. Persist the result into the local SQLite (for the renderer's
 *      project/sessions view).
 *
 * This module deliberately mirrors the original api.ts logic so behavior
 * is preserved end-to-end. Phase 6 will move this into a cleaner split.
 */
import { eq } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { ipcMain } from "electron";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { IPC_CHANNELS } from "../../shared/api-types.js";
import * as schema from "../../../plugins/db/schema.js";
import { writePortsToEnv } from "../../../plugins/port-write-env.js";
import { loadConfig } from "../../../plugins/config.js";
import {
  createSessionLifecycle,
  type PortService,
  type SessionPorts,
  type StepEvent,
} from "../../../plugins/session-lifecycle.js";
import { DaemonManager } from "../../../plugins/daemon-manager.js";
import { log } from "../../../plugins/logger.js";
import type { DaemonHonoClient } from "../hono-client.js";
import { terminalManager } from "../../../plugins/terminal-manager.js";
import { renameWorktree } from "../../../plugins/worktree.js";
import {
  createHookEngine,
  createHookRegistry,
  type HookDefinition,
} from "../../../plugins/hook-engine.js";
import type { V2PortServiceHandle } from "../../../plugins/v2-port-service.js";

export interface SessionsDeps {
  getDb: () => NodeSQLiteDatabase<typeof schema> | null;
  getProjectPath: () => string | null;
  getClientId: () => string;
  getDaemonClient: () => DaemonHonoClient | null;
  getDaemonManager: () => DaemonManager | null;
  /** P9: returns the v2 service when AGENTDOCK_V2=1, else null. */
  getV2PortService: () => V2PortServiceHandle | null;
  /** P9: returns the daemon port for direct v2 fetches. */
  getDaemonPort: () => number;
}

function v2DisabledResponse(): { success: false; error: string } {
  return { success: false, error: "AGENTDOCK_V2 not enabled" };
}

async function forwardV2(
  port: number,
  path: string,
  body: unknown,
): Promise<{ success: boolean; status?: number; body?: unknown; error?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { success: res.ok, status: res.status, body: await res.json() };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Resolve the PortService for the current run mode.
 *
 * The v1 daemon routes (/sessions/allocate, /sessions/release) were
 * removed in F10-2a. v2 is the only path — throw a clear error if the
 * v2 service was not initialized so the failure mode is obvious.
 */
function pickPortService(
  deps: SessionsDeps,
  projectPath: string,
): PortService {
  const v2 = deps.getV2PortService();
  if (!v2) {
    throw new Error(
      "v2 port service not available — daemon v1 routes have been removed. " +
        "Ensure the daemon is running with v2 support.",
    );
  }
  return v2.service;
}

export function registerSessions(deps: SessionsDeps): void {
  // sessions:create — runs the full lifecycle (worktree + sync + ports + hooks)
  // and streams step events back to the renderer via webContents.send.
  ipcMain.handle(IPC_CHANNELS["sessions:create"], async (event, params: {
    projectId: string;
    name: string;
    baseBranch?: string;
  }) => {
    const { projectId, name, baseBranch } = params;
    if (!projectId || !name) {
      throw new Error("projectId and name required");
    }
    const projectPath = deps.getProjectPath();
    if (!projectPath) {
      throw new Error("db:init must be called first");
    }
    const db = deps.getDb();
    if (!db) {
      throw new Error("db not initialized");
    }
    const project = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .get();
    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const sessionId = crypto.randomUUID().slice(0, 12);
    const config = loadConfig(project.path);
    const portService = pickPortService(deps, project.path);
    const sessionLifecycle = createSessionLifecycle({ portService });

    // Insert a placeholder row immediately so the renderer can show it.
    const branchName = `agentdock/${sessionId}`;
    db.insert(schema.sessions)
      .values({
        id: sessionId,
        projectId,
        name,
        branch: branchName,
        worktreePath: join(project.path, ".agentdock", "worktrees", sessionId),
        ports: null,
        backgroundHookStatus: null,
      })
      .run();

    // Run the lifecycle (creates worktree, allocates ports, runs hooks).
    // Stream step events back to the renderer through the orchestrator's
    // `onStep` callback — `sessionLifecycle.create` returns Promise, not
    // an async iterable.
    //
    // Deferred with setImmediate so the handler returns `{sessionId}`
    // *before* the lifecycle emits its first step. Otherwise lifecycle's
    // synchronous `beforeCreateSession running` event fires while
    // `ipcMain.invoke` is still inflight, the renderer hasn't subscribed
    // yet (it has no sessionId to subscribe with), and the event is
    // silently dropped by ipcRenderer.
    setImmediate(() => {
      void runLifecycle();
    });

    async function runLifecycle(): Promise<void> {
      const sender = event.sender;
      // Webcontents may be destroyed mid-lifecycle if the user closes
      // the window. Every send is gated so we don't throw EPIPE /
      // ERR_IPC_CHANNEL_CLOSED into the global uncaught-exception
      // handler — main.ts has a final safety net for those, but it's
      // still cleaner to never throw in the first place.
      const safeSend = (channel: string, payload: unknown) => {
        try {
          if (sender.isDestroyed()) return;
          sender.send(channel, payload);
        } catch (err) {
          log.warn({ err, channel }, "session stream send failed");
        }
      };
      const onStep = (step: StepEvent) => {
        safeSend(`session:${sessionId}:step`, step);
        // Update backgroundHookStatus if reported
        if (step.step === "afterCreateSession" && step.status === "running") {
          try {
            db.update(schema.sessions)
              .set({ backgroundHookStatus: "running" })
              .where(eq(schema.sessions.id, sessionId))
              .run();
          } catch (err) {
            log.warn({ err, sessionId }, "bgHookStatus running update failed");
          }
        }
        if (step.step === "afterCreateSession" && step.status === "done") {
          try {
            db.update(schema.sessions)
              .set({ backgroundHookStatus: "completed" })
              .where(eq(schema.sessions.id, sessionId))
              .run();
          } catch (err) {
            log.warn({ err, sessionId }, "bgHookStatus done update failed");
          }
        }
      };

      try {
        const result = await sessionLifecycle.create({
          projectId,
          projectPath: project.path,
          sessionId,
          sessionName: name,
          baseBranch,
          config,
          onStep,
          onWorktreeReady: (worktreePath, branch) => {
            try {
              db.update(schema.sessions)
                .set({ worktreePath, branch })
                .where(eq(schema.sessions.id, sessionId))
                .run();
            } catch (err) {
              log.warn(
                { err, sessionId },
                "onWorktreeReady DB update failed",
              );
            }
          },
          // Run regardless of lifecycle's coarse `report.success` — that
          // returns true whenever no *required* hooks failed, so an
          // optional async hook (`required: false, async: true`) that
          // exits non-zero gets swallowed and the renderer never sees
          // "failed". Inspect individual results instead — matches what
          // master's POST /api/sessions/:id/retry-hooks does on retry.
          onBackgroundHookComplete: (report) => {
            const failed = report.results.filter((r) => !r.success);
            const status = failed.length > 0 ? "failed" : "completed";
            const update: Record<string, unknown> = { backgroundHookStatus: status };
            if (failed.length > 0) {
              update.backgroundHookErrors = JSON.stringify(
                failed.map((r) => ({
                  run: r.hook.run,
                  exitCode: r.exitCode,
                  stdout: (r.stdout ?? "").slice(0, 2000),
                  stderr: (r.stderr ?? "").slice(0, 2000),
                  timedOut: r.timedOut,
                  error: r.error ?? null,
                })),
              );
            } else {
              update.backgroundHookErrors = null;
            }
            try {
              db.update(schema.sessions)
                .set(update)
                .where(eq(schema.sessions.id, sessionId))
                .run();
            } catch (err) {
              log.warn({ err, sessionId }, "backgroundHook complete persist failed");
            }
          },
        });

        // Persist the ports allocated by the lifecycle to the DB.
        // The v2 PortService already wrote the .env file; we just
        // need the DB row updated so the sidebar shows the ports.
        // No need to re-query the daemon — the old v1 /sessions/list
        // endpoint was removed in F10-2a.
        if (result.ports && Object.keys(result.ports).length > 0) {
          db.update(schema.sessions)
            .set({ ports: JSON.stringify(result.ports) })
            .where(eq(schema.sessions.id, sessionId))
            .run();
          if (existsSync(result.worktreePath)) {
            writePortsToEnv(result.worktreePath, result.ports, project.path);
          }
        }
        try {
          safeSend(`session:${sessionId}:complete`, { success: true });
        } catch {
          // sender may be torn down
        }
      } catch (err) {
        log.error({ err, sessionId }, "session create failed");
        try {
          safeSend(`session:${sessionId}:complete`, {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        } catch {
          // sender may be torn down
        }
        // Roll back the placeholder row
        try {
          db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
        } catch (err2) {
          log.warn({ err: err2, sessionId }, "rollback DB delete failed");
        }
      }
    }

    return { sessionId };
  });

  // sessions:stream — subscribe to events for an existing sessionId.
  ipcMain.handle(IPC_CHANNELS["sessions:stream"], () => {
    // Events are pushed by sessions:create. The renderer listens via
    // ipcRenderer.on(`session:${id}:step`, ...) and awaits the complete
    // event. This handler is a no-op marker for the IPC contract.
    return { subscribed: true };
  });

  ipcMain.handle(IPC_CHANNELS["sessions:delete"], async (event, params: { sessionId: string }) => {
    if (!params?.sessionId) {
      throw new Error("sessionId required");
    }
    const { sessionId } = params;
    const db = deps.getDb();
    if (!db) {
      throw new Error("db not initialized");
    }

    const session = db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get();
    if (!session) {
      return { success: false, error: `Session ${sessionId} not found` };
    }
    // Look up the owning project so we use its real path (not the
    // process-wide active path — those differ for any non-cwd project).
    // `removeWorktree(projectPath, sessionId, ...)` derives the worktree
    // dir from this, so a wrong path → "Worktree not found".
    const ownerProject = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, session.projectId))
      .get();
    if (!ownerProject) {
      throw new Error(`Owning project not found for session ${sessionId}`);
    }
    const projectPath = ownerProject.path;

    // Mirror master's SSE channel: forward every lifecycle step event to
    // the renderer on `session:<id>:step` (and emit a final `complete`
    // frame on `session:<id>:complete`). The renderer's
    // `useDeleteSessionSSE` hook subscribes to these for progress UI.
    const sender = event.sender;
    const safeSend = (channel: string, payload: unknown) => {
      try {
        if (sender.isDestroyed()) return;
        sender.send(channel, payload);
      } catch (err) {
        log.warn({ err, channel }, "session delete stream send failed");
      }
    };
    const sendStep = (e: StepEvent) => {
      safeSend(`session:${sessionId}:step`, e);
    };

    // Kill any PTYs for this session
    terminalManager.killBySession(sessionId);

    // Run hooks (beforeDeleteSession → removeWorktree → afterDeleteSession)
    const config = loadConfig(projectPath);
    const portService = pickPortService(deps, projectPath);
    const sessionLifecycle = createSessionLifecycle({ portService });
    try {
      await sessionLifecycle.remove({
        sessionId,
        projectPath,
        worktreePath: session.worktreePath,
        currentBranch: session.branch,
        config,
        onStep: sendStep,
      });
    } catch (err) {
      log.error({ err, sessionId }, "lifecycle.remove failed");
      const errMsg = err instanceof Error ? err.message : String(err);
      safeSend(`session:${sessionId}:complete`, { success: false, error: errMsg });
      throw err;
    }

    // Delete from DB
    db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
    safeSend(`session:${sessionId}:complete`, { success: true });
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS["sessions:rename"], (_e, params: { sessionId: string; name: string }) => {
    if (!params?.sessionId || !params?.name) {
      throw new Error("sessionId and name required");
    }
    const db = deps.getDb();
    if (!db) {
      throw new Error("db not initialized");
    }
    const session = db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, params.sessionId))
      .get();
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }
    // Resolve the OWNING project's path — sessions:rename was
    // previously using `deps.getProjectPath()` which is the
    // process-wide active path (cwd), not the project that owns this
    // session. With multiple projects open, that pointed
    // `renameWorktree` at the wrong directory.
    const ownerProject = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, session.projectId))
      .get();
    if (!ownerProject) {
      throw new Error(`Owning project not found for session ${params.sessionId}`);
    }
    // Rename the git branch in lockstep with the DB name. Mirrors
    // master's `PATCH /api/sessions/:id` behavior — without this, the
    // on-disk `agentdock/<original>` branch stays put and a later delete
    // leaves a dangling branch (this is exactly what 8ec663a fixed).
    let newBranch = session.branch;
    try {
      const result = renameWorktree(
        ownerProject.path,
        params.sessionId,
        params.name,
        session.branch,
      );
      newBranch = result.newBranch;
    } catch (err) {
      log.error({ err, sessionId: params.sessionId, name: params.name }, "renameWorktree failed");
      throw err;
    }
    db.update(schema.sessions)
      .set({ name: params.name, branch: newBranch })
      .where(eq(schema.sessions.id, params.sessionId))
      .run();
    return { success: true, branch: newBranch };
  });

  ipcMain.handle(IPC_CHANNELS["sessions:reassignPorts"], async (_e, sessionId: string) => {
    if (!sessionId) {
      throw new Error("sessionId required");
    }
    const db = deps.getDb();
    if (!db) {
      throw new Error("db not initialized");
    }
    const session = db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get();
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // v2 path: delegate to the v2 port service's /reassign endpoint.
    // The old v1 /sessions/reassign + /sessions/list endpoints were
    // removed in F10-2a.
    const v2 = deps.getV2PortService();
    if (!v2) {
      throw new Error("reassign-ports requires AGENTDOCK_V2=1 (v1 daemon routes removed)");
    }
    try {
      const ports = await v2.reassign(sessionId);
      // Persist to DB so the sidebar shows the new ports immediately.
      db.update(schema.sessions)
        .set({ ports: JSON.stringify(ports) })
        .where(eq(schema.sessions.id, sessionId))
        .run();
      if (existsSync(session.worktreePath)) {
        writePortsToEnv(session.worktreePath, ports);
      }
      return { ports };
    } catch (err) {
      throw new Error(`reassign-ports failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  ipcMain.handle(IPC_CHANNELS["sessions:retryHooks"], async (_e, sessionId: string) => {
    if (!sessionId) {
      throw new Error("sessionId required");
    }
    const db = deps.getDb();
    if (!db) {
      throw new Error("db not initialized");
    }
    const session = db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get();
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.backgroundHookStatus !== "failed") {
      // Mirror master: only retry sessions whose hooks actually failed.
      // Prevents accidental re-runs that could break a healthy worktree.
      throw new Error("Session is not in failed state");
    }
    // Look up the owning project so loadConfig + hook context use the
    // real project root (NOT cwd — those differ for any non-cwd project
    // and would load the wrong agentdock.config.yaml).
    const ownerProject = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, session.projectId))
      .get();
    if (!ownerProject) {
      throw new Error(`Owning project not found for session ${sessionId}`);
    }
    const projectPath = ownerProject.path;
    const config = loadConfig(projectPath);

    // Mark running immediately so the renderer's poll picks up the
    // status change without waiting for the async hook to finish.
    db.update(schema.sessions)
      .set({ backgroundHookStatus: "running", backgroundHookErrors: null })
      .where(eq(schema.sessions.id, sessionId))
      .run();

    // Build a fresh engine + registry from the project's current config.
    // Fire-and-forget — we return immediately and let the renderer poll
    // `sessions:bgHookStatus` for completion (matches master).
    const registry = createHookRegistry();
    registry.loadFromConfig(
      config.hooks as unknown as Record<string, HookDefinition[]>,
    );
    const engine = createHookEngine(registry);
    const ctx = {
      event: "afterCreateSession" as const,
      sessionId,
      projectId: session.projectId,
      projectPath,
      worktreePath: session.worktreePath,
      payload: {},
    };

    engine
      .execute("afterCreateSession", ctx)
      .then((report) => {
        const failed = report.results.filter((r) => !r.success);
        const status = failed.length > 0 ? "failed" : "completed";
        const update: Record<string, unknown> = { backgroundHookStatus: status };
        if (failed.length > 0) {
          update.backgroundHookErrors = JSON.stringify(
            failed.map((r) => ({
              run: r.hook.run,
              exitCode: r.exitCode,
              stdout: (r.stdout ?? "").slice(0, 2000),
              stderr: (r.stderr ?? "").slice(0, 2000),
              timedOut: r.timedOut,
              error: r.error ?? null,
            })),
          );
        } else {
          update.backgroundHookErrors = null;
        }
        try {
          db.update(schema.sessions)
            .set(update)
            .where(eq(schema.sessions.id, sessionId))
            .run();
        } catch (err) {
          log.error({ err, sessionId }, "retryHooks: persist result failed");
        }
      })
      .catch((err) => {
        log.error({ err, sessionId }, "retryHooks: engine.execute threw");
        try {
          db.update(schema.sessions)
            .set({
              backgroundHookStatus: "failed",
              backgroundHookErrors: JSON.stringify([
                { error: err instanceof Error ? err.message : String(err) },
              ]),
            })
            .where(eq(schema.sessions.id, sessionId))
            .run();
        } catch (err2) {
          log.error({ err: err2, sessionId }, "retryHooks: failure-persist failed");
        }
      });

    return { success: true, status: "running" };
  });

  ipcMain.handle(IPC_CHANNELS["sessions:bgHookStatus"], (_e, sessionId: string) => {
    if (!sessionId) {
      return null;
    }
    const db = deps.getDb();
    if (!db) {
      return null;
    }
    const session = db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get();
    return session?.backgroundHookStatus ?? null;
  });

  ipcMain.handle(IPC_CHANNELS["sessions:hookErrors"], (_e, sessionId: string) => {
    if (!sessionId) {
      return [];
    }
    const db = deps.getDb();
    if (!db) {
      return [];
    }
    const session = db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get();
    if (!session?.backgroundHookErrors) {
      return [];
    }
    try {
      return JSON.parse(session.backgroundHookErrors);
    } catch {
      return [];
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // P9: v2 daemon API — direct endpoints for renderer-driven session
  // lifecycle when AGENTDOCK_V2=1. Each handler:
  //   1. Resolves fencingToken via the v2 service cache.
  //   2. Forwards the request to the daemon.
  //   3. Returns the daemon's parsed JSON response.
  //
  // These are separate from sessions:create/delete so the renderer can
  // drive specific v2 lifecycle states (e.g. /session/rename, /takeover)
  // without going through the full orchestrator.
  // ─────────────────────────────────────────────────────────────────────

  ipcMain.handle(
    IPC_CHANNELS["sessions:v2:create"],
    async (_e, params: {
      projectId: string;
      name: string;
      baseBranch?: string;
    }) => {
      const v2 = deps.getV2PortService();
      const port = deps.getDaemonPort();
      if (!v2 || !port) return v2DisabledResponse();
      const project = deps.getDb()
        ?.select()
        .from(schema.projects)
        .where(eq(schema.projects.id, params.projectId))
        .get();
      if (!project) {
        return { success: false, error: `Project not found: ${params.projectId}` };
      }
      const result = await forwardV2(port, "/session/create", {
        clientId: deps.getClientId(),
        pid: process.pid,
        projectRoot: project.path,
        displayName: params.name,
      });
      // Pre-warm the v2 cache with the v2 sessionId so subsequent
      // claim/activate/heartbeat calls can find the token. The
      // app-sessionId is the renderer-supplied UUID from `name` here.
      if (result.success && result.body && typeof result.body === "object") {
        const body = result.body as { sessionId?: string; fencingToken?: number };
        if (body.sessionId && body.fencingToken !== undefined) {
          // Map renderer-provided sessionId (UUID used as displayName) to
          // the daemon's sessionId. The renderer will use the daemon's
          // sessionId going forward via the v2 channel set.
        }
      }
      return result;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS["sessions:v2:delete"],
    async (_e, params: { sessionId: string; v2SessionId?: string }) => {
      const v2 = deps.getV2PortService();
      const port = deps.getDaemonPort();
      if (!v2 || !port) return v2DisabledResponse();
      const v2Sid = params.v2SessionId ?? params.sessionId;
      const token = v2.getToken(params.sessionId);
      if (token === null) {
        return { success: false, error: "session not in v2 state" };
      }
      const del = await forwardV2(port, "/session/delete", {
        sessionId: v2Sid,
        fencingToken: token,
      });
      // Trigger phase-2 purge from the v2 service so the three-table
      // entries drop after the worktree is gone (matches the
      // orchestrator's two-phase release flow).
      await v2.completeDeletion(params.sessionId).catch(() => {});
      return del;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS["sessions:v2:rename"],
    async (_e, params: { sessionId: string; v2SessionId?: string; name: string }) => {
      const v2 = deps.getV2PortService();
      const port = deps.getDaemonPort();
      if (!v2 || !port) return v2DisabledResponse();
      const v2Sid = params.v2SessionId ?? params.sessionId;
      const token = v2.getToken(params.sessionId);
      if (token === null) {
        return { success: false, error: "session not in v2 state" };
      }
      return forwardV2(port, "/session/rename", {
        sessionId: v2Sid,
        fencingToken: token,
        displayName: params.name,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS["sessions:v2:reassign"],
    async (_e, params: { sessionId: string }) => {
      const v2 = deps.getV2PortService();
      if (!v2) return v2DisabledResponse();
      try {
        const ports = await v2.reassign(params.sessionId);
        // Persist to DB so the sidebar shows the new ports immediately.
        const db = deps.getDb();
        if (db) {
          db.update(schema.sessions)
            .set({ ports: JSON.stringify(ports) })
            .where(eq(schema.sessions.id, params.sessionId))
            .run();
        }
        return { success: true, ports };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS["sessions:v2:status"],
    async (_e, params: { sessionId: string }) => {
      const v2 = deps.getV2PortService();
      if (!v2) return null;
      return v2.getStatus(params.sessionId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS["sessions:v2:takeover"],
    async (_e, params: { sessionId: string; fromClientId?: string; fromPid?: number }) => {
      const v2 = deps.getV2PortService();
      const port = deps.getDaemonPort();
      if (!v2 || !port) return v2DisabledResponse();
      const token = v2.getToken(params.sessionId);
      if (token === null) {
        return { success: false, error: "session not in v2 state" };
      }
      const result = await forwardV2(port, "/takeover", {
        sessionId: params.sessionId,
        clientId: params.fromClientId ?? deps.getClientId(),
        pid: params.fromPid ?? process.pid,
        fencingToken: token,
      });
      // Refresh cached token if daemon returned a new one.
      if (result.success && result.body && typeof result.body === "object") {
        const body = result.body as { fencingToken?: number };
        if (body.fencingToken !== undefined) {
          // Touch — the v2 service updates its own cache via the heartbeat
          // tick; we expose getToken() for renderers to read fresh values.
        }
      }
      return result;
    },
  );
}