/**
 * Electron Main Process Entry — Single-Instance Architecture
 *
 * Responsibilities:
 *   1. Acquire global singleton lock (production only)
 *   2. Initialize PortPool + SessionManager directly (no daemon)
 *   3. Register all IPC handlers
 *   4. Create the BrowserWindow and load the renderer
 *   5. Handle lifecycle (before-quit cleanup, before-quit→exit, etc.)
 *
 * Dev mode: electron-vite injects ELECTRON_RENDERER_URL pointing at the
 * Vite dev server. We loadURL it once it's ready.
 *
 * Prod mode: loadFile from the renderer dist (dist/index.html).
 */
import { app, BrowserWindow, dialog, ipcMain, protocol } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import { IPC_CHANNEL_COUNT } from "./shared/api-types.js";
import { registerAllIpc, type AllIpcDeps } from "./main/ipc/index.js";
import { log } from "../plugins/logger.js";
import { openGlobalDb } from "../plugins/db/global.js";
import { setDbBasePath } from "../plugins/db/index.js";
import { registerE2eReset } from "./main/e2e-reset.js";
import { registerFontProtocol, ensureFontsReady } from "./main/fonts.js";
import { initAutoUpdater } from "./main/auto-updater.js";
import { createWindow } from "./main/window.js";

// --- New single-instance imports ---
import { acquireInstanceLock, type FileLock } from "./main/instance-lock.js";
import { createPortPool, type PortPoolInternal } from "./main/port-pool.js";
import { createSessionManager, type SessionManager } from "./main/session-manager.js";
import { initGlobalSettings } from "../plugins/global-settings.js";

// Resolve paths relative to this file (works in both dev and prod).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// Module-level state (single-instance: no daemon, no multi-client)
// ============================================================

let mainWindow: BrowserWindow | null = null;
let instanceLock: FileLock | null = null;
let portPool: PortPoolInternal | null = null;
let sessionManager: SessionManager | null = null;

// Global projects DB handle (machine-level, opened once at boot).
let globalDbHandle: ReturnType<typeof openGlobalDb> | null = null;

// Active project path (set by db:init IPC handler).
let activeProjectPath: string | null = null;

// ============================================================
// Helpers
// ============================================================

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

function countHandlers(): number {
  return IPC_CHANNEL_COUNT;
}

// ============================================================
// Bootstrap
// ============================================================

async function bootstrap() {
  log.info({ pid: process.pid }, "AgentDock main starting (single-instance)");

  // 1. Initialize PortPool + SessionManager (replaces daemon spawn)
  // Initialize global settings first
  // Always use app.getPath("userData") for consistent database location
  const dbBasePath = app.getPath("userData");
  initGlobalSettings(dbBasePath);

  // Create port pool with settings from global config
  const { resolvePortPoolConfig } = await import("./main/port-pool.js");
  const portPoolConfig = await resolvePortPoolConfig();
  portPool = createPortPool(portPoolConfig);
  sessionManager = createSessionManager(portPool);
  log.info("port pool + session manager initialized");

  // 2. Set database base path (single-DB architecture)
  setDbBasePath(dbBasePath);
  log.info({ dbBasePath }, "database base path set");

  // 3. Auto-init the active project to the current working directory.
  //    ONLY in dev mode: there process.cwd() is the repo root, which is
  //    a real project the developer wants open. In a packaged build
  //    process.cwd() is the install directory (e.g.
  //    C:\Users\<u>\AppData\Local\Programs\AgentDock), which is NOT a
  //    user project — auto-registering it would create a bogus
  //    "AgentDock" project tab. Packaged builds start with no active
  //    project and show the "open project" welcome screen instead.
  if (!app.isPackaged) {
    try {
      activeProjectPath = process.cwd();
      log.info({ projectPath: activeProjectPath }, "dev mode: auto-set active project to cwd");
    } catch (err) {
      log.warn({ err }, "failed to auto-set active project");
    }
  } else {
    log.info("packaged build: no auto active project (waiting for user to open one)");
  }

  // 3. Open global projects DB (still used for project lookups by fs-config/worktree-shell)
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
    // On startup, proactively clean the legacy homedir global DB
    // ($HOME/.agentdock/projects.db) if it exists. This path was
    // used by v0.1-v0.2 before the global DB moved to userData.
    // Stale entries here cause project tabs to appear on fresh install.
    // The NSIS uninstaller was supposed to clean this but $USERPROFILE
    // is not a valid NSIS variable and the cleanup never fires.
    const legacyDbPath = join(app.getPath("home"), ".agentdock", "projects.db");
    if (existsSync(legacyDbPath)) {
      try {
        unlinkSync(legacyDbPath);
        log.info({ path: legacyDbPath }, "cleaned legacy homedir global DB on startup");
      } catch (err) {
        log.warn({ err, path: legacyDbPath }, "failed to clean legacy global DB");
      }
    }
    globalDbHandle = openGlobalDb();
  }

  // 4. Register ALL IPC handlers
  const ipcDeps: AllIpcDeps = {
    getProjectPath: () => activeProjectPath,
    setProjectPath: (p) => {
      activeProjectPath = p;
    },
    getSessionManager: () => sessionManager,
    getGlobalDb: () => globalDbHandle?.db ?? null,
    isViteReady,
    countHandlers,
  };

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

  // E2E reset handler (simplified — no daemon to reset)
  registerE2eReset({
    getProjectPath: () => activeProjectPath,
    setProjectPath: (p) => { activeProjectPath = p; },
  });

  log.info({ ipcChannels: IPC_CHANNEL_COUNT }, "IPC handlers registered");

  // 4. Create the window and load the renderer
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

  // 5. 初始化自动更新（开发模式为 NO-OP）
  initAutoUpdater(() => mainWindow);
}

// ============================================================
// Font protocol (registered before app.whenReady)
// ============================================================

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

// ============================================================
// Dev mode userData isolation
// ============================================================

if (process.env.AGENTDOCK_USER_DATA_DIR) {
  const devUserData = resolve(process.env.AGENTDOCK_USER_DATA_DIR);
  app.setPath("userData", devUserData);
}

// 打包后将 userData/sessionData 指向 %APPDATA%/AgentDock.
if (app.isPackaged) {
  app.setPath("userData", resolve(app.getPath("appData"), "AgentDock"));
  app.setPath("sessionData", resolve(app.getPath("appData"), "AgentDock"));
}

// ============================================================
// App startup — singleton lock + bootstrap
// ============================================================

app.whenReady().then(async () => {
  // [NEW] Global singleton lock (production only)
  const lockHandle = await acquireInstanceLock();
  if (!lockHandle) {
    // Another instance is running (or dev mode — lockHandle is null but allowed)
    // In dev mode (lockHandle === null from acquireInstanceLock), proceed.
    // In prod mode (lockHandle === null means lock held), show dialog and exit.
    if (app.isPackaged && !process.env.AGENTDOCK_DEV_INSTANCE) {
      await dialog.showMessageBox({
        type: "info",
        title: "AgentDock",
        message: "AgentDock is already running.",
      });
      app.exit(0);
      return;
    }
  }
  instanceLock = lockHandle;

  registerFontProtocol();
  await bootstrap();
}).catch((err) => {
  log.error({ err }, "bootstrap failed");
  app.exit(1);
});

// ============================================================
// Shutdown
// ============================================================

app.on("before-quit", (e) => {
  e.preventDefault();
  log.info("AgentDock shutting down");

  // Release all sessions (release ports)
  sessionManager?.dispose();
  sessionManager = null;

  // Close global projects DB
  globalDbHandle?.close();
  globalDbHandle = null;

  // Release instance lock
  if (instanceLock) {
    void instanceLock.release();
    instanceLock = null;
  }

  setImmediate(() => app.exit(0));
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

// ============================================================
// Error handlers
// ============================================================

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

// Export internals for test access.
export const __test__ = {
  getMainWindow: () => mainWindow,
  getSessionManager: () => sessionManager,
  countIpcHandlers: () => Object.keys((ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers ?? new Map()).length,
};
