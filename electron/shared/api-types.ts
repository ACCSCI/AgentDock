/**
 * Shared API types — single source of truth for IPC channels and
 * Hono AppType across main / preload / renderer.
 *
 * Phase 3: this file centralizes:
 *   1. The IPC channel name constants (typed as `as const` for exhaustiveness)
 *   2. The Hono AppType re-export (so all three layers import from the
 *      same path, not directly from `plugins/daemon/app.js`)
 *   3. The ApiSurface type that preload exposes via `contextBridge`.
 *
 * Why a shared file:
 *   - main and preload both need to agree on channel names. A const map
 *     guarantees this — typos in one side surface as TS errors in the other.
 *   - When Phase 4 adds new IPC handlers, both sides update the same file
 *     and the test fixtures catch missing entries.
 *   - The renderer can import `ApiSurface` to get full typing for `window.api.*`
 *     without manually duplicating method signatures.
 */
import type { AppType } from "../../plugins/daemon/app.js";

// Re-export so main/preload/renderer all import from a single place.
export type { AppType };

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

  // terminals (REST for create/list/rename/delete + IPC for streaming)
  "terminals:create": "terminals:create",
  "terminals:list": "terminals:list",
  "terminals:rename": "terminals:rename",
  "terminals:delete": "terminals:delete",
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

  // os (Electron dialog / shell APIs)
  "shell:openExplorer": "shell:openExplorer",
  "shell:openTerminal": "shell:openTerminal",

  // bootstrap (one-shot, used by renderer on startup)
  "bootstrap:health": "bootstrap:health",
  "bootstrap:reallocated": "bootstrap:reallocated",
  "bootstrap:clientId": "bootstrap:clientId",

  // daemon (新架构 §13.1 — direct daemon API access for UI observability)
  "daemon:health": "daemon:health",
  "daemon:debugState": "daemon:debugState",
  "daemon:faultInject": "daemon:faultInject",
} as const;

export type IpcChannel = keyof typeof IPC_CHANNELS;

/**
 * Count of unique IPC channels. Updated whenever IPC_CHANNELS is.
 * Acceptance tests assert against this to detect forgotten channels.
 */
export const IPC_CHANNEL_COUNT = Object.keys(IPC_CHANNELS).length;
