/**
 * IPC registration entry point — called once at app startup.
 *
 * Aggregates all per-resource handler modules into a single
 * `registerAllIpc(deps)` function. Keeps `electron/main.ts` clean and
 * makes the full IPC surface discoverable from one file.
 *
 * Single-instance architecture: no daemon, no SSE, no v2 service.
 */
import { registerDb, type DbContext } from "./db.js";
import { registerSessions, type SessionsDeps } from "./sessions.js";
import { registerTerminals } from "./terminals.js";
import { registerFsAndConfig } from "./fs-config.js";
import { registerWorktreeAndShell } from "./worktree-shell.js";
import { registerGit } from "./git.js";
import { registerTodos } from "./todos.js";
import { registerBootstrap, type BootstrapDeps } from "../bootstrap.js";
import { registerApp } from "./app.js";
import { getActiveDb, type DrizzleDb } from "../../../plugins/db/index.js";
import type { SessionManager } from "../session-manager.js";

export interface AllIpcDeps {
  getProjectPath: () => string | null;
  setProjectPath: (path: string) => void;
  getSessionManager: () => SessionManager | null;
  /** Global projects DB (machine-level, not per-project). Needed by fs-config and worktree-shell. */
  getGlobalDb: () => DrizzleDb | null;
  isViteReady: () => Promise<boolean>;
  countHandlers: () => number;
}

export function registerAllIpc(deps: AllIpcDeps): void {
  // Bootstrap (simplified — no daemon channels)
  const bootstrapDeps: BootstrapDeps = {
    isViteReady: deps.isViteReady,
    countHandlers: deps.countHandlers,
  };
  registerBootstrap(bootstrapDeps);

  // DB + sync (simplified — no daemon, no v2 port service)
  const dbCtx: DbContext = {
    getProjectPath: deps.getProjectPath,
    setProjectPath: deps.setProjectPath,
    getGlobalDb: deps.getGlobalDb,
    getSessionManager: deps.getSessionManager,
  };
  registerDb(dbCtx);

  // Sessions (simplified — uses SessionManager directly)
  const sessionsDeps: SessionsDeps = {
    getDb: () => getActiveDb(),
    getProjectPath: deps.getProjectPath,
    getSessionManager: deps.getSessionManager,
    getGlobalDb: deps.getGlobalDb,
  };
  registerSessions(sessionsDeps);

  // Terminals (5 channels: create, list, rename, delete, open)
  registerTerminals();

  // FS + Config (4 channels)
  registerFsAndConfig(deps.getProjectPath, deps.getGlobalDb);

  // Worktree + Shell (4 channels)
  registerWorktreeAndShell(deps.getProjectPath, deps.getGlobalDb);

  // Git (2 channels: isRepo, init) — self-contained, no deps required.
  registerGit();

  // Todos (5 channels: list, create, toggle, update, delete)
  registerTodos();

  // App (3 channels: version, checkForUpdates, quitAndInstall) —
  // self-contained, no deps required.
  registerApp();
}
