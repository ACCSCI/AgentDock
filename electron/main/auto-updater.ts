/**
 * Auto-updater — electron-updater + GitHub Releases integration.
 *
 * Extracted from main.ts. Uses a getter function to avoid holding a stale
 * BrowserWindow reference.
 *
 * - Dev mode (app.isPackaged === false): NO-OP.
 * - Production mode: checks on startup, then every 4 hours.
 * - Events forwarded to renderer for status UI.
 * - Actual install happens on next quit.
 */
import { app, BrowserWindow } from "electron";
import electronUpdater from "electron-updater";
import { log } from "../../plugins/logger.js";

const { autoUpdater } = electronUpdater;

// Module-level timer reference — guards against double-registration
// (macOS activate can call this multiple times).
let autoUpdateTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Configure and start auto-update checking.
 *
 * @param getMainWindow - Getter that returns the current BrowserWindow.
 *   Uses a getter rather than a direct reference to avoid stale closures
 *   that point at a destroyed window.
 */
export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  // Dev mode: skip update checks
  if (!app.isPackaged) {
    log.info("autoUpdater: skipped (not packaged)");
    return;
  }

  autoUpdater.logger = log;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Avoid duplicate listener registration (macOS activate scenario).
  autoUpdater.removeAllListeners();

  const sendToRenderer = (channel: string, payload?: unknown): void => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  };

  // Forward events to renderer.
  autoUpdater.on("checking-for-update", () => {
    log.info("autoUpdater: checking for update");
    sendToRenderer("update:checking");
  });

  autoUpdater.on("update-available", (info) => {
    log.info({ version: info.version }, "autoUpdater: update available");
    sendToRenderer("update:available", info);
  });

  autoUpdater.on("update-not-available", (info) => {
    log.info({ version: info.version }, "autoUpdater: update not available");
    sendToRenderer("update:not-available", info);
  });

  autoUpdater.on("download-progress", (progress) => {
    log.info({ percent: progress.percent }, "autoUpdater: download progress");
    sendToRenderer("update:download-progress", progress);
  });

  autoUpdater.on("update-downloaded", (info) => {
    log.info({ version: info.version }, "autoUpdater: update downloaded");
    sendToRenderer("update:downloaded", info);
  });

  autoUpdater.on("error", (err) => {
    log.error({ err }, "autoUpdater: error");
    sendToRenderer("update:error", { message: err.message });
  });

  // Check on startup.
  void autoUpdater.checkForUpdatesAndNotify().then((result) => {
    log.info({ result }, "autoUpdater: initial check complete");
  }).catch((err) => {
    log.warn({ err }, "autoUpdater: initial check failed");
  });

  // Periodic check every 4 hours (clear existing timer first).
  if (autoUpdateTimer) clearInterval(autoUpdateTimer);
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  autoUpdateTimer = setInterval(() => {
    void autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      log.warn({ err }, "autoUpdater: periodic check failed");
    });
  }, FOUR_HOURS);

  if (typeof autoUpdateTimer.unref === "function") autoUpdateTimer.unref();
}
