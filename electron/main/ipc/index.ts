/**
 * IPC registration entry point — called once at app startup.
 *
 * Aggregates all per-resource handler modules into a single
 * `registerAllIpc(deps)` function. Keeps `electron/main.ts` clean and
 * makes the full IPC surface discoverable from one file.
 */
import { registerDb, type DbContext } from "./db.js";
import { registerSessions, type SessionsDeps } from "./sessions.js";
import { registerTerminals } from "./terminals.js";
import { registerFsAndConfig } from "./fs-config.js";
import { registerWorktreeAndShell } from "./worktree-shell.js";
import { registerTodos } from "./todos.js";
import { registerBootstrap, type BootstrapDeps } from "../bootstrap.js";
import { getActiveDb } from "../../../plugins/db/index.js";
import type { DaemonHonoClient } from "../hono-client.js";
import type { DaemonManager } from "../../../plugins/daemon-manager.js";
import type { V2PortServiceHandle } from "../../../plugins/v2-port-service.js";
import type { SseConsumer } from "../v2-sse-consumer.js";

export interface AllIpcDeps {
  getDaemonClient: () => DaemonHonoClient | null;
  getDaemonManager: () => DaemonManager | null;
  getClientId: () => string;
  getProjectPath: () => string | null;
  setProjectPath: (path: string) => void;
  /** Returns the port the running daemon listens on (0 if none). */
  getDaemonPort: () => number;
  drainReallocated: () => Array<{
    sessionId: string;
    oldPorts: Record<string, number>;
    newPorts: Record<string, number>;
  }>;
  getSessionStatus: (sessionId: string) => string;
  setSessionStatus: (sessionId: string, status: string) => void;
  clearSessionStatuses: () => void;
  isViteReady: () => Promise<boolean>;
  isDaemonReady: () => Promise<boolean>;
  countHandlers: () => number;
  /** P9: v2 service when AGENTDOCK_V2=1, else null. */
  getV2PortService: () => V2PortServiceHandle | null;
  /** P9: SSE consumer when AGENTDOCK_V2=1, else null. */
  getSseConsumer: () => SseConsumer | null;
  /** P9: true when AGENTDOCK_V2=1. */
  isV2Enabled: () => boolean;
}

export function registerAllIpc(deps: AllIpcDeps): void {
  // Bootstrap (3 channels: health, reallocated, clientId + 3 daemon channels:
  // daemon:health, daemon:debugState, daemon:faultInject + P9 daemon:events:subscribe
  // + bootstrap:v2Enabled — 新架构 §13.1/§11.2/P9)
  const bootstrapDeps: BootstrapDeps = {
    isDaemonReady: deps.isDaemonReady,
    isViteReady: deps.isViteReady,
    countHandlers: deps.countHandlers,
    drainReallocated: deps.drainReallocated,
    getClientId: deps.getClientId,
    getDaemonManager: deps.getDaemonManager,
    getDaemonPort: deps.getDaemonPort,
    getSseConsumer: deps.getSseConsumer,
    getSseLastSeq: deps.getSseLastSeq,
    isV2Enabled: deps.isV2Enabled,
  };
  registerBootstrap(bootstrapDeps);

  // DB + sync (6 channels: init, projects:list/create/delete, sessions:reorder,
  // sync:project). registerDb owns the disk-sync + daemon port reconcile
  // mirror of master's `GET /api/projects` and the worktree+port cleanup
  // mirror of master's `DELETE /api/projects/:id`.
  const dbCtx: DbContext = {
    getProjectPath: deps.getProjectPath,
    setProjectPath: deps.setProjectPath,
    getClientId: deps.getClientId,
    getSessionStatus: deps.getSessionStatus,
    setSessionStatus: deps.setSessionStatus,
    clearSessionStatuses: deps.clearSessionStatuses,
    getV2PortService: deps.getV2PortService,
    getDaemonPort: deps.getDaemonPort,
  };
  registerDb(dbCtx);

  // Sessions (8 channels + P9 v2 channels). `getDb()` resolves the singleton
  // populated by `db:init` / lazy access through `db:projects:*` — both
  // reach the same active Drizzle handle via plugins/db/index.ts.
  const sessionsDeps: SessionsDeps = {
    getDb: () => getActiveDb(),
    getProjectPath: deps.getProjectPath,
    getClientId: deps.getClientId,
    getDaemonClient: deps.getDaemonClient,
    getDaemonManager: deps.getDaemonManager,
    getV2PortService: deps.getV2PortService,
    getDaemonPort: deps.getDaemonPort,
  };
  registerSessions(sessionsDeps);

  // Terminals (5 channels: create, list, rename, delete, open)
  registerTerminals();

  // FS + Config (4 channels)
  registerFsAndConfig(deps.getProjectPath);

  // Worktree + Shell (4 channels)
  registerWorktreeAndShell(deps.getProjectPath);

  // Todos (5 channels: list, create, toggle, update, delete)
  registerTodos();
}