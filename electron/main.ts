/**
 * Electron Main Process Entry
 *
 * Phase 3: full implementation.
 *
 * Responsibilities:
 *   1. Spawn the daemon (Hono server) as a child process
 *   2. Connect a typed Hono client to it
 *   3. Register all IPC handlers (Phase 3 ships bootstrap; Phase 4 adds the rest)
 *   4. Create the BrowserWindow and load the renderer
 *   5. Handle lifecycle (before-quit cleanup, before-quit→exit, etc.)
 *
 * Dev mode: electron-vite injects ELECTRON_RENDERER_URL pointing at the
 * Vite dev server. We loadURL it once it's ready.
 *
 * Prod mode: loadFile from the renderer dist (dist/index.html).
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { eq } from "drizzle-orm";
import { generateClientId } from "./main/client-id.js";
import { DaemonManager } from "../plugins/daemon-manager.js";
import { createDaemonClient, type DaemonHonoClient } from "./main/hono-client.js";
import { IPC_CHANNELS, IPC_CHANNEL_COUNT } from "./shared/api-types.js";
import { registerAllIpc, type AllIpcDeps } from "./main/ipc/index.js";
import { log } from "../plugins/logger.js";
import { terminalManager } from "../plugins/terminal-manager.js";
import { writePortsToEnv } from "../plugins/port-write-env.js";
import {
  ensureActiveDb,
  getActiveDb,
} from "../plugins/db/index.js";
import * as schema from "../plugins/db/schema.js";
import { createV2PortService, type V2PortServiceHandle } from "../plugins/v2-port-service.js";
import { SseConsumer } from "./main/v2-sse-consumer.js";

// Resolve paths relative to this file (works in both dev and prod).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Module-level state, all owned by the singleton app instance.
let mainWindow: BrowserWindow | null = null;
let daemonManager: DaemonManager | null = null;
let daemonClient: DaemonHonoClient | null = null;
let reallocatedQueue: Array<{
  sessionId: string;
  oldPorts: Record<string, number>;
  newPorts: Record<string, number>;
}> = [];
// P9: v2 service + SSE consumer (only populated when AGENTDOCK_V2=1).
let v2PortService: V2PortServiceHandle | null = null;
let sseConsumer: SseConsumer | null = null;

// Foreign session tracking — mirrors master's _sessionStatuses map.
// Tracks runtime ownership status per session across IPC calls:
//   "owned"      — this Electron owns it (claimed via sync.declare)
//   "foreign"    — another live Electron owns it (can't modify)
//   "reclaimed"  — was foreign, but previous owner went stale → took ownership
//   "allocated"  — brand new session, just created by this Electron
// Reset on db:init so stale entries don't leak between project switches.
const sessionStatuses = new Map<string, string>();
function getSessionStatus(sessionId: string): string {
  return sessionStatuses.get(sessionId) ?? "owned";
}
function setSessionStatus(sessionId: string, status: string): void {
  sessionStatuses.set(sessionId, status);
}
function clearSessionStatuses(): void {
  sessionStatuses.clear();
}

// Active project path (set by db:init IPC handler). When null, db/sessions
// handlers throw. Renderer's first call should be db:init with a project path.
let activeProjectPath: string | null = null;

// §6 — clientId 进程级唯一 (hostname + pid + 启动时间戳 + 随机后缀).
// 详见 electron/main/client-id.ts.
const clientId = generateClientId();

// Heartbeat: every 30 s. Daemon's HEARTBEAT_TIMEOUT_MS is 90 s, so
// missing two heartbeats marks us stale and the daemon releases our
// sessions on the next cleanup tick. 30 s aligns with daemon's
// HEARTBEAT_PERSIST_INTERVAL_MS so every successful beat persists.
const HEARTBEAT_INTERVAL_MS = 30_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

async function registerClientWithDaemon(): Promise<void> {
  if (!daemonClient) return;
  // projectPaths starts as just cwd — auto-init below will set it. The
  // daemon stores this for diagnostic / future routing; it doesn't
  // enforce anything off it today.
  try {
    const res = await daemonClient.client.register.$post({
      json: { clientId, pid: process.pid, projectPaths: [process.cwd()] },
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "client/register non-2xx");
    }
  } catch (err) {
    log.warn({ err }, "client/register failed");
  }
}

function startHeartbeatLoop(): void {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (!daemonClient) return;
    void daemonClient.client.heartbeat
      .$post({ json: { clientId } })
      .catch((err) => log.warn({ err }, "heartbeat failed"));
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive just for heartbeats during shutdown.
  if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
}

// §7 — v2 path 30s 全量 sync 循环 (兼 heartbeat). SSE 推送增量, /sync
// 提供全量兜底 + 维持 daemon 端 client 活性 (HEARTBEAT_TIMEOUT 90s).
// v2 路径不走 v1 /client/heartbeat, 因此**必须**有自己的周期调用.
let v2SyncTimer: ReturnType<typeof setInterval> | null = null;
function startV2SyncLoop(daemonPort: number): void {
  if (v2SyncTimer) clearInterval(v2SyncTimer);
  const tick = async (): Promise<void> => {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonPort}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, pid: process.pid, lastSeq: 0 }),
      });
      if (!res.ok) {
        log.debug({ status: res.status }, "v2 /sync non-2xx");
      }
    } catch (err) {
      // 网络错: 静默 — SSE 还在跑, 30s 后重试
      log.debug({ err }, "v2 /sync failed");
    }
  };
  v2SyncTimer = setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS);
  if (typeof v2SyncTimer.unref === "function") v2SyncTimer.unref();
  // 立即跑一次, 不等 30s
  void tick();
}

async function unregisterClientWithDaemon(): Promise<void> {
  if (!daemonClient) return;
  try {
    await daemonClient.client.unregister.$post({ json: { clientId } });
  } catch (err) {
    log.warn({ err }, "client/unregister failed (non-fatal at shutdown)");
  }
}

/**
 * Walk every session in the active project's DB and declare them to
 * the daemon. Anything coming back as `status: "reallocated"` means
 * the original ports got taken by an external process between
 * shutdowns — persist the new ports, rewrite the worktree `.env`,
 * and stash an entry in `reallocatedQueue` for the renderer's
 * `bootstrap:reallocated` IPC to pick up.
 *
 * Runs once per boot, after daemon connect + register. Quietly
 * no-ops when the DB doesn't exist yet (fresh install).
 */
async function reconcileAndDeclareSessions(): Promise<void> {
  if (!daemonClient || !activeProjectPath) return;
  let db: ReturnType<typeof ensureActiveDb>;
  try {
    db = ensureActiveDb(activeProjectPath);
  } catch (err) {
    log.warn({ err }, "reconcile: DB unavailable, skipping declare");
    return;
  }

  let rows: Array<{
    id: string;
    projectId: string;
    worktreePath: string;
    ports: string | null;
  }>;
  try {
    rows = db
      .select({
        id: schema.sessions.id,
        projectId: schema.sessions.projectId,
        worktreePath: schema.sessions.worktreePath,
        ports: schema.sessions.ports,
      })
      .from(schema.sessions)
      .all();
  } catch (err) {
    log.warn({ err }, "reconcile: failed to read sessions");
    return;
  }
  if (rows.length === 0) return;

  // Resolve each session's owning project path. The /sync/declare
  // schema requires worktreePath + projectPath per entry; pulling
  // project.path out of the join keeps the daemon's directory
  // lookup correct in multi-project setups.
  const projectById = new Map<string, string>();
  for (const p of db.select().from(schema.projects).all()) {
    projectById.set(p.id, p.path);
  }

  const declared = rows
    .map((r) => {
      const projectPath = projectById.get(r.projectId);
      if (!projectPath) return null;
      const ports = r.ports
        ? (JSON.parse(r.ports) as Record<string, number>)
        : null;
      return {
        sessionId: r.id,
        worktreePath: r.worktreePath,
        projectPath,
        ports,
        portKeys: ports ? Object.keys(ports) : undefined,
      };
    })
    .filter((s): s is NonNullable<typeof s> => s !== null);
  if (declared.length === 0) return;

  try {
    const res = await daemonClient.sync.declare.$post({
      json: { clientId, sessions: declared },
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "sync/declare non-2xx");
      return;
    }
    const body = (await res.json()) as {
      results: Array<{ sessionId: string; ports: Record<string, number>; status: string }>;
      orphans: string[];
    };
    for (const r of body.results) {
      if (r.status !== "reallocated") continue;
      const before = rows.find((x) => x.id === r.sessionId);
      if (!before) continue;
      const oldPorts = before.ports
        ? (JSON.parse(before.ports) as Record<string, number>)
        : {};
      reallocatedQueue.push({
        sessionId: r.sessionId,
        oldPorts,
        newPorts: r.ports,
      });
      try {
        db.update(schema.sessions)
          .set({ ports: JSON.stringify(r.ports) })
          .where(eq(schema.sessions.id, r.sessionId))
          .run();
        writePortsToEnv(before.worktreePath, r.ports, before.projectPath);
      } catch (err) {
        log.warn(
          { err, sessionId: r.sessionId },
          "reconcile: persist reallocated ports failed",
        );
      }
    }
    if (body.orphans.length > 0) {
      log.info(
        { orphans: body.orphans },
        "reconcile: daemon reported orphan sessions (sessions whose owner client is gone)",
      );
    }
  } catch (err) {
    log.warn({ err }, "sync/declare threw");
  }
}

async function waitForViteReady(url: string, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function isViteReady(): Promise<boolean> {
  const url = process.env.ELECTRON_RENDERER_URL;
  if (!url) return false;
  try {
    const res = await fetch(url);
    return res.ok || res.status < 500;
  } catch {
    return false;
  }
}

async function isDaemonReady(): Promise<boolean> {
  if (!daemonClient) return false;
  try {
    const res = await daemonClient.health.$get();
    return res.ok;
  } catch {
    return false;
  }
}

function countHandlers(): number {
  // ipcMain has no public count API, but we know exactly how many we
  // registered. Phase 4+ will register the rest; this is the canonical
  // count that bootstrap:health reports.
  return IPC_CHANNEL_COUNT;
}

function drainReallocated() {
  const list = reallocatedQueue;
  reallocatedQueue = [];
  return list;
}

function createWindow(): BrowserWindow {
  // e2e/debug knob — when AGENTDOCK_E2E_DEVTOOLS=1 the test runner (or a
  // developer reproducing a failure) gets a detached DevTools window so
  // they can inspect React state / network / storage from outside the
  // automated Playwright session.
  const wantDevTools = process.env.AGENTDOCK_E2E_DEVTOOLS === "1";

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "AgentDock",
    show: false, // Show after ready-to-show to avoid white flash
    webPreferences: {
      // electron-vite emits main → out/main/main.js, preload → out/preload/preload.mjs.
      // Walk up one dir to find the sibling preload bundle.
      preload: resolve(__dirname, "../preload/preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs node-pty access via main IPC
      devTools: wantDevTools || process.env.NODE_ENV !== "production",
    },
  });

  if (wantDevTools) {
    mainWindow.webContents.once("did-finish-load", () => {
      mainWindow?.webContents.openDevTools({ mode: "detach" });
    });
  }

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  return mainWindow;
}

async function bootstrap() {
  log.info({ pid: process.pid }, "AgentDock main starting");

  // 1. Spawn the daemon (Phase 1: Hono server)
  // Tell daemon-manager to use non-detached spawn (Electron's process
  // tree cleanup can kill detached children on Windows).
  process.env.AGENTDOCK_ELECTRON = "1";
  // Daemon is a machine-level singleton at ~/.agentdock/ — all Electron
  // instances on this machine share it. No env override; the path is
  // hardcoded so there's exactly one daemon per developer machine.
  daemonManager = new DaemonManager();
  // Phase 3: when running from the bundled main.js, the original
  // __dirname-relative lookup for `daemon.js` / `daemon.ts` doesn't work
  // (main is at out/main/main.js, daemon is at plugins/daemon.ts).
  // Tell the manager to spawn an explicit entry point.
  daemonManager.daemonEntry = resolve(__dirname, "../../plugins/daemon.ts");
  // Use bun to run the TS daemon natively (no tsx loader needed). bun is
  // already a project dep (used for scripts), so it ships in node_modules.
  process.env.AGENTDOCK_USE_BUN = "1";
  log.info({ entry: daemonManager.daemonEntry, cwd: process.cwd() }, "spawning daemon");
  try {
    const { client } = await daemonManager.init();
    daemonClient = createDaemonClient(`http://127.0.0.1:${client.port}`);
    log.info({ port: client.port }, "daemon connected");
  } catch (err) {
    log.error({ err, msg: String(err) }, "failed to start daemon");
    // Surface the failure to stderr but guard against EPIPE (Electron's
    // error dialog tries to forward to DevTools; if no renderer is
    // listening, the write fails with EPIPE and an uncaught-exception
    // dialog appears on top of our own).
    try {
      process.stderr.write(`[agentdock] daemon start failed: ${String(err)}\n`);
    } catch {
      // stderr already closed; nothing to do.
    }
    // Phase 4+ will degrade gracefully (show a UI banner); for now, exit.
    app.exit(1);
    return;
  }

  // 2. Register ALL IPC handlers (Phase 4: 29 channels + 3 daemon channels)
  // Cached daemon port — daemonClient.port is set once at init() and
  // doesn't move. readDaemonInfo() reads the file again on every call,
  // which races with daemon startup (daemon.json may not exist yet).
  let cachedDaemonPort = 0;
  try {
    const { client } = await daemonManager.init();
    daemonClient = createDaemonClient(`http://127.0.0.1:${client.port}`);
    cachedDaemonPort = client.port;
    log.info({ port: client.port }, "daemon connected");
  } catch (err) {
    log.error({ err, msg: String(err) }, "failed to start daemon");
    // Cache stays 0; bootstrap handlers will return "down".
  }

  const ipcDeps: AllIpcDeps = {
    getDaemonClient: () => daemonClient,
    getDaemonManager: () => daemonManager,
    getClientId: () => clientId,
    getProjectPath: () => activeProjectPath,
    setProjectPath: (p) => {
      activeProjectPath = p;
    },
    getDaemonPort: () => cachedDaemonPort,
    drainReallocated: () => {
      const list = reallocatedQueue;
      reallocatedQueue = [];
      return list;
    },
    getSessionStatus,
    setSessionStatus,
    clearSessionStatuses,
    isViteReady,
    isDaemonReady,
    countHandlers,
    getV2PortService: () => v2PortService,
    getSseConsumer: () => sseConsumer,
    isV2Enabled: () => process.env.AGENTDOCK_V2 === "1",
  };

  // P9: when AGENTDOCK_V2=1, build the v2 PortService and SSE consumer.
  // v2 service handles /session/create → /claim × N → /session/activate
  // with fencingToken caching and lease renewal. SSE consumer forwards
  // /events to renderer via daemon:events:push.
  if (process.env.AGENTDOCK_V2 === "1" && cachedDaemonPort > 0) {
    try {
      v2PortService = createV2PortService({
        baseUrl: `http://127.0.0.1:${cachedDaemonPort}`,
        clientId,
        pid: process.pid,
        getProjectRoot: () => activeProjectPath ?? process.cwd(),
      });
      sseConsumer = new SseConsumer({
        baseUrl: `http://127.0.0.1:${cachedDaemonPort}`,
        onEvent: (e) => {
          // Filter heartbeats — too noisy for the renderer.
          if (e.event === "heartbeat") return;
          log.debug({ event: e.event, seq: e.seq }, "sse event");
        },
        onReconnect: () => {
          log.info("sse reconnected");
        },
        // §5.3 — 断线立即触发: 拉一次 /sync 全量同步, 比对本地 v2 sessions
        // 与 daemon 状态, 对缺失/漂移的 session 走重注册(经过 RECOVERING 闸门).
        onDisconnect: () => {
          log.warn("sse disconnected — triggering §5.3 full re-sync");
          void fullResyncAfterDisconnect(cachedDaemonPort, v2PortService);
        },
        onClose: () => {
          log.warn("sse closed");
        },
      });
      sseConsumer.start();
      // §7 — 30s 全量 sync 循环 (兼 heartbeat). v2 path 走 /sync, 兼
      // 维持 daemon 端 client 活性 (否则 HEARTBEAT_TIMEOUT 90s 会把
      // 我们的 session 整批释放). SSE 推送的是增量, /sync 提供 fallback
      // 兜底 + 全量状态修正.
      startV2SyncLoop(cachedDaemonPort);
      log.info({ port: cachedDaemonPort }, "AGENTDOCK_V2 enabled");
    } catch (err) {
      log.error({ err }, "v2 service / sse consumer init failed");
    }
  }

  registerAllIpc(ipcDeps);

  // Auto-init the active project to the current working directory so the
  // renderer's useProjects hook (which calls db:projects:list on mount)
  // works without an explicit db:init round-trip. Matches the original
  // api.ts behavior where the cwd was treated as the implicit project.
  try {
    activeProjectPath = process.cwd();
    log.info({ projectPath: activeProjectPath }, "auto-set active project to cwd");
  } catch (err) {
    log.warn({ err }, "failed to auto-set active project");
  }

  log.info({ ipcChannels: IPC_CHANNEL_COUNT }, "IPC handlers registered");

  // Now that activeProjectPath is set + DB module knows where to look,
  // run the deferred reconcile. (registerClient + heartbeat happened
  // earlier; reconcile needs activeProjectPath so we do it here.)
  await reconcileAndDeclareSessions();

  // 3. Create the window and load the renderer
  const win = createWindow();
  const devUrl = process.env.ELECTRON_RENDERER_URL;

  if (devUrl) {
    log.info({ devUrl }, "loading renderer from Vite dev server");
    const ready = await waitForViteReady(devUrl);
    if (!ready) {
      log.error({ devUrl }, "Vite dev server not ready in time");
      app.exit(1);
      return;
    }
    await win.loadURL(devUrl);
  } else {
    const indexPath = resolve(__dirname, "../renderer/index.html");
    log.info({ indexPath }, "loading renderer from built dist");
    await win.loadFile(indexPath);
  }

  log.info("window loaded");
}

app.whenReady().then(bootstrap).catch((err) => {
  log.error({ err }, "bootstrap failed");
  app.exit(1);
});

app.on("before-quit", (e) => {
  // Synchronous cleanup of PTYs (Phase 4+), unregister client, then exit.
  // Currently Phase 3 has no PTYs to clean; just shut down the daemon
  // child so we don't leak it.
  e.preventDefault();
  log.info("AgentDock shutting down");

  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // P9: stop the SSE consumer + dispose v2 service so their timers
  // don't keep the event loop alive past app exit.
  if (sseConsumer) {
    sseConsumer.stop();
    sseConsumer = null;
  }
  if (v2PortService) {
    v2PortService.dispose();
    v2PortService = null;
  }

  // Unregister BEFORE killing the daemon child. If we're the leader,
  // the daemon dies in daemonManager.shutdown() and the unregister
  // call would race; we fire-and-forget with a short timeout.
  const unregister = unregisterClientWithDaemon();
  const timeout = new Promise((r) => setTimeout(r, 500));
  Promise.race([unregister, timeout]).finally(() => {
    if (daemonManager) {
      try {
        daemonManager.shutdown();
      } catch (err) {
        log.warn({ err }, "daemon shutdown error (non-fatal)");
      }
    }
    setImmediate(() => app.exit(0));
  });
});

app.on("window-all-closed", () => {
  // macOS keeps apps alive without windows; everywhere else we quit.
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  // macOS dock-click reopens a window when none are open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

/**
 * Swallow EPIPE / ERR_IPC_CHANNEL_CLOSED during shutdown.
 *
 * Symptom (real, reported): user creates a session and closes the window
 * mid-lifecycle. The fire-and-forget `runLifecycle` keeps running; it
 * hits a `console.log` (from session-lifecycle's tracing) whose
 * underlying stdout pipe has been closed by Electron's window-teardown
 * → EPIPE → Node sees an uncaught exception → Electron pops a "A
 * JavaScript error occurred in the main process" dialog.
 *
 * The two error families are both shutdown noise:
 *   - EPIPE: stdout/stderr pipe gone (console.log, pino, etc.)
 *   - ERR_IPC_CHANNEL_CLOSED: `event.sender.send` on a destroyed WebContents
 *
 * Anything else still surfaces — those are real bugs we want to see.
 */
function isShutdownNoise(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as NodeJS.ErrnoException;
  if (e.code === "EPIPE") return true;
  if (e.code === "ERR_IPC_CHANNEL_CLOSED") return true;
  return false;
}

/**
 * §5.3 — 断线立即全量重注册.
 *
 * 触发: SseConsumer.onDisconnect (TCP 断开但 reconnect 未完成).
 * 步骤:
 *   1. POST /sync — 拿到 daemon 当前三表权威快照 (含 ports 数组).
 *   2. 对**所有**本地 active/creating session 调 /claim 重新注册
 *      (走 RECOVERING 闸门, expected 集合放行), 携带**当前端口作
 *      preferredPort** (从 /sync 响应的 ports 字段按 (sessionId, name)
 *      查找). 这样 daemon 端已知端口的 session 不会被换掉, RECOVERING
 *      窗口收不齐的场景 (daemon WAL 滞后) 也能让 client 主动重建.
 *   3. /claim 失败 (RECOVERING 期陌生 sessionId) 仅打 warn, 不抛 —
 *      SSE 重连后由后续增量 + onResyncRequired 继续收敛.
 *
 * 错误处理: 任何步骤失败仅打 warn, 不抛.
 */
async function fullResyncAfterDisconnect(
  daemonPort: number,
  v2: V2PortServiceHandle | null,
): Promise<void> {
  if (!v2) return; // v1 模式或未启用 — 留给 v1 sync/declare 自己处理
  try {
    const syncRes = await fetch(`http://127.0.0.1:${daemonPort}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, pid: process.pid, lastSeq: 0 }),
    });
    if (!syncRes.ok) {
      log.warn({ status: syncRes.status }, "§5.3 resync /sync non-OK");
      return;
    }
    const body = (await syncRes.json()) as {
      sessions: Array<{ sessionId: string; status: string }>;
      ports?: Array<{ port: number; sessionId: string; name: string }>;
    };
    // 索引: v2SessionId → (name → port). 给 /claim 携带 preferredPort 用.
    const portsByV2Sid = new Map<string, Map<string, number>>();
    for (const p of body.ports ?? []) {
      let inner = portsByV2Sid.get(p.sessionId);
      if (!inner) {
        inner = new Map();
        portsByV2Sid.set(p.sessionId, inner);
      }
      inner.set(p.name, p.port);
    }
    // §5.3 — 对**所有**本地 active/creating session 走 /claim 重注册.
    // 不只针对 daemon 缺失的 session — 哪怕 daemon 端还在, RECOVERING
    // 闸门放行时 client 端再 claim 一次可让 daemon 三表确认 owner 身份
    // (有助 §5.2 收齐 reported 集合, 缩短 RECOVERING 窗口).
    const known = v2.listKnownSessions();
    for (const ks of known) {
      const portMap = portsByV2Sid.get(ks.v2SessionId);
      log.info(
        {
          appSid: ks.appSessionId,
          v2Sid: ks.v2SessionId,
          portKeys: ks.portKeys,
          preferredPorts: portMap ? Object.fromEntries(portMap) : null,
        },
        "§5.3 re-claim session after disconnect",
      );
      for (const name of ks.portKeys) {
        const requestedPort = portMap?.get(name); // undefined = daemon 无记录
        try {
          const res = await fetch(`http://127.0.0.1:${daemonPort}/claim`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: ks.v2SessionId,
              fencingToken: ks.fencingToken,
              name,
              ...(requestedPort !== undefined ? { requestedPort } : {}),
            }),
          });
          if (!res.ok) {
            log.warn(
              { status: res.status, name, v2Sid: ks.v2SessionId },
              "§5.3 re-claim failed (may be RECOVERING)",
            );
          }
        } catch (err) {
          log.warn({ err, name }, "§5.3 re-claim network failed");
        }
      }
    }
  } catch (err) {
    log.warn({ err }, "§5.3 full resync failed");
  }
}

process.on("uncaughtException", (err) => {
  if (isShutdownNoise(err)) {
    // Best-effort log via stderr — if stderr itself is broken, swallow.
    try {
      process.stderr.write(`[main] swallowed shutdown noise: ${(err as Error).message}\n`);
    } catch {
      // truly nothing we can do
    }
    return;
  }
  try {
    log.error({ err }, "uncaught exception in main process");
  } catch {
    // logger dead too; let Electron surface it
    throw err;
  }
});

process.on("unhandledRejection", (reason) => {
  if (isShutdownNoise(reason)) {
    try {
      process.stderr.write(
        `[main] swallowed shutdown rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`,
      );
    } catch {
      // nothing to do
    }
    return;
  }
  try {
    log.error({ reason }, "unhandled promise rejection in main process");
  } catch {
    // logger dead; ignore
  }
});

// Export internals for test access (Phase 3 acceptance inspects them).
export const __test__ = {
  getMainWindow: () => mainWindow,
  getDaemonClient: () => daemonClient,
  getClientId: () => clientId,
  getReallocatedQueue: () => reallocatedQueue,
  countIpcHandlers: () => Object.keys((ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers ?? new Map()).length,
};
