import { existsSync } from "node:fs";
import { join } from "node:path";
/**
 * Sessions IPC handlers — single-instance architecture.
 *
 * Uses SessionManager directly for port allocation (no daemon HTTP).
 * Lifecycle (worktree + hooks) is unchanged — only the PortService impl is swapped.
 */
import { eq } from "drizzle-orm";
import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { ipcMain } from "electron";
import { type HookDefinition, loadConfig } from "../../../plugins/config.js";
import * as schema from "../../../plugins/db/schema.js";
import { createHookEngine, createHookRegistry } from "../../../plugins/hook-engine.js";
import { log } from "../../../plugins/logger.js";
import { writePortsToEnv } from "../../../plugins/port-write-env.js";
import {
  type PortService,
  type StepEvent,
  createSessionLifecycle,
} from "../../../plugins/session-lifecycle.js";
import { terminalManager } from "../../../plugins/terminal-manager.js";
import { renameWorktree } from "../../../plugins/worktree.js";
import { IPC_CHANNELS } from "../../shared/api-types.js";
import type { SessionManager } from "../session-manager.js";

export interface SessionsDeps {
  getDb: () => NodeSQLiteDatabase<typeof schema> | null;
  getProjectPath: () => string | null;
  getSessionManager: () => SessionManager | null;
  getGlobalDb?: () => import("../../../plugins/db/index.js").DrizzleDb | null;
}

/**
 * Adapter: wraps SessionManager as the PortService interface expected by
 * createSessionLifecycle. This lets us keep the lifecycle logic intact
 * while swapping out the daemon HTTP calls for direct function calls.
 */
function createSessionManagerPortService(
  sessionManager: SessionManager,
  projectPath: string,
): PortService {
  return {
    async allocateSession(params) {
      return sessionManager.createSession({
        sessionId: params.sessionId,
        projectPath,
        portKeys: params.portKeys ?? [
          "FRONTEND_PORT",
          "BACKEND_PORT",
          "WS_PORT",
          "DEBUG_PORT",
          "PREVIEW_PORT",
        ],
        displayName: params.displayName ?? params.sessionId,
      });
    },
    async releaseSession(sessionId) {
      await sessionManager.releaseSession(sessionId);
    },
  };
}

export function registerSessions(deps: SessionsDeps): void {
  // sessions:create — runs the full lifecycle (worktree + sync + ports + hooks)
  ipcMain.handle(
    IPC_CHANNELS["sessions:create"],
    async (
      event,
      params: {
        projectId: string;
        name: string;
        baseBranch?: string;
      },
    ) => {
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
      const sessionManager = deps.getSessionManager();
      if (!sessionManager) {
        throw new Error("SessionManager not initialized");
      }
      const activeProjectPath = projectPath;
      const activeSessionManager = sessionManager;

      // Resolve project from global DB
      // For now, use a simple project lookup — the global DB might not be
      // the same as the per-project DB in the single-DB architecture.
      // We'll use the projectPath to derive what we need.
      const sessionId = crypto.randomUUID().slice(0, 12);
      const config = loadConfig(projectPath);
      const portService = createSessionManagerPortService(sessionManager, projectPath);
      const sessionLifecycle = createSessionLifecycle({ portService });

      // Insert a placeholder row immediately so the renderer can show it.
      const branchName = `agentdock/${sessionId}`;
      db.insert(schema.sessions)
        .values({
          id: sessionId,
          projectId,
          name,
          branch: branchName,
          worktreePath: join(projectPath, ".agentdock", "worktrees", sessionId),
          ports: null,
          backgroundHookStatus: null,
          status: "creating",
          steps: "[]",
        })
        .run();

      // Run the lifecycle (creates worktree, allocates ports, runs hooks).
      setImmediate(() => {
        void runLifecycle();
      });

      async function runLifecycle(): Promise<void> {
        const sender = event.sender;
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

          // Persist step progress to DB so frontend can query it
          try {
            const freshDb = deps.getDb();
            if (freshDb) {
              // Read current steps, append new step, write back
              const row = freshDb
                .select({ steps: schema.sessions.steps })
                .from(schema.sessions)
                .where(eq(schema.sessions.id, sessionId))
                .get();
              // Defensive parse — a corrupted steps blob shouldn't kill the
              // step-update loop (matches db.ts:322 defensive parsing).
              let curSteps: StepEvent[] = [];
              if (row?.steps) {
                try {
                  curSteps = JSON.parse(row.steps);
                } catch (err) {
                  log.warn({ err, sessionId }, "failed to parse session steps from DB");
                }
              }
              const idx = curSteps.findIndex((s) => s.step === step.step);
              if (idx >= 0) {
                curSteps[idx] = step;
              } else {
                curSteps.push(step);
              }
              freshDb
                .update(schema.sessions)
                .set({ steps: JSON.stringify(curSteps) })
                .where(eq(schema.sessions.id, sessionId))
                .run();
            }
          } catch (err) {
            log.warn({ err, sessionId }, "step persist failed");
          }

          if (step.step === "afterCreateSession" && step.status === "running") {
            try {
              const freshDb = deps.getDb();
              if (freshDb) {
                freshDb
                  .update(schema.sessions)
                  .set({ backgroundHookStatus: "running" })
                  .where(eq(schema.sessions.id, sessionId))
                  .run();
              }
            } catch (err) {
              log.warn({ err, sessionId }, "bgHookStatus running update failed");
            }
          }
          if (step.step === "afterCreateSession" && step.status === "done") {
            try {
              const freshDb = deps.getDb();
              if (freshDb) {
                freshDb
                  .update(schema.sessions)
                  .set({ backgroundHookStatus: "completed" })
                  .where(eq(schema.sessions.id, sessionId))
                  .run();
              }
            } catch (err) {
              log.warn({ err, sessionId }, "bgHookStatus done update failed");
            }
          }
        };

        try {
          const result = await sessionLifecycle.create({
            projectId,
            projectPath: activeProjectPath,
            sessionId,
            sessionName: name,
            baseBranch,
            config,
            onStep,
            onWorktreeReady: (worktreePath, branch) => {
              try {
                // Get fresh DB reference in case it was reset
                const freshDb = deps.getDb();
                if (freshDb) {
                  freshDb
                    .update(schema.sessions)
                    .set({ worktreePath, branch })
                    .where(eq(schema.sessions.id, sessionId))
                    .run();
                }
              } catch (err) {
                log.warn({ err, sessionId }, "onWorktreeReady DB update failed");
              }
            },
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
              // Set status to "active" — async hooks completed
              update.status = "active";
              try {
                // Get fresh DB reference
                const freshDb = deps.getDb();
                if (freshDb) {
                  freshDb
                    .update(schema.sessions)
                    .set(update)
                    .where(eq(schema.sessions.id, sessionId))
                    .run();
                }
              } catch (err) {
                log.warn({ err, sessionId }, "backgroundHook complete persist failed");
              }
              // Send complete event to renderer
              try {
                safeSend(`session:${sessionId}:complete`, { success: true, sessionId });
              } catch {
                /* ignore */
              }
            },
          });

          // Persist the ports allocated by the lifecycle to the DB.
          if (result.ports && Object.keys(result.ports).length > 0) {
            const freshDb = deps.getDb();
            if (freshDb) {
              freshDb
                .update(schema.sessions)
                .set({ ports: JSON.stringify(result.ports) })
                .where(eq(schema.sessions.id, sessionId))
                .run();
            }
            if (existsSync(result.worktreePath)) {
              writePortsToEnv(result.worktreePath, result.ports, activeProjectPath);
            }
          }
          // If no async hooks, set status to "active" and send complete
          try {
            const freshDb = deps.getDb();
            if (freshDb) {
              freshDb
                .update(schema.sessions)
                .set({ status: "active" })
                .where(eq(schema.sessions.id, sessionId))
                .run();
            }
          } catch (err) {
            log.warn({ err, sessionId }, "status=active update failed");
          }
          // Activate session in SessionManager
          activeSessionManager.activateSession(sessionId);

          // DON'T send complete event here. For async hooks, it'll be sent
          // by onBackgroundHookComplete when hooks finish. For sync mode,
          // send it via process.nextTick so the IPC return happens first.
          if (!result.backgroundHookPromise) {
            process.nextTick(() => {
              try {
                safeSend(`session:${sessionId}:complete`, { success: true, sessionId });
              } catch {
                /* ignore */
              }
            });
          }

          // For async hooks: fire-and-forget, onBackgroundHookComplete will
          // send the complete event + set status="active".
          if (result.backgroundHookPromise) {
            result.backgroundHookPromise.catch((err) => {
              log.warn({ err, sessionId }, "background hook failed (non-fatal)");
            });
          }
        } catch (err) {
          log.error({ err, sessionId }, "session create failed");
          process.nextTick(() => {
            try {
              safeSend(`session:${sessionId}:complete`, {
                success: false,
                error: err instanceof Error ? err.message : String(err),
              });
            } catch {
              /* ignore */
            }
          });
          // Roll back the placeholder row
          try {
            const freshDb = deps.getDb();
            if (freshDb) {
              freshDb.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
            }
          } catch (err2) {
            log.warn({ err: err2, sessionId }, "rollback DB delete failed");
          }
        }
      }

      return { sessionId };
    },
  );

  // sessions:stream — subscribe to events for an existing sessionId.
  ipcMain.handle(IPC_CHANNELS["sessions:stream"], () => {
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
    const sessionManager = deps.getSessionManager();
    if (!sessionManager) {
      throw new Error("SessionManager not initialized");
    }

    const session = db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get();
    if (!session) {
      return { success: false, error: `Session ${sessionId} not found` };
    }

    // Look up the owning project from the active DB
    const ownerProject = db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, session.projectId))
      .get();

    // Set status to "deleting" before starting lifecycle
    db.update(schema.sessions)
      .set({ status: "deleting", steps: "[]" })
      .where(eq(schema.sessions.id, sessionId))
      .run();

    if (!ownerProject) {
      // Fallback: check global DB
      const globalDb = deps.getGlobalDb?.();
      const globalProject = globalDb
        ?.select()
        .from(schema.projects)
        .where(eq(schema.projects.id, session.projectId))
        .get();
      if (!globalProject) {
        throw new Error(`Owning project not found for session ${sessionId}`);
      }
      // Use global project path — run lifecycle async
      const projectPath = globalProject.path;
      const sender = event.sender;
      const safeSend = (channel: string, payload: unknown) => {
        try {
          if (sender.isDestroyed()) return;
          sender.send(channel, payload);
        } catch (err) {
          log.warn({ err, channel }, "session delete stream send failed");
        }
      };

      setImmediate(async () => {
        try {
          const config = loadConfig(projectPath);
          const portService = createSessionManagerPortService(sessionManager, projectPath);
          const sessionLifecycle = createSessionLifecycle({ portService });
          const sendStep = (e: StepEvent) => safeSend(`session:${sessionId}:step`, e);
          const result = await sessionLifecycle.remove({
            sessionId,
            projectPath,
            worktreePath: session.worktreePath,
            currentBranch: session.branch,
            config,
            onStep: sendStep,
            onBeforeCoreDelete: () => terminalManager.killBySession(sessionId),
          });
          if (result.backgroundHookPromise) {
            await result.backgroundHookPromise;
          }
          try {
            const freshDb = deps.getDb();
            if (freshDb) {
              freshDb.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
            }
          } catch (err) {
            log.warn({ err, sessionId }, "delete DB cleanup failed");
          }
          try {
            safeSend(`session:${sessionId}:complete`, { success: true });
          } catch {
            /* ignore */
          }
        } catch (err) {
          log.error({ err, sessionId }, "lifecycle.remove failed");
          try {
            safeSend(`session:${sessionId}:complete`, {
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          } catch {
            /* ignore */
          }
          try {
            const freshDb = deps.getDb();
            if (freshDb) {
              freshDb
                .update(schema.sessions)
                .set({ status: "active" })
                .where(eq(schema.sessions.id, sessionId))
                .run();
            }
          } catch (err2) {
            log.warn({ err: err2, sessionId }, "rollback status update failed");
          }
        }
      });
      return { success: true };
    }
    const projectPath = ownerProject.path;

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

    // Run the lifecycle asynchronously so the IPC returns immediately.
    // The renderer invalidatesQueries after receiving the response and
    // sees status="deleting" in the DB while the lifecycle runs.
    setImmediate(async () => {
      try {
        // Run hooks (beforeDeleteSession → removeWorktree → afterDeleteSession)
        const config = loadConfig(projectPath);
        const portService = createSessionManagerPortService(sessionManager, projectPath);
        const sessionLifecycle = createSessionLifecycle({ portService });
        const result = await sessionLifecycle.remove({
          sessionId,
          projectPath,
          worktreePath: session.worktreePath,
          currentBranch: session.branch,
          config,
          onStep: sendStep,
          onBeforeCoreDelete: () => terminalManager.killBySession(sessionId),
        });

        // Wait for async hooks if any, then delete DB row
        if (result.backgroundHookPromise) {
          await result.backgroundHookPromise;
        }

        // Delete from DB
        try {
          const freshDb = deps.getDb();
          if (freshDb) {
            freshDb.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
          }
        } catch (err) {
          log.warn({ err, sessionId }, "Failed to delete session from DB (non-fatal)");
        }
        try {
          safeSend(`session:${sessionId}:complete`, { success: true });
        } catch {
          /* ignore */
        }
      } catch (err) {
        log.error({ err, sessionId }, "lifecycle.remove failed");
        try {
          safeSend(`session:${sessionId}:complete`, {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        } catch {
          /* ignore */
        }
        // Roll back the deleting status
        try {
          const freshDb = deps.getDb();
          if (freshDb) {
            freshDb
              .update(schema.sessions)
              .set({ status: "active" })
              .where(eq(schema.sessions.id, sessionId))
              .run();
          }
        } catch (err2) {
          log.warn({ err: err2, sessionId }, "rollback status update failed");
        }
      }
    });

    return { success: true };
  });

  ipcMain.handle(
    IPC_CHANNELS["sessions:rename"],
    (_e, params: { sessionId: string; name: string }) => {
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
      const globalDb = deps.getGlobalDb?.();
      const ownerProject = globalDb
        ?.select()
        .from(schema.projects)
        .where(eq(schema.projects.id, session.projectId))
        .get();
      if (!ownerProject) {
        throw new Error(`Owning project not found for session ${params.sessionId}`);
      }
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
    },
  );

  ipcMain.handle(IPC_CHANNELS["sessions:reassignPorts"], async (_e, sessionId: string) => {
    if (!sessionId) {
      throw new Error("sessionId required");
    }
    const db = deps.getDb();
    if (!db) {
      throw new Error("db not initialized");
    }
    const sessionManager = deps.getSessionManager();
    if (!sessionManager) {
      throw new Error("SessionManager not initialized");
    }
    const session = db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get();
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const previousPorts = sessionManager.getSession(sessionId)?.ports;
    try {
      const ports = await sessionManager.reassignPorts(sessionId);
      try {
        db.update(schema.sessions)
          .set({ ports: JSON.stringify(ports) })
          .where(eq(schema.sessions.id, sessionId))
          .run();
        if (existsSync(session.worktreePath)) {
          writePortsToEnv(session.worktreePath, ports);
        }
      } catch (persistError) {
        if (previousPorts) {
          sessionManager.restorePorts(sessionId, previousPorts);
          db.update(schema.sessions)
            .set({ ports: JSON.stringify(previousPorts) })
            .where(eq(schema.sessions.id, sessionId))
            .run();
          if (existsSync(session.worktreePath)) {
            writePortsToEnv(session.worktreePath, previousPorts);
          }
        }
        throw persistError;
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
      throw new Error("Session is not in failed state");
    }
    const globalDb = deps.getGlobalDb?.();
    const ownerProject = globalDb
      ?.select()
      .from(schema.projects)
      .where(eq(schema.projects.id, session.projectId))
      .get();
    if (!ownerProject) {
      throw new Error(`Owning project not found for session ${sessionId}`);
    }
    const projectPath = ownerProject.path;
    const config = loadConfig(projectPath);

    db.update(schema.sessions)
      .set({ backgroundHookStatus: "running", backgroundHookErrors: null })
      .where(eq(schema.sessions.id, sessionId))
      .run();

    const registry = createHookRegistry();
    registry.loadFromConfig(config.hooks as unknown as Record<string, HookDefinition[]>);
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
          db.update(schema.sessions).set(update).where(eq(schema.sessions.id, sessionId)).run();
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

  ipcMain.handle(
    IPC_CHANNELS["sessions:setUserStatus"],
    (_e, params: { sessionId: string; status: string | null }) => {
      if (!params?.sessionId) throw new Error("sessionId required");
      const VALID_STATUSES = ["draft", "plan", "working", "pr", "verifying", "done"];
      if (params.status !== null && !VALID_STATUSES.includes(params.status)) {
        throw new Error(`Invalid status: ${params.status}`);
      }
      const db = deps.getDb();
      if (!db) throw new Error("db not initialized");
      const session = db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, params.sessionId))
        .get();
      if (!session) throw new Error(`Session not found: ${params.sessionId}`);
      db.update(schema.sessions)
        .set({ userStatus: params.status })
        .where(eq(schema.sessions.id, params.sessionId))
        .run();
      return { success: true as const };
    },
  );

  ipcMain.handle(IPC_CHANNELS["sessions:activate"], (_e, params: { sessionId: string }) => {
    if (!params?.sessionId) throw new Error("sessionId required");
    const db = deps.getDb();
    if (!db) throw new Error("db not initialized");
    const session = db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, params.sessionId))
      .get();
    if (!session) throw new Error(`Session not found: ${params.sessionId}`);
    db.update(schema.sessions)
      .set({ lastActivatedAt: new Date().toISOString() })
      .where(eq(schema.sessions.id, params.sessionId))
      .run();
    return { success: true as const };
  });
}
