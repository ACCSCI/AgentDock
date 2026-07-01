/**
 * Bootstrap IPC handlers — small, one-shot calls used at app startup.
 *
 * Single-instance architecture: no daemon, no SSE, no v2 service.
 * Only bootstrap:health and renderer:reportError are retained.
 */
import { ipcMain } from "electron";
import { IPC_CHANNELS } from "../shared/api-types.js";
import { log } from "../../plugins/logger.js";

export interface BootstrapDeps {
  /** Resolves true if the Vite dev server is reachable (dev only). */
  isViteReady: () => Promise<boolean>;
  /** Number of registered IPC handlers. */
  countHandlers: () => number;
}

export function registerBootstrap(deps: BootstrapDeps): void {
  // Health check — simplified: no daemon to poll, just report vite + ipc.
  ipcMain.handle(IPC_CHANNELS["bootstrap:health"], async () => {
    const vite = await deps.isViteReady();
    return {
      daemon: "n/a" as const,
      vite: vite ? "ok" : "down",
      ipc: deps.countHandlers(),
    };
  });

  // Renderer error reporting — the bridge that connects renderer-side
  // ErrorBoundary / window.onerror to the main process pino logger.
  ipcMain.handle(
    IPC_CHANNELS["renderer:reportError"],
    (_evt, payload) => {
      if (!payload || typeof payload !== "object") {
        log.error({ source: "renderer" }, "renderer error reported with invalid payload");
        return;
      }
      const p = payload as { type: string; message: string; stack?: string | null; componentStack?: string | null };
      log.error(
        {
          source: "renderer",
          errorType: p.type,
          message: p.message,
          stack: p.stack ?? undefined,
          componentStack: p.componentStack ?? undefined,
        },
        "renderer error",
      );
    },
  );
}
