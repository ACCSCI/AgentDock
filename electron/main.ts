/**
 * Electron Main Process Entry
 *
 * Phase 3: full implementation.
 *
 * Responsibilities:
 *   1. Spawn the daemon (Hono server) as a child process
 *   2. Connect a typed Hono client to it
 *   3. Register all IPC handlers (Phase 3 ships bootstrap; Phase 4 adds the rest)
 *   4. Create the BrowserWindow and load the renderer
 *   5. Handle lifecycle (before-quit cleanup, before-quit→exit, etc.)
 *
 * Dev mode: electron-vite injects ELECTRON_RENDERER_URL pointing at the
 * Vite dev server. We loadURL it once it's ready.
 *
 * Prod mode: loadFile from the renderer dist (dist/index.html).
 */
import { app, BrowserWindow, ipcMain, protocol } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { sql } from "drizzle-orm";
import { generateClientId } from "./main/client-id.js";
import { DaemonManager } from "../plugins/daemon-manager.js";
import { createDaemonClient, type DaemonHonoClient } from "./main/hono-client.js";
import { IPC_CHANNEL_COUNT } from "./shared/api-types.js";
import { registerAllIpc, type AllIpcDeps } from "./main/ipc/index.js";
import { syncProject } from "./main/ipc/db.js";
import { log } from "../plugins/logger.js";
import { getDbPath } from "../plugins/db/index.js";
import { openGlobalDb, migrateProjectsToGlobal } from "../plugins/db/global.js";
import * as schema from "../plugins/db/schema.js";
import { createV2PortService, type V2PortServiceHandle } from "../plugins/v2-port-service.js";
import { AGENTDOCK_DEFAULT_V2 } from "../plugins/constants.js";
import { SseConsumer } from "./main/v2-sse-consumer.js";
import { emptyState, dispatchEvent, type AppliedState } from "./main/sync-applier.js";
import { serializeForPush } from "./main/v2-state-bridge.js";
import { registerE2eReset } from "./main/e2e-reset.js";
import { registerFontProtocol, ensureFontsReady } from "./main/fonts.js";

// --- New sub-module imports ---
import { registerClientWithDaemon, startHeartbeatLoop, startV2SyncLoop, unregisterClientWithDaemon, HEARTBEAT_INTERVAL_MS } from "./main/daemon-lifecycle.js";
import { reconcileAndDeclareSessions } from "./main/reconcile.js";
import { initAutoUpdater } from "./main/auto-updater.js";
import { createWindow } from "./main/window.js";
import { fullResyncAfterDisconnect } from "./main/v2-wiring.js";

// Resolve paths relative to this file (works in both dev and prod).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * v2 启用判断（Stage 1, v1-deprecation.md）。
 * - AGENTDOCK_V2=1 → 启用
 * - AGENTDOCK_V2 未设 + AGENTDOCK_DEFAULT_V2=true → 启用
 * - AGENTDOCK_V2=0 → 禁用（v1 已移除，禁用后 session 创建将失败）
 */
function resolveV2Enabled(): boolean {
  const v = process.env.AGENTDOCK_V2;
  if (v === "1") return true;
  if (v === "0") return false;
  return AGENTDOCK_DEFAULT_V2;
}

// Module-level state, all owned by the singleton app instance.
let mainWindow: BrowserWindow | null = null;
let daemonManager: DaemonManager | null = null;
let daemonClient: DaemonHonoClient | null = null;
let reallocatedQueue: Array<{
  sessionId: string;
  oldPorts: Record<string, number>;
  newPorts: Record<string, number>;
}> = [];
// P9: v2 service + SSE consumer (only populated when AGENTDOCK_V2=1).
let v2PortService: V2PortServiceHandle | null = null;
let sseConsumer: SseConsumer | null = null;
// §7.3, §11.3 #8: SyncApplier state — tracks snapshot + stream ordering.
let v2State: AppliedState = emptyState();
// Port the daemon is listening on (set once at boot, used by reconcileAndDeclareSessions).
let cachedDaemonPort = 0;

// Global projects DB handle (machine-level, opened once at boot).
let globalDbHandle: ReturnType<typeof import("../plugins/db/global.js").openGlobalDb> | null = null;

// Session runtime status tracking — populated by syncProject().
// Tracks per-session status across IPC calls:
//   "owned"      — default (no explicit setSessionStatus call yet)
//   "active"     — daemon recognizes this session as active
//   "creating"   — daemon shows session in creating state
//   "orphan"     — worktree on disk but daemon doesn't recognize it (incomplete)
//   "takeover"   — worktree on disk, complete, but daemon doesn't recognize (future: adoptable)
//   "foreign"    — another instance owns this session (not set in legacy path — see note)
// Note: "foreign" detection requires owner data from daemon, which is only
// available in the v2 path (useV2Projects). The legacy path (useProjects/db:projects:list)
// does not have access to owner information and cannot detect foreign sessions.
// Reset on db:init so stale entries don't leak between project switches.
const sessionStatuses = new Map<string, string>();
function getSessionStatus(sessionId: string): string {
  return sessionStatuses.get(sessionId) ?? "owned";
}
function setSessionStatus(sessionId: string, status: string): void {
  sessionStatuses.set(sessionId, status);
}
function clearSessionStatuses(): void {
  sessionStatuses.clear();
}

// Active project path (set by db:init IPC handler). When null, db/sessions
// handlers throw. Renderer's first call should be db:init with a project path.
let activeProjectPath: string | null = null;

// §6 — clientId 进程级唯一 (hostname + pid + 启动时间戳 + 随机后缀).
// 详见 electron/main/client-id.ts.
const clientId = generateClientId();

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let v2SyncTimer: ReturnType<typeof setInterval> | null = null;
let periodicSyncTimer: ReturnType<typeof setInterval> | null = null;

async function waitForViteReady(url: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function isViteReady(): Promise<boolean> {
  const url = process.env.ELECTRON_RENDERER_URL;
  if (!url) return false;
  try {
    const res = await fetch(url);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function isDaemonReady(): Promise<boolean> {
  if (!daemonClient) return false;
  try {
    const res = await daemonClient.health.$get();
    return res.ok;
  } catch {
    return false;
  }
}

function countHandlers(): number {
  return IPC_CHANNEL_COUNT;
}

function drainReallocated() {
  const list = reallocatedQueue;
  reallocatedQueue = [];
  return list;
}

async function bootstrap() {
  log.info({ pid: process.pid }, "AgentDock main starting");

  // 1. Spawn the daemon (Phase 1: Hono server)
  process.env.AGENTDOCK_ELECTRON = "1";
  daemonManager = new DaemonManager();

  if (app.isPackaged) {
    daemonManager.daemonEntry = resolve(__dirname, "../daemon/daemon.cjs");
    delete process.env.AGENTDOCK_USE_BUN;
    log.info({ entry: daemonManager.daemonEntry }, "packaged mode: using compiled daemon");
  } else {
    daemonManager.daemonEntry = resolve(__dirname, "../../plugins/daemon.ts");
    process.env.AGENTDOCK_USE_BUN = "1";
    log.info({ entry: daemonManager.daemonEntry }, "dev mode: using bun + daemon.ts");
  }
  try {
    const { client } = await daemonManager.init();
    daemonClient = createDaemonClient(`http://127.0.0.1:${client.port}`);
    cachedDaemonPort = client.port;
    log.info({ port: client.port }, "daemon connected");
  } catch (err) {
    log.error({ err, msg: String(err) }, "failed to start daemon");
    try {
      process.stderr.write(`[agentdock] daemon start failed: ${String(err)}\n`);
    } catch {
      // stderr already closed; nothing to do.
    }
    app.exit(1);
    return;
  }

  // v1 client registration + heartbeat
  await registerClientWithDaemon(daemonClient, clientId);
  heartbeatTimer = startHeartbeatLoop(daemonClient, clientId, heartbeatTimer);

  // 2. Register ALL IPC handlers (Phase 4: 29 channels + 3 daemon channels)

  const isDevInstance =
    typeof process.env.AGENTDOCK_DEV_INSTANCE === "string" &&
    process.env.AGENTDOCK_DEV_INSTANCE !== "";
  if (isDevInstance) {
    const userDataDir = app.getPath("userData");
    const projectsDbDir = join(userDataDir, "global");
    log.info(
      { projectsDbDir, instance: process.env.AGENTDOCK_DEV_INSTANCE },
      "dev mode: projects.db follows userData",
    );
    globalDbHandle = openGlobalDb(projectsDbDir);
  } else {
    globalDbHandle = openGlobalDb();
  }
  // One-time seed: if global DB is empty, migrate from the active project's DB
  try {
    const count = globalDbHandle.db
      .select({ c: sql<number>`count(*)` })
      .from(schema.projects)
      .get();
    const seedPath = activeProjectPath || process.cwd();
    if (count && count.c === 0 && seedPath) {
      const srcPath = getDbPath(seedPath);
      migrateProjectsToGlobal(globalDbHandle.db, srcPath);
    }
  } catch {
    log.warn("global DB seed migration failed — will retry on next boot");
  }

  const ipcDeps: AllIpcDeps = {
    getDaemonClient: () => daemonClient,
    getDaemonManager: () => daemonManager,
    getClientId: () => clientId,
    getProjectPath: () => activeProjectPath,
    setProjectPath: (p) => {
      activeProjectPath = p;
    },
    getDaemonPort: () => cachedDaemonPort,
    drainReallocated: () => {
      const list = reallocatedQueue;
      reallocatedQueue = [];
      return list;
    },
    getSessionStatus,
    setSessionStatus,
    clearSessionStatuses,
    isViteReady,
    isDaemonReady,
    countHandlers,
    getV2PortService: () => v2PortService,
    getSseConsumer: () => sseConsumer,
    getSseLastSeq: () => sseConsumer?.getLastSeq() ?? 0,
    isV2Enabled: () => resolveV2Enabled(),
    getGlobalDb: () => globalDbHandle?.db ?? null,
  };

  const v2Enabled = resolveV2Enabled();

  if (v2Enabled) {
    if (cachedDaemonPort <= 0) {
      log.warn("v2 enabled but daemon port not bound — v2 service will not start");
    } else {
      log.info("boot: v2 mode enabled");
    }
  } else {
    log.warn("boot: AGENTDOCK_V2=0 — v1 routes removed (F10-2a), session creation will fail");
  }
  if (v2Enabled && cachedDaemonPort > 0) {
    try {
      v2PortService = createV2PortService({
        baseUrl: `http://127.0.0.1:${cachedDaemonPort}`,
        clientId,
        pid: process.pid,
        getProjectRoot: () => activeProjectPath ?? process.cwd(),
      });
      sseConsumer = new SseConsumer({
        baseUrl: `http://127.0.0.1:${cachedDaemonPort}`,
        onEvent: (e) => {
          if (e.event === "heartbeat") return;
          log.debug({ event: e.event, seq: e.seq }, "sse event");
          v2State = dispatchEvent(v2State, e);
          const serialized = serializeForPush(v2State, clientId);
          if (mainWindow?.webContents) {
            mainWindow.webContents.send("daemon:v2State", serialized);
          }
        },
        onReconnect: () => {
          log.info("sse reconnected");
        },
        onDisconnect: () => {
          log.warn("sse disconnected — triggering §5.3 full re-sync");
          void fullResyncAfterDisconnect(
            cachedDaemonPort, v2PortService, clientId,
            () => sseConsumer?.getLastSeq() ?? 0,
            () => v2State, (s) => { v2State = s; },
          );
        },
        onResyncRequired: () => {
          log.warn("sse resync-required — triggering §7.3 full re-sync");
          void fullResyncAfterDisconnect(
            cachedDaemonPort, v2PortService, clientId,
            () => sseConsumer?.getLastSeq() ?? 0,
            () => v2State, (s) => { v2State = s; },
          );
        },
        onClose: () => {
          log.warn("sse closed");
        },
      });
      sseConsumer.start();
      v2SyncTimer = startV2SyncLoop(cachedDaemonPort, () => sseConsumer?.getLastSeq() ?? 0, clientId, v2SyncTimer);
      log.info({ port: cachedDaemonPort }, "AGENTDOCK_V2 enabled");

      // §4.3.2 — 30s periodic disk scan.
      const periodicSyncCtx = {
        getProjectPath: () => activeProjectPath,
        setProjectPath: (p: string) => { activeProjectPath = p; },
        getClientId: () => clientId,
        getSessionStatus,
        setSessionStatus,
        clearSessionStatuses,
        getV2PortService: () => v2PortService,
        getDaemonPort: () => cachedDaemonPort,
        getGlobalDb: () => globalDbHandle?.db ?? null,
      } as const;
      periodicSyncTimer = setInterval(() => {
        if (!activeProjectPath) return;
        void syncProject(activeProjectPath, periodicSyncCtx as Parameters<typeof syncProject>[1])
          .catch((err) => log.debug({ err }, "periodic syncProject failed"));
      }, HEARTBEAT_INTERVAL_MS);
      if (typeof periodicSyncTimer!.unref === "function") periodicSyncTimer!.unref();
      // Run once immediately.
      if (activeProjectPath) {
        void syncProject(activeProjectPath, periodicSyncCtx as Parameters<typeof syncProject>[1])
          .catch((err) => log.debug({ err }, "periodic syncProject (initial) failed"));
      }
    } catch (err) {
      log.error({ err }, "v2 service / sse consumer init failed");
    }
  }

  registerAllIpc(ipcDeps);

  // Window controls for custom titlebar (non-macOS frameless window).
  ipcMain.handle("window:minimize", () => {
    mainWindow?.minimize();
  });
  ipcMain.handle("window:maximize", () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  ipcMain.handle("window:close", () => {
    mainWindow?.close();
  });
  ipcMain.handle("window:isMaximized", () => {
    return mainWindow?.isMaximized() ?? false;
  });
  ipcMain.handle("window:platform", () => {
    return process.platform;
  });

  // E2E reset handler
  registerE2eReset({
    getProjectPath: () => activeProjectPath,
    setProjectPath: (p) => { activeProjectPath = p; },
    clearSessionStatuses,
    drainReallocated: () => {
      const list = reallocatedQueue;
      reallocatedQueue = [];
      return list;
    },
    resetV2State: v2Enabled
      ? () => { v2State = emptyState(); }
      : undefined,
    stopSseConsumer: v2Enabled
      ? () => { sseConsumer?.stop(); sseConsumer = null; }
      : undefined,
    stopV2PortService: v2Enabled
      ? () => { v2PortService?.dispose(); v2PortService = null; }
      : undefined,
    clearHeartbeatTimer: () => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    },
    clearV2SyncTimer: () => {
      if (v2SyncTimer) { clearInterval(v2SyncTimer); v2SyncTimer = null; }
    },
    clearPeriodicSyncTimer: () => {
      if (periodicSyncTimer) { clearInterval(periodicSyncTimer); periodicSyncTimer = null; }
    },
  });

  // Auto-init the active project to the current working directory.
  try {
    activeProjectPath = process.cwd();
    log.info({ projectPath: activeProjectPath }, "auto-set active project to cwd");
  } catch (err) {
    log.warn({ err }, "failed to auto-set active project");
  }

  log.info({ ipcChannels: IPC_CHANNEL_COUNT }, "IPC handlers registered");

  // Run the deferred reconcile.
  await reconcileAndDeclareSessions({
    activeProjectPath,
    v2PortService,
    cachedDaemonPort,
    globalDbHandle,
    reallocatedQueue,
    clientId,
  });

  // 3. Create the window and load the renderer
  const win = createWindow((w) => { mainWindow = w; });
  win.on("closed", () => { mainWindow = null; });

  // Kick off background font download — non-blocking, notifies renderer when done.
  void ensureFontsReady(win);

  const devUrl = process.env.ELECTRON_RENDERER_URL;

  if (devUrl) {
    log.info({ devUrl }, "loading renderer from Vite dev server");
    const ready = await waitForViteReady(devUrl);
    if (!ready) {
      log.error({ devUrl }, "Vite dev server not ready in time");
      app.exit(1);
      return;
    }
    await win.loadURL(devUrl);
  } else {
    const indexPath = resolve(__dirname, "../renderer/index.html");
    log.info({ indexPath }, "loading renderer from built dist");
    await win.loadFile(indexPath);
  }

  log.info("window loaded");

  // 4. 初始化自动更新（开发模式为 NO-OP）
  initAutoUpdater(() => mainWindow);
}

// Register the custom font protocol after the app is ready.
// In dev mode Vite serves fonts from public/fonts/, so the protocol is a no-op.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "agentdock-fonts",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

// Dev mode userData isolation.
if (process.env.AGENTDOCK_USER_DATA_DIR) {
  const devUserData = resolve(process.env.AGENTDOCK_USER_DATA_DIR);
  app.setPath("userData", devUserData);
}

// 打包后将 userData/sessionData 指向 %APPDATA%/AgentDock.
if (app.isPackaged) {
  app.setPath("userData", resolve(app.getPath("appData"), "AgentDock"));
  app.setPath("sessionData", resolve(app.getPath("appData"), "AgentDock"));
}

app.whenReady().then(async () => {
  registerFontProtocol();
  await bootstrap();
}).catch((err) => {
  log.error({ err }, "bootstrap failed");
  app.exit(1);
});

app.on("before-quit", (e) => {
  e.preventDefault();
  log.info("AgentDock shutting down");

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (periodicSyncTimer) {
    clearInterval(periodicSyncTimer);
    periodicSyncTimer = null;
  }

  // P9: stop the SSE consumer + dispose v2 service.
  if (sseConsumer) {
    sseConsumer.stop();
    sseConsumer = null;
  }
  if (v2PortService) {
    v2PortService.dispose();
    v2PortService = null;
  }

  // Close the global projects DB handle.
  globalDbHandle?.close();

  // Unregister BEFORE killing the daemon child.
  const unregister = unregisterClientWithDaemon(daemonClient, clientId);
  const timeout = new Promise((r) => setTimeout(r, 500));
  Promise.race([unregister, timeout]).finally(() => {
    if (daemonManager) {
      try {
        daemonManager.shutdown();
      } catch (err) {
        log.warn({ err }, "daemon shutdown error (non-fatal)");
      }
    }
    setImmediate(() => app.exit(0));
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const win = createWindow((w) => { mainWindow = w; });
    win.on("closed", () => { mainWindow = null; });
  }
});

/**
 * Swallow EPIPE / ERR_IPC_CHANNEL_CLOSED during shutdown.
 */
function isShutdownNoise(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as NodeJS.ErrnoException;
  if (e.code === "EPIPE") return true;
  if (e.code === "ERR_IPC_CHANNEL_CLOSED") return true;
  return false;
}

process.on("uncaughtException", (err) => {
  if (isShutdownNoise(err)) {
    try {
      process.stderr.write(`[main] swallowed shutdown noise: ${(err as Error).message}\n`);
    } catch {
      // truly nothing we can do
    }
    return;
  }
  try {
    log.error({ err }, "uncaught exception in main process");
  } catch {
    // logger dead too; let Electron surface it
    throw err;
  }
});

process.on("unhandledRejection", (reason) => {
  if (isShutdownNoise(reason)) {
    try {
      process.stderr.write(
        `[main] swallowed shutdown rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`,
      );
    } catch {
      // nothing to do
    }
    return;
  }
  try {
    log.error({ reason }, "unhandled promise rejection in main process");
  } catch {
    // logger dead; ignore
  }
});

// Export internals for test access (Phase 3 acceptance inspects them).
export const __test__ = {
  getMainWindow: () => mainWindow,
  getDaemonClient: () => daemonClient,
  getClientId: () => clientId,
  getReallocatedQueue: () => reallocatedQueue,
  countIpcHandlers: () => Object.keys((ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers ?? new Map()).length,
};
