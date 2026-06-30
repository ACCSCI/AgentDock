/**
 * E2E reset handler — allows Playwright tests to reset the main process
 * state between tests when reusing a single Electron instance (REUSE mode).
 *
 * Only active when NODE_ENV=test. Exposes a global function on `globalThis`
 * so `electronApp.evaluate()` can call it directly from test code.
 *
 * Single-instance architecture: no daemon, no SSE, no v2 state to reset.
 */
import { ipcMain } from "electron";
import { resetActiveDb } from "../../plugins/db/index.js";
import { terminalManager } from "../../plugins/terminal-manager.js";

export interface E2eResetDeps {
  getProjectPath: () => string | null;
  setProjectPath: (p: string | null) => void;
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

  // 3. Kill any open terminals (best-effort)
  try {
    terminalManager.killAll();
    steps.push("terminals");
  } catch {
    steps.push("terminals:error");
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

  ipcMain.handle("__e2e:resetMainState", () => {
    return resetMainState(deps);
  });

  (globalThis as Record<string, unknown>).__e2eResetMainState = () =>
    resetMainState(deps);
}
