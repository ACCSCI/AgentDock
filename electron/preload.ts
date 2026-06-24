/**
 * Electron Preload Script — exposes `window.api` to the renderer.
 *
 * Phase 4: full API surface (29 channels across 8 namespaces).
 *
 * This runs in an isolated context with Node access before the renderer
 * loads. It exposes `window.api` via contextBridge — a typed surface that
 * the renderer can call without holding Node directly.
 *
 * Why contextIsolation: true:
 *   - The renderer is untrusted (it loads arbitrary code from the user's
 *     project). Isolating it from Node prevents code injection in the
 *     renderer from getting shell access.
 *   - Only the specific functions we expose via contextBridge are reachable.
 *
 * Streaming: SSE-style events (session:create steps, terminal:port) are
 * not modeled in the type signature — renderer subscribes via
 * `ipcRenderer.on(channel, listener)`. See `subscribeSession` and
 * `onTerminalPort` below for the typed wrappers.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC_CHANNELS, type IpcChannel } from "./shared/api-types.js";

function invoke<T = unknown>(channel: IpcChannel, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(IPC_CHANNELS[channel], ...args) as Promise<T>;
}

function on<T = unknown>(channel: string, cb: (data: T, event: IpcRendererEvent) => void): () => void {
  const handler = (_e: IpcRendererEvent, data: T) => cb(data, _e);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const api = {
  bootstrap: {
    health: () => invoke<{ daemon: string; vite: string; ipc: number }>("bootstrap:health"),
    reallocated: () =>
      invoke<
        Array<{
          sessionId: string;
          oldPorts: Record<string, number>;
          newPorts: Record<string, number>;
        }>
      >("bootstrap:reallocated"),
    clientId: () => invoke<string>("bootstrap:clientId"),
    /** P9: true when AGENTDOCK_V2=1 is set in the Electron main env. */
    v2Enabled: () => invoke<boolean>("bootstrap:v2Enabled"),
  },

  // daemon (新架构 §13.1) — direct daemon API access for UI observability
  // and E2E fault injection.
  daemon: {
    health: () =>
      invoke<{
        status: string;
        protocolVersion: string;
        schemaVersion: number;
        state: string;
        capabilities: string[];
        pid: number;
        port: number;
        startedAt?: number;
      }>("daemon:health"),
    debugState: () => invoke<unknown>("daemon:debugState"),
    // P6: v2 /sync full-snapshot. Returns the same v2 three-table shape
    // (state, snapshotSeq, sessions, owners, ports) as a /sync response.
    // Renderer applies this as the baseline, then only SSE events with
    // seq > snapshotSeq — see SyncApplier in electron/main/sync-applier.ts.
    sync: () =>
      invoke<{
        success: boolean;
        state?: "RECOVERING" | "READY";
        snapshotSeq?: number;
        sessions?: Array<{
          sessionId: string;
          projectRoot: string;
          displayName: string;
          status: "creating" | "active" | "deleting";
          createdAt: number;
          ports: Record<string, number>;
        }>;
        owners?: Array<{
          sessionId: string;
          clientId: string;
          pid: number;
          fencingToken: number;
        }>;
        ports?: Array<{ port: number; sessionId: string; name: string }>;
        serverTime?: number;
        lastSeq?: number;
        error?: string;
      }>("daemon:sync"),
    // F11b: Subscribe to daemon v2State push from main process.
    // Main pushes serialized AppliedState via webContents.send("daemon:v2State", serialized).
    // Renderer reconstructs Maps from the tuple format and applies to local state.
    v2State: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      subscribe: (cb: (state: any) => void) => {
        return on("daemon:v2State", cb);
      },
    },
    faultInject: (path: string, body?: unknown) =>
      invoke<{ success: boolean; status?: number; body?: unknown; error?: string }>(
        "daemon:faultInject",
        { path, body },
      ),
    // §3.5 末段 — 三态 net.connect 探测 (running/stopped/unknown).
    // 纯展示用途, 不会反向影响端口归属.
    probeRuntime: (port: number) =>
      invoke<{ state: "running" | "stopped" | "unknown"; elapsedMs: number }>(
        "daemon:probeRuntime",
        { port },
      ),
  },

  db: {
    init: (projectPath: string) => invoke<{ success: true }>("db:init", { projectPath }),
    projects: {
      list: () =>
        invoke<
          Array<{
            id: string;
            name: string;
            path: string;
            createdAt: string;
            sessions: Array<{
              id: string;
              projectId: string;
              name: string;
              branch: string;
              worktreePath: string;
              ports: Record<string, number> | null;
              backgroundHookStatus: string | null;
              createdAt: string;
              /** §4.3.1: 客户端 syncProject() 设置的运行时状态 */
              runtimeStatus?: string;
              userStatus: string | null;
              lastActivatedAt: string | null;
            }>;
          }>
        >("db:projects:list"),
      create: (name: string, path: string) =>
        invoke<{ id: string; name: string; path: string; createdAt: string }>(
          "db:projects:create",
          { name, path },
        ),
      delete: (projectId: string) =>
        invoke<{
          deleted: number;
          sessionIds: string[];
          failed?: Array<{ sessionId: string; stage: string; error: string }>;
        }>("db:projects:delete", projectId),
    },
    sessions: {
      reorder: (projectId: string, sessionIds: string[]) =>
        invoke<{ success: true }>("db:sessions:reorder", { projectId, sessionIds }),
    },
  },

  sync: {
    project: () => invoke<{ synced: number }>("sync:project"),
  },

  sessions: {
    create: (params: { projectId: string; name: string; baseBranch?: string }) =>
      invoke<{ sessionId: string }>("sessions:create", params),
    delete: (sessionId: string) => invoke<{ success: true; error?: string }>("sessions:delete", { sessionId }),
    rename: (sessionId: string, name: string) =>
      invoke<{ success: true }>("sessions:rename", { sessionId, name }),
    reassignPorts: (sessionId: string) =>
      invoke<{ ports: Record<string, number> }>("sessions:reassignPorts", sessionId),
    retryHooks: (sessionId: string) =>
      invoke<{ success: true; status: string }>("sessions:retryHooks", sessionId),
    stream: (sessionId: string) => ({
      onStep: (cb: (step: { step: string; status: string; duration?: number; error?: string }) => void) =>
        on(`session:${sessionId}:step`, cb),
      onComplete: (cb: (result: { success: boolean; error?: string }) => void) =>
        on(`session:${sessionId}:complete`, cb),
    }),
    bgHookStatus: (sessionId: string) =>
      invoke<string | null>("sessions:bgHookStatus", sessionId),
    hookErrors: (sessionId: string) =>
      invoke<unknown[]>("sessions:hookErrors", sessionId),
    setUserStatus: (sessionId: string, status: string | null) =>
      invoke<{ success: true }>("sessions:setUserStatus", { sessionId, status }),
    activate: (sessionId: string) =>
      invoke<{ success: true }>("sessions:activate", { sessionId }),
  },

  // P9: v2 daemon API — direct endpoints for renderer-driven lifecycle.
  // Active when `bootstrap.v2Enabled()` returns true. The handler side
  // forwards to /session/* /takeover /reassign on the daemon.
  sessionsV2: {
    create: (params: { projectId: string; name: string; baseBranch?: string }) =>
      invoke<{ success: boolean; status?: number; body?: unknown; error?: string }>(
        "sessions:v2:create",
        params,
      ),
    delete: (params: { sessionId: string }) =>
      invoke<{ success: boolean; status?: number; body?: unknown; error?: string }>(
        "sessions:v2:delete",
        params,
      ),
    rename: (params: { sessionId: string; name: string }) =>
      invoke<{ success: boolean; status?: number; body?: unknown; error?: string }>(
        "sessions:v2:rename",
        params,
      ),
    reassign: (sessionId: string) =>
      invoke<{ success: boolean; ports?: Record<string, number>; error?: string }>(
        "sessions:v2:reassign",
        { sessionId },
      ),
    status: (sessionId: string) =>
      invoke<"creating" | "active" | "deleting" | null>("sessions:v2:status", { sessionId }),
    takeover: (params: { sessionId: string; fromClientId?: string; fromPid?: number }) =>
      invoke<{ success: boolean; status?: number; body?: unknown; error?: string }>(
        "sessions:v2:takeover",
        params,
      ),
  },

  /**
   * P9 SSE event subscriber. Subscribes to the daemon's `/events` SSE
   * stream via `daemon:events:subscribe`, then forwards every event on
   * the `daemon:events:push` one-way channel to the supplied callback.
   *
   * Returns an unsubscribe function. Heartbeats are filtered server-side.
   */
  sse: {
    subscribe: (cb: (e: { event: string; seq: number; data: unknown }) => void) => {
      // Register the renderer-side listener first, then notify main to
      // start forwarding. The order avoids losing events that arrive
      // between subscribe() returning and the listener attaching.
      const off = on<{ event: string; seq: number; data: unknown }>(
        "daemon:events:push",
        (payload) => cb(payload),
      );
      void invoke<{ success: boolean; error?: string }>("daemon:events:subscribe").catch(
        (err) => {
          // eslint-disable-next-line no-console
          console.warn("[sse.subscribe] main refused:", err);
        },
      );
      return off;
    },
  },

  terminals: {
    create: (sessionId: string, shell?: string) =>
      invoke<{
        terminalId: string;
        sessionId: string;
        shell: string;
        name: string;
        status: string;
        pid: number | null;
        createdAt: string;
      }>("terminals:create", { sessionId, shell }),
    list: (sessionId: string) =>
      invoke<
        Array<{
          terminalId: string;
          sessionId: string;
          shell: string;
          name: string;
          status: string;
          pid: number | null;
          createdAt: string;
        }>
      >("terminals:list", sessionId),
    rename: (terminalId: string, name: string) =>
      invoke<{ success: true }>("terminals:rename", { terminalId, name }),
    write: (terminalId: string, data: string) =>
      invoke<{ success: true }>("terminals:write", { terminalId, data }),
    delete: (terminalId: string) => invoke<{ success: true }>("terminals:delete", terminalId),
    open: (terminalId: string) => invoke<{ ready: true }>("terminals:open", terminalId),
    onPort: (cb: (data: { terminalId: string }, port: MessagePort) => void) => {
      // Two-step delivery — necessary because every other shape breaks
      // somewhere along the boundary:
      //
      // 1. `webContents.postMessage(channel, message, [transfer])` in
      //    main delivers transferred MessagePortMain on `event.ports`
      //    of an ipcRenderer event, NOT on window.message.
      //
      // 2. ContextBridge wraps every value it crosses with — including
      //    the MessagePort — stripping `.start()` / `.onmessage`. If we
      //    handed the port to the renderer through `cb(...)` directly,
      //    the renderer would see a plain object missing methods
      //    (user-reported "port.start is not a function").
      //
      // 3. `window.postMessage(msg, "*", [port])` from preload moves
      //    the NATIVE MessagePort into the renderer's main world with
      //    methods intact — bypassing contextBridge entirely. The
      //    renderer should subscribe via its own
      //    `window.addEventListener("message", ...)` and ignore `cb`.
      //
      // We still install `cb` here for the (currently unused) shape
      // compat with callers; it'll receive a stripped port, which is
      // why terminal-cache.ts goes through window.message instead.
      const handler = (event: Electron.IpcRendererEvent, data: { terminalId: string }) => {
        const port = event.ports?.[0];
        if (!port || !data?.terminalId) return;
        window.postMessage({ type: "terminal:port", terminalId: data.terminalId }, "*", [port]);
      };
      ipcRenderer.on("terminal:port", handler);

      const winHandler = (event: MessageEvent) => {
        if (event.data && (event.data as { type?: string }).type === "terminal:port") {
          const port = event.ports[0];
          if (port) {
            const { terminalId } = event.data as { terminalId: string };
            cb({ terminalId }, port);
          }
        }
      };
      window.addEventListener("message", winHandler);

      return () => {
        ipcRenderer.off("terminal:port", handler);
        window.removeEventListener("message", winHandler);
      };
    },
  },

  fs: {
    browseDirs: (targetPath: string) =>
      invoke<Array<{ name: string; path: string }>>("fs:browseDirs", targetPath),
    files: (relPath: string) =>
      invoke<
        Array<{ name: string; path: string; isDir: boolean; size: number | null }>
      >("fs:files", relPath),
  },

  config: {
    get: (projectId?: string) =>
      invoke<{
        config: unknown;
        exists: boolean;
        yaml: string;
        envPorts: string[];
      }>("config:get", projectId ? { projectId } : undefined),
    save: (config: unknown, projectId?: string) =>
      invoke<{ success: true; yaml: string }>("config:save", { config, projectId }),
  },

  worktree: {
    orphans: (projectId?: string) =>
      invoke<
        Array<{
          sessionId: string;
          worktreePath: string;
          reason: "no-git-file" | "empty-dir" | "orphan-branch";
          branch: string | null;
        }>
      >("worktree:orphans", projectId),
    deleteOrphans: (
      body:
        | { paths?: string[]; branches?: string[]; projectId?: string }
        | string[],
    ) =>
      invoke<{
        deleted: string[];
        failed: Array<{ path?: string; branch?: string; error: string }>;
      }>("worktree:deleteOrphans", body),
  },

  // Git repo check + auto-init — used by the "open project" flow to
  // gate non-git directories behind a user confirmation modal before
  // creating the project. `init` returns { success: true } or
  // { success: false, error } (never throws) so the renderer can
  // surface the underlying message via toast.
  git: {
    isRepo: (dirPath: string) => invoke<boolean>("git:isRepo", dirPath),
    init: (dirPath: string) =>
      invoke<{ success: boolean; error?: string }>("git:init", dirPath),
  },

  shell: {
    openExplorer: (targetPath: string) => invoke<{ success: true }>("shell:openExplorer", targetPath),
    openTerminal: (targetPath: string) => invoke<{ success: true }>("shell:openTerminal", targetPath),
    openPullRequests: (projectId?: string) =>
      invoke<{ url: string }>("shell:openPullRequests", projectId),
  },

  // Window controls for custom titlebar (non-macOS frameless window)
  windowControls: {
    minimize: () => invoke<void>("window:minimize"),
    maximize: () => invoke<void>("window:maximize"),
    close: () => invoke<void>("window:close"),
    isMaximized: () => invoke<boolean>("window:isMaximized"),
    platform: () => invoke<string>("window:platform"),
    onMaximizeChange: (cb: (maximized: boolean) => void) => {
      return on<boolean>("window:maximize-change", cb);
    },
  },

  // Font availability — main pushes "fonts:ready" once the background
  // download finishes so the renderer can trigger a stylesheet refresh.
  fonts: {
    ready: (cb: () => void) => on("fonts:ready", cb),
  },

  // 自动更新事件 (electron-updater + GitHub Releases)
  // 渲染进程可通过这些事件展示更新检查/下载/完成状态。
  updates: {
    onChecking: (cb: () => void) => on("update:checking", cb),
    onAvailable: (cb: (info: unknown) => void) => on("update:available", cb),
    onNotAvailable: (cb: (info: unknown) => void) => on("update:not-available", cb),
    onDownloadProgress: (cb: (progress: { percent: number }) => void) =>
      on("update:download-progress", cb),
    onDownloaded: (cb: (info: unknown) => void) => on("update:downloaded", cb),
    onError: (cb: (err: { message: string }) => void) => on("update:error", cb),
  },

  // App-level commands: version readout + manual update trigger.
  // The settings page uses these to display the current build and let
  // the user force a check outside the 4h interval kicked off at boot.
  app: {
    version: () =>
      invoke<{ version: string; isPackaged: boolean }>("app:version"),
    checkForUpdates: () =>
      invoke<
        | { status: "dev-mode" }
        | { status: "checking" }
        | { status: "available"; info: { version: string } }
        | { status: "not-available"; info: { version: string } }
        | { status: "downloaded"; info: { version: string } }
        | { status: "error"; message: string }
      >("app:checkForUpdates"),
    quitAndInstall: () => invoke<{ ok: boolean }>("app:quitAndInstall"),
  },

  // Per-project todo list
  todos: {
    list: (projectId: string) =>
      invoke<Array<{ id: string; projectId: string; content: string; status: string; sortOrder: number; createdAt: string; updatedAt: string }>>("todos:list", { projectId }),
    create: (projectId: string, content: string) =>
      invoke<{ id: string; projectId: string; content: string; status: string; sortOrder: number; createdAt: string; updatedAt: string }>("todos:create", { projectId, content }),
    cycleStatus: (id: string) =>
      invoke<void>("todos:cycleStatus", { id }),
    update: (id: string, content: string) =>
      invoke<void>("todos:update", { id, content }),
    delete: (id: string) =>
      invoke<void>("todos:delete", { id }),
    reorder: (todoIds: string[]) =>
      invoke<void>("todos:reorder", { todoIds }),
  },

  // Renderer error reporting. Called from ErrorBoundary and the global
  // `window.onerror` / `unhandledrejection` handlers in the renderer.
  // Fire-and-forget — main process logs the error and replies with void.
  //
  // CRITICAL: must use `.catch()` on the returned Promise, not a
  // sync try/catch. A sync try/catch around `void invoke(...)` cannot
  // see the rejected Promise — the rejection would bubble to the
  // renderer's `unhandledrejection` handler, which calls back into
  // reportError → infinite loop.
  reportError: (payload: {
    type: string;
    message: string;
    stack?: string | null;
    componentStack?: string | null;
  }) => {
    invoke<void>("renderer:reportError", payload).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[reportError] failed:", err);
    });
  },
};

contextBridge.exposeInMainWorld("api", api);

export type ApiSurface = typeof api;