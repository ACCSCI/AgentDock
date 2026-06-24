/**
 * App-level IPC handlers — version info and manual update check.
 *
 * Pulled out of bootstrap.ts because the update surface is its own concern:
 * `app:version` is a pure read, while `app:checkForUpdates` and
 * `app:quitAndInstall` both interact with the module-level `autoUpdater`
 * configured in electron/main.ts → initAutoUpdater().
 *
 * Dev mode behavior:
 *   - `app:version` returns `app.getVersion()` (always available).
 *   - `app:checkForUpdates` short-circuits with `{ status: "dev-mode" }`
 *     because `autoUpdater` is a no-op outside of packaged builds. We
 *     do NOT call into the updater — initAutoUpdater() never ran, so
 *     the listeners are not registered.
 *   - `app:quitAndInstall` is also a no-op in dev — it would terminate
 *     the developer's process. Renderer should hide the action button
 *     when `isPackaged` is false.
 *
 * Channel constants come from electron/shared/api-types.ts — adding a new
 * handler requires adding the key there first, then wiring it up here
 * AND in preload.ts. The Phase 4 acceptance test enumerates
 * IPC_CHANNEL_COUNT to catch missing entries.
 */
import { app, ipcMain } from "electron";
import electronUpdater from "electron-updater";
import { IPC_CHANNELS } from "../../shared/api-types.js";
import { log } from "../../../plugins/logger.js";

const { autoUpdater } = electronUpdater;

export interface AppVersionInfo {
  /** Version string from package.json / app.getVersion() (e.g. "0.1.0"). */
  version: string;
  /** True only when running from a packaged build — autoUpdater is meaningful. */
  isPackaged: boolean;
}

export type CheckForUpdatesResult =
  | { status: "dev-mode" }
  | { status: "checking" }
  | { status: "available"; info: { version: string } }
  | { status: "not-available"; info: { version: string } }
  | { status: "downloaded"; info: { version: string } }
  | { status: "error"; message: string };

export function registerApp(): void {
  ipcMain.handle(IPC_CHANNELS["app:version"], (): AppVersionInfo => {
    return {
      version: app.getVersion(),
      isPackaged: app.isPackaged,
    };
  });

  ipcMain.handle(
    IPC_CHANNELS["app:checkForUpdates"],
    async (): Promise<CheckForUpdatesResult> => {
      if (!app.isPackaged) {
        log.info("app:checkForUpdates: dev mode — skipping");
        return { status: "dev-mode" };
      }
      try {
        // checkForUpdates resolves with UpdateCheckResult even when
        // no newer version is available — the result.info always
        // carries the latest release, which may be the same as the
        // current version. The canonical signal is the event chain
        // (onAvailable / update-not-available / update-downloaded /
        // error) registered in initAutoUpdater(). The renderer
        // subscribes to these and manages state transitions; all we
        // do here is kick off the check.
        await autoUpdater.checkForUpdates();
        return { status: "checking" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn({ err }, "app:checkForUpdates failed");
        return { status: "error", message };
      }
    },
  );

  // quitAndInstall is dangerous in dev — only callable when packaged.
  // We rely on isPackaged as the gate; if a dev shell somehow calls this,
  // we log and no-op rather than killing the developer's session.
  ipcMain.handle(IPC_CHANNELS["app:quitAndInstall"], (): { ok: boolean } => {
    if (!app.isPackaged) {
      log.warn("app:quitAndInstall: dev mode — refusing to quit");
      return { ok: false };
    }
    // isForceRunAfter defaults to true; isSilent defaults to false so the
    // user sees the install UI. Caller (renderer) is in charge of
    // confirming the action.
    autoUpdater.quitAndInstall();
    return { ok: true };
  });
}
