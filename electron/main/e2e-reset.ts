/**
 * E2E reset handler — allows Playwright tests to reset the main process
 * state between tests when reusing a single Electron instance (REUSE mode).
 *
 * Only active when NODE_ENV=test. Exposes a global function on `globalThis`
 * so `electronApp.evaluate()` can call it directly from test code.
 *
 * v1 scope: resets renderer-relevant state (DB, project path, session
 * statuses, capture buffers). Does NOT reset daemon state (port allocation,
 * SSE bus, client registration) — that requires daemon-side cooperation
 * and is planned for v2.
 */
import { ipcMain } from "electron";
import { resetActiveDb } from "../../plugins/db/index.js";
import { terminalManager } from "../../plugins/terminal-manager.js";

export interface E2eResetDeps {
  getProjectPath: () => string | null;
  setProjectPath: (p: string | null) => void;
  clearSessionStatuses: () => void;
  drainReallocated: () => unknown[];
  // v2 state reset (optional — only wired when AGENTDOCK_V2=1)
  resetV2State?: () => void;
  stopSseConsumer?: () => void;
  stopV2PortService?: () => void;
  clearHeartbeatTimer?: () => void;
  clearV2SyncTimer?: () => void;
  // IPC-layer state in electron/main/ipc/db.ts
  resetDbBinding?: () => void;
  clearPeriodicSyncTimer?: () => void;
}

/**
 * Core reset logic. Returns a summary for test diagnostics.
 */
export function resetMainState(deps: E2eResetDeps): { reset: string[] } {
  const steps: string[] = [];

  // 1. Close active DB handle (releases WAL/SHM file handles on Windows)
  try {
    resetActiveDb();
    steps.push("activeDb");
  } catch {
    steps.push("activeDb:error");
  }

  // 2. Clear project path
  deps.setProjectPath(null);
  steps.push("projectPath");

  // 3. Clear session statuses
  deps.clearSessionStatuses();
  steps.push("sessionStatuses");

  // 4. Drain reallocation queue
  deps.drainReallocated();
  steps.push("reallocatedQueue");

  // 5. Kill any open terminals (best-effort)
  try {
    terminalManager.killAll();
    steps.push("terminals");
  } catch {
    steps.push("terminals:error");
  }

  // 6. v2 state (optional)
  if (deps.resetV2State) {
    try {
      deps.resetV2State();
      steps.push("v2State");
    } catch {
      steps.push("v2State:error");
    }
  }

  // 7. Stop SSE consumer (optional)
  if (deps.stopSseConsumer) {
    try {
      deps.stopSseConsumer();
      steps.push("sseConsumer");
    } catch {
      steps.push("sseConsumer:error");
    }
  }

  // 8. Stop v2 port service (optional)
  if (deps.stopV2PortService) {
    try {
      deps.stopV2PortService();
      steps.push("v2PortService");
    } catch {
      steps.push("v2PortService:error");
    }
  }

  // 9. Clear timers (optional)
  if (deps.clearHeartbeatTimer) {
    deps.clearHeartbeatTimer();
    steps.push("heartbeatTimer");
  }
  if (deps.clearV2SyncTimer) {
    deps.clearV2SyncTimer();
    steps.push("v2SyncTimer");
  }
  if (deps.clearPeriodicSyncTimer) {
    deps.clearPeriodicSyncTimer();
    steps.push("periodicSyncTimer");
  }

  // 10. Reset IPC-layer DB binding state (optional)
  if (deps.resetDbBinding) {
    deps.resetDbBinding();
    steps.push("dbBinding");
  }

  return { reset: steps };
}

/**
 * Register the `__e2e:resetMainState` IPC handler and expose the reset
 * function on `globalThis` for `electronApp.evaluate()` access from tests.
 *
 * Called once during IPC registration in electron/main.ts.
 */
export function registerE2eReset(deps: E2eResetDeps): void {
  if (process.env.NODE_ENV !== "test") return;

  // IPC handler — can be called via window.electron.ipcRenderer.invoke()
  // (though that requires adding the channel to IPC_CHANNELS; for v1 we
  // rely on globalThis which is simpler for test-only code).
  ipcMain.handle("__e2e:resetMainState", () => {
    return resetMainState(deps);
  });

  // Expose on globalThis so electronApp.evaluate() can call it directly.
  (globalThis as Record<string, unknown>).__e2eResetMainState = () =>
    resetMainState(deps);
}
