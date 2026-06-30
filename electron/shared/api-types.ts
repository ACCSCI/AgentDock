/**
 * Shared API types — single source of truth for IPC channels.
 *
 * Single-instance architecture: no daemon, no SSE, no v2 service.
 * Removed channels are commented out with [OLD-DAEMON] markers.
 */
// [OLD-DAEMON] Hono AppType re-export — no longer needed
// import type { AppType } from "../../plugins/daemon/app.js";
// export type { AppType };

/**
 * IPC channel names. Adding a new channel requires updating all three maps
 * (`ipcMain.handle(...)`, `ipcMain.on(...)`, and the preload's bridge).
 * Tests in `scripts/acceptance/phase4-ipc.test.ts` enumerate these to verify
 * coverage.
 *
 * Format: a stable string per channel. The string itself is opaque to
 * callers — use the constants, not the literals.
 */
export const IPC_CHANNELS = {
  // db (Drizzle operations, run in main process)
  "db:projects:list": "db:projects:list",
  "db:projects:create": "db:projects:create",
  "db:projects:delete": "db:projects:delete",
  "db:init": "db:init",
  "db:sessions:reorder": "db:sessions:reorder",

  // sync (manual disk+daemon reconcile for the active project)
  "sync:project": "sync:project",

  // sessions (Hono client calls to daemon)
  "sessions:create": "sessions:create",
  "sessions:delete": "sessions:delete",
  "sessions:rename": "sessions:rename",
  "sessions:reassignPorts": "sessions:reassignPorts",
  "sessions:retryHooks": "sessions:retryHooks",
  "sessions:stream": "sessions:stream",
  "sessions:bgHookStatus": "sessions:bgHookStatus",
  "sessions:hookErrors": "sessions:hookErrors",
  "sessions:setUserStatus": "sessions:setUserStatus",
  "sessions:activate": "sessions:activate",

  // terminals (REST for create/list/rename/delete + IPC for streaming)
  "terminals:create": "terminals:create",
  "terminals:list": "terminals:list",
  "terminals:rename": "terminals:rename",
  "terminals:delete": "terminals:delete",
  "terminals:write": "terminals:write",
  "terminals:open": "terminals:open",

  // fs (direct node:fs calls in main)
  "fs:browseDirs": "fs:browseDirs",
  "fs:files": "fs:files",

  // config (read/write agentdock.config.yaml)
  "config:get": "config:get",
  "config:save": "config:save",

  // worktree (scan/delete orphans)
  "worktree:orphans": "worktree:orphans",
  "worktree:deleteOrphans": "worktree:deleteOrphans",

  // git (check repo + init before project creation)
  "git:isRepo": "git:isRepo",
  "git:init": "git:init",

  // os (Electron dialog / shell APIs)
  "shell:openExplorer": "shell:openExplorer",
  "shell:openTerminal": "shell:openTerminal",
  "shell:openPullRequests": "shell:openPullRequests",

  // bootstrap (one-shot, used by renderer on startup)
  "bootstrap:health": "bootstrap:health",
  // [OLD-DAEMON] "bootstrap:reallocated": "bootstrap:reallocated",
  // [OLD-DAEMON] "bootstrap:clientId": "bootstrap:clientId",
  // [OLD-DAEMON] "bootstrap:v2Enabled": "bootstrap:v2Enabled",

  // [OLD-DAEMON] daemon channels — removed in single-instance architecture
  // "daemon:health": "daemon:health",
  // "daemon:debugState": "daemon:debugState",
  // "daemon:faultInject": "daemon:faultInject",
  // "daemon:probeRuntime": "daemon:probeRuntime",
  // "daemon:sync": "daemon:sync",
  // "daemon:events:subscribe": "daemon:events:subscribe",

  // [OLD-DAEMON] sessions:v2 channels — removed in single-instance architecture
  // "sessions:v2:create": "sessions:v2:create",
  // "sessions:v2:delete": "sessions:v2:delete",
  // "sessions:v2:rename": "sessions:v2:rename",
  // "sessions:v2:reassign": "sessions:v2:reassign",
  // "sessions:v2:status": "sessions:v2:status",
  // "sessions:v2:takeover": "sessions:v2:takeover",

  // window (custom titlebar controls — non-macOS)
  "window:minimize": "window:minimize",
  "window:maximize": "window:maximize",
  "window:close": "window:close",
  "window:isMaximized": "window:isMaximized",
  "window:platform": "window:platform",

  // todos (per-project todo list in custom titlebar)
  "todos:list": "todos:list",
  "todos:create": "todos:create",
  "todos:cycleStatus": "todos:cycleStatus",
  "todos:update": "todos:update",
  "todos:delete": "todos:delete",
  "todos:reorder": "todos:reorder",

  // renderer error reporting — forwards React/JS errors to the main
  // process logger so they land in the persistent log file (see
  // plugins/logger.ts) instead of dying in the renderer's DevTools.
  "renderer:reportError": "renderer:reportError",

  // app (version info + manual update check trigger)
  "app:version": "app:version",
  "app:checkForUpdates": "app:checkForUpdates",
  "app:quitAndInstall": "app:quitAndInstall",

  // settings (global app settings)
  "settings:get": "settings:get",
  "settings:update": "settings:update",
} as const;

export type IpcChannel = keyof typeof IPC_CHANNELS;

/**
 * Count of unique IPC channels. Updated whenever IPC_CHANNELS is.
 * Acceptance tests assert against this to detect forgotten channels.
 */
export const IPC_CHANNEL_COUNT = Object.keys(IPC_CHANNELS).length;
