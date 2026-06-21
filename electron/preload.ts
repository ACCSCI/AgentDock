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
    faultInject: (path: string, body?: unknown) =>
      invoke<{ success: boolean; status?: number; body?: unknown; error?: string }>(
        "daemon:faultInject",
        { path, body },
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
    delete: (params: { sessionId: string; v2SessionId?: string }) =>
      invoke<{ success: boolean; status?: number; body?: unknown; error?: string }>(
        "sessions:v2:delete",
        params,
      ),
    rename: (params: { sessionId: string; v2SessionId?: string; name: string }) =>
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
          status: string;
          pid: number | null;
          createdAt: string;
        }>
      >("terminals:list", sessionId),
    rename: (terminalId: string, name: string) =>
      invoke<{ success: true }>("terminals:rename", { terminalId, name }),
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

  shell: {
    openExplorer: (targetPath: string) => invoke<{ success: true }>("shell:openExplorer", targetPath),
    openTerminal: (targetPath: string) => invoke<{ success: true }>("shell:openTerminal", targetPath),
  },
};

contextBridge.exposeInMainWorld("api", api);

export type ApiSurface = typeof api;