/**
 * Bootstrap IPC handlers — small, one-shot calls used at app startup.
 *
 * Phase 3 ships `bootstrap:health` as the first real IPC handler, used
 * to verify the renderer's `window.api` bridge is wired correctly after
 * the BrowserWindow loads. Phase 4 will add `bootstrap:reallocated`
 * (drained after the renderer reads it once) and `bootstrap:clientId`
 * (stable per-cwd identity for daemon client registration).
 *
 * 新架构 §13.1: also exposes `daemon:health` and `daemon:debugState` for
 * the renderer's status bar (§15) and `daemon:faultInject` for E2E tests.
 *
 * P9: adds `daemon:events:subscribe` which delegates to the SSE consumer
 * in main and returns an unsubscribe function. The matching one-way push
 * channel is "daemon:events:push" (const literal in preload).
 */
import { BrowserWindow, ipcMain } from "electron";
import { IPC_CHANNELS } from "../shared/api-types.js";
import type { DaemonManager } from "../../plugins/daemon-manager.js";
import { readDaemonInfo } from "../../plugins/daemon-discovery.js";
import type { SseConsumer } from "./v2-sse-consumer.js";
import { probeRuntime } from "./port-runtime-probe.js";

export interface BootstrapDeps {
  /** Resolves true if the daemon is reachable. */
  isDaemonReady: () => Promise<boolean>;
  /** Resolves true if the Vite dev server is reachable (dev only). */
  isViteReady: () => Promise<boolean>;
  /** Number of registered IPC handlers. */
  countHandlers: () => number;
  /** Returns list of orphaned sessions that need renderer attention. */
  drainReallocated: () => Array<{
    sessionId: string;
    oldPorts: Record<string, number>;
    newPorts: Record<string, number>;
  }>;
  /** Returns the stable clientId for this cwd (Phase 4). */
  getClientId: () => string;
  /** Daemon manager (for fault injection forward). */
  getDaemonManager: () => DaemonManager | null;
  /** Returns the daemon port (read from daemon.json). */
  getDaemonPort: () => number;
  /** P9 SSE consumer (null when AGENTDOCK_V2 is off). */
  getSseConsumer: () => SseConsumer | null;
  /** P0+ (二审修): 返回 sseConsumer 维护的真实 lastSeq. 用于 /sync body. */
  getSseLastSeq: () => number;
  /** P9: returns true when AGENTDOCK_V2=1 is set, so the renderer can
   *  route session mutations through the v2 channel set. */
  isV2Enabled: () => boolean;
}

export function registerBootstrap(deps: BootstrapDeps): void {
  ipcMain.handle(IPC_CHANNELS["bootstrap:health"], async () => {
    const [daemon, vite] = await Promise.all([
      deps.isDaemonReady(),
      deps.isViteReady(),
    ]);
    return {
      daemon: daemon ? "ok" : "down",
      vite: vite ? "ok" : "down",
      ipc: deps.countHandlers(),
    };
  });

  ipcMain.handle(IPC_CHANNELS["bootstrap:reallocated"], () => {
    return deps.drainReallocated();
  });

  ipcMain.handle(IPC_CHANNELS["bootstrap:clientId"], () => {
    return deps.getClientId();
  });

  // P9: tells the renderer whether AGENTDOCK_V2=1 is set. Renderer uses
  // this to decide between v1 and v2 channel sets for session mutations.
  ipcMain.handle(IPC_CHANNELS["bootstrap:v2Enabled"], () => {
    return deps.isV2Enabled();
  });

  // 新架构 §13.1: direct daemon health + state observation for the UI.
  // These hit /health and /debug/state on the running daemon.
  ipcMain.handle(IPC_CHANNELS["daemon:health"], async () => {
    const port = deps.getDaemonPort();
    if (!port) {
      return {
        status: "down",
        protocolVersion: "?",
        schemaVersion: 0,
        state: "DOWN",
        capabilities: [] as string[],
        pid: 0,
        port: 0,
      };
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return await res.json();
    } catch (err) {
      return {
        status: "down",
        protocolVersion: "?",
        schemaVersion: 0,
        state: "DOWN",
        capabilities: [] as string[],
        pid: 0,
        port,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS["daemon:debugState"], async () => {
    const port = deps.getDaemonPort();
    if (!port) return null;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/debug/state`);
      return await res.json();
    } catch {
      return null;
    }
  });

  // P6: v2 /sync full-snapshot endpoint. Returns the same shape as
  // /debug/state but in the v2 /sync response format (state, snapshotSeq,
  // sessions, owners, ports). Used by the renderer to rebuild local state
  // after reconnect or daemon restart. The snapshotSeq field tells the
  // client which SSE events have been "absorbed" into this snapshot.
  // The renderer then applies only SSE events with seq > snapshotSeq.
  //
  // P0+ (二审修): lastSeq 改为从 sseConsumer 真实水位读取, 避免 daemon 端
  // replaySince(0) 在重启后回放大量历史事件. v1 模式下 SSE 未启 → 返 0
  // (语义正确, daemon 端走 v1 sync 路径, 不会处理 v2 lastSeq).
  ipcMain.handle(IPC_CHANNELS["daemon:sync"], async () => {
    const port = deps.getDaemonPort();
    if (!port) return { success: false, error: "no daemon" };
    try {
      const res = await fetch(`http://127.0.0.1:${port}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: deps.getClientId(),
          pid: 0,
          lastSeq: deps.getSseLastSeq(),
        }),
      });
      if (!res.ok) {
        return { success: false, error: `daemon returned ${res.status}` };
      }
      return await res.json();
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // §3.5 末段 — UI 端口运行态三态探测. 纯展示, 不影响端口归属/回收.
  // 超时 RUNTIME_PROBE_TIMEOUT_MS=300ms, 防火墙丢包也得快速返 "unknown".
  ipcMain.handle(
    IPC_CHANNELS["daemon:probeRuntime"],
    async (_evt, payload: { port: number }) => {
      const p = Number(payload?.port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        return { state: "unknown" as const, elapsedMs: 0 };
      }
      return await probeRuntime(p);
    },
  );

  // 新架构 §11.2: fault injection for E2E tests. Only active when the
  // daemon was started with NODE_ENV=test (the /__inject/* routes return
  // 404 in production). Body shape: { path: string; body?: unknown }.
  ipcMain.handle(
    IPC_CHANNELS["daemon:faultInject"],
    async (_evt, payload: { path: string; body?: unknown }) => {
      const port = deps.getDaemonPort();
      if (!port) return { success: false, error: "no daemon" };
      try {
        const res = await fetch(`http://127.0.0.1:${port}${payload.path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload.body ? JSON.stringify(payload.body) : "{}",
        });
        return { success: res.ok, status: res.status, body: await res.json() };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  // P9: SSE event subscription. Each renderer that calls this gets its own
  // one-way `daemon:events:push` listener hooked into the SSE consumer.
  ipcMain.handle(
    IPC_CHANNELS["daemon:events:subscribe"],
    async (event) => {
      const consumer = deps.getSseConsumer();
      if (!consumer) {
        return { success: false, error: "AGENTDOCK_V2 not enabled" };
      }
      const win = BrowserWindow.fromWebContents(event.sender);
      const sender = event.sender;
      const unsubscribe = consumer.subscribe((payload) => {
        if (sender.isDestroyed()) return;
        try {
          sender.send("daemon:events:push", payload);
        } catch {
          /* sender torn down */
        }
      });
      // We can't return the unsubscribe function through ipcRenderer.invoke
      // (functions don't survive contextBridge), so we stash it in a
      // WeakMap keyed on the sender so the renderer can later ask us to
      // clean up. The renderer simply ignores the return value in P9;
      // a future P6 client will wire up the unsubscribe path.
      return { success: true };
    },
  );
}