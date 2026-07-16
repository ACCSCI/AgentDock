// @ts-nocheck
/**
 * DaemonContext — shared state for all routes.
 *
 * Phase 1: Hono refactor of plugins/daemon.ts. The context holds every piece
 * of mutable state the daemon needs (registry, state, wal, allocator, mutex)
 * so individual route modules can consume it via Hono's `c.var.ctx`.
 *
 * Lifecycle:
 *   const ctx = makeContext({ baseDir, port });
 *   const app = createApp(ctx);
 *   const server = serve({ fetch: app.fetch, port: ctx.port, hostname: '127.0.0.1' });
 *
 * The Hono app does NOT own this state — it only reads/writes through the
 * context. This keeps each route module pure (no module-level singletons).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// §11.5 C4 — re-exported from plugins/constants.ts so all callers resolve to
// the SAME single source of truth. Previously context.ts re-declared
// HEARTBEAT_PERSIST_INTERVAL_MS as 30_000, causing 6× divergence from the
// canonical 5_000 in constants.ts depending on import path.
import {
  HEARTBEAT_PERSIST_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  SYNC_INTERVAL_MS,
} from "../constants.js";
import { DaemonStateV2 } from "../daemon-state-v2.js";
import { DaemonState } from "../daemon-state.js";
import { DaemonWALV2 } from "../daemon-wal-v2.js";
import { DaemonWAL } from "../daemon-wal.js";
import { type FaultInjectorState, createFaultInjectorState } from "../fault-injector.js";
import { Mutex } from "../mutex.js";
import { FilePortAllocator, type PortAllocator } from "../port-allocator.js";
import { SseBus } from "../sse-bus.js";

/** Tunables — same constants the old AgentDockDaemon used. */
export { HEARTBEAT_PERSIST_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS };
/** §7 — Heartbeat check interval; equal to SYNC_INTERVAL_MS (single source of truth). */
export const HEARTBEAT_CHECK_INTERVAL_MS = SYNC_INTERVAL_MS;

export interface DaemonOptions {
  /** Port to listen on. Default: 0 (OS-assigned random port). */
  port?: number;
  /** Base directory for state files. Default: ~/.agentdock */
  baseDir?: string;
  /**
   * §5.2 — RECOVERING softMin override. Tests pass 0 to skip the 2s soft
   * floor and exit RECOVERING immediately on first tick. Production
   * defaults to RECOVERING_SOFT_MIN_MS (2s).
   */
  recoveringSoftMinMs?: number;
}

export interface RegistryEntry {
  dir: string;
  pid: number;
  startedAt: string;
}

/** Counter bundle for /metrics (新架构 §11.1). v3 increments these from
 * routes; values reset only on daemon restart. */
export interface DaemonMetrics {
  claimCount: number;
  conflictCount: number;
  releaseCount: number;
  heartbeatTimeoutCount: number;
  activeSessionCount: number;
  sseConnections: number;
}

export interface DaemonContext {
  /** Base directory for state files. */
  baseDir: string;
  /** Path to registry.json */
  registryPath: string;
  /** In-memory instance registry (mirrored to registry.json on every change). */
  registry: Map<string, RegistryEntry>;
  /** Session/client authoritative state (v1 — legacy routes). */
  state: DaemonState;
  /** Write-ahead log for session/client persistence (v1). */
  wal: DaemonWAL;
  /**
   * v2 three-table state (新架构 §4.1). Loaded alongside the v1 state so
   * the new API routes (/session/*, /claim, /release, /takeover, etc.)
   * can run without touching the legacy v1 surface. P3 wires this up;
   * P4 adds RECOVERING transitions; P5 adds SSE.
   */
  stateV2: DaemonStateV2;
  /** v2 WAL with auto v1→v2 migration. */
  walV2: DaemonWALV2;
  /** SSE event bus (新架构 §7.3). v2 routes publish on state changes. */
  sseBus: SseBus;
  /** Fault injection state (新架构 §11.2). Active iff NODE_ENV=test. */
  faults: FaultInjectorState;
  /** Port allocator (file-locked, OS-assigned range). */
  allocator: PortAllocator;
  /** Process-local mutex for state mutations and port operations. */
  mutex: Mutex;
  /**
   * Per-client timestamp of last WAL persistence. Heartbeat updates this map
   * so we only write to disk every HEARTBEAT_PERSIST_INTERVAL_MS per client.
   */
  lastPersistedHeartbeatAt: Map<string, number>;
  /** Configured port (0 means OS-assigned). The actual bound port is in state. */
  port: number;
  /** The actual port the server is bound to (set after start()). */
  actualPort: number;
  /** Process start timestamp (ms epoch). Set at makeContext(). */
  startedAt: number;
  /** Monotonic counter for SSE event seq (新架构 §7.3). */
  lastSeq: number;
  /** Counter bundle for /metrics. */
  metrics: DaemonMetrics;
  /** Loads registry.json into this.registry (no-op if missing). */
  loadRegistry(): void;
  /** Persists this.registry to registry.json (atomic write). */
  saveRegistry(): void;
  /** Returns true if a process with the given PID is alive (signal 0 probe). */
  isProcessAlive(pid: number): boolean;
  /**
   * §5.2 — RECOVERING 控制器引用. server.ts 在 onListen 时挂上, v2 routes
   * 通过它判 RECOVERING 期 claim 是否放行.
   */
  recovering?: {
    isRecovering(): boolean;
    recordReport(sessionId: string): void;
  };
  /**
   * §5.2 — RECOVERING 期的 expected sessionId 集合 (WAL 快照 + 本轮已上报).
   * 由 server.ts 注入. 用于 gateClaimInRecovering 判定.
   */
  expectedSessionIds?: Set<string>;
  /**
   * §5.2 — RECOVERING 本轮已 recordReport 的 sessionIds. v2 routes 调用
   * recordReport 后追加. 用于"同一 session 第二次及以后重复上报"放行.
   */
  alreadyReportedThisWindow?: Set<string>;
  /** §5.2 — tests can opt out of softMin wait. */
  recoveringSoftMinMs?: number;
}

export function makeContext(options: DaemonOptions = {}): DaemonContext {
  const baseDir = options.baseDir ?? path.join(os.homedir(), ".agentdock");
  const registryPath = path.join(baseDir, "registry.json");

  const registry = new Map<string, RegistryEntry>();
  const mutex = new Mutex();
  const allocator = new FilePortAllocator(baseDir);
  const wal = new DaemonWAL(baseDir);
  // v1 WAL load: if the file has schemaVersion=2 (v2 state), refuse-overwrite
  // throws — catch and fall back to fresh DaemonState. This is expected when
  // a v2 daemon wrote the file and a new instance boots with v1 WAL loader.
  let state: DaemonState;
  try {
    state = wal.load() ?? new DaemonState();
  } catch (err) {
    if (err instanceof Error && err.message.includes("refuse-overwrite-v2-state")) {
      state = new DaemonState();
    } else {
      throw err;
    }
  }
  // v2 state — loaded from the same daemon-state.json; if missing/empty,
  // DaemonWALV2 returns null and we start fresh. P3 routes will use this;
  // v1 routes keep using ctx.state.
  const walV2 = new DaemonWALV2(baseDir);
  const stateV2 = walV2.load() ?? new DaemonStateV2();

  // Port resolution: explicit > restored from WAL > 0 (random).
  let port = 0;
  if (options.port !== undefined) {
    port = options.port;
  } else {
    port = state.getDaemonPort() ?? 0;
  }

  const ctx: DaemonContext = {
    baseDir,
    registryPath,
    registry,
    state,
    wal,
    stateV2,
    walV2,
    sseBus: new SseBus(),
    faults: createFaultInjectorState({ enabled: process.env.NODE_ENV === "test" }),
    allocator,
    mutex,
    lastPersistedHeartbeatAt: new Map<string, number>(),
    port,
    actualPort: port,
    startedAt: Date.now(),
    lastSeq: 0,
    metrics: {
      claimCount: 0,
      conflictCount: 0,
      releaseCount: 0,
      heartbeatTimeoutCount: 0,
      activeSessionCount: 0,
      sseConnections: 0,
    },
    recoveringSoftMinMs: options.recoveringSoftMinMs,
    loadRegistry() {
      if (!existsSync(registryPath)) return;
      try {
        const data = JSON.parse(readFileSync(registryPath, "utf-8"));
        for (const [dir, entry] of Object.entries(data)) {
          registry.set(dir, entry as RegistryEntry);
        }
      } catch {
        /* ignore corrupt registry.json */
      }
    },
    saveRegistry() {
      const dir = path.dirname(registryPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const data: Record<string, RegistryEntry> = {};
      for (const [key, entry] of registry) {
        data[key] = entry;
      }
      writeFileSync(registryPath, JSON.stringify(data, null, 2), "utf-8");
    },
    isProcessAlive(pid: number) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
  };

  ctx.loadRegistry();
  return ctx;
}

/**
 * §11.6 — 挂起/休眠的一次性宽限 (防误回收).
 *
 * 笔记本合盖 / 系统休眠 / VM 挂起会让 client 进程被冻结, 唤醒后单调
 * 时钟跳变, 可能瞬间"已丢 ≥3 次心跳"而被误判失联, 触发整批端口回
 * 收. 规避: cleanupStaleClients 在两次对账 tick 之间的墙钟间隔异常
 * 大 (如 > 2 × SYNC_INTERVAL, 提示刚从挂起恢复) 时, 对所有 client
 * **跳过本轮 heartbeat 超时判定**, 给一个完整 SYNC_INTERVAL 宽限窗口
 * 让冻结的 client 重连上报, 之后再恢复正常判定.
 */
const SUSPEND_GRACE_THRESHOLD_MS = 2 * SYNC_INTERVAL_MS; // 60s
let lastTickAt = Date.now();

export function detectSuspendAndMaybeSkip(): boolean {
  const now = Date.now();
  const gap = now - lastTickAt;
  lastTickAt = now;
  return gap > SUSPEND_GRACE_THRESHOLD_MS;
}

export function resetSuspendDetector(): void {
  lastTickAt = Date.now();
}

/**
 * Run the heartbeat cleanup: release sessions owned by stale clients,
 * unregister those clients, and persist WAL if anything changed.
 * Called periodically by the server heartbeat timer.
 */
export async function cleanupStaleClients(ctx: DaemonContext): Promise<void> {
  // §11.6 — 挂起/休眠宽限: 跳过一次判定
  if (detectSuspendAndMaybeSkip()) {
    // 跳过本轮, 但更新 lastTickAt 让下一轮用新的起点
    return;
  }
  await ctx.mutex.runExclusive("state", () => {
    const now = Date.now();
    let changed = false;
    for (const client of ctx.state.listClients()) {
      if (now - client.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        ctx.state.unregisterClient(client.clientId);
        ctx.lastPersistedHeartbeatAt.delete(client.clientId);
        changed = true;
      }
    }
    // F4: clean up v2 owners whose v1 client has been removed (zombie
    // owners whose client processes crashed are never caught by the
    // v1-only loop above).  listOwners() / releaseAllPorts() are plain
    // Map operations — safe to call inside the mutex.
    for (const owner of ctx.stateV2.listOwners()) {
      if (!ctx.state.getClient(owner.clientId)) {
        ctx.stateV2.releaseAllPorts(owner.sessionId);
        ctx.stateV2.owners.delete(owner.sessionId);
        ctx.stateV2.sessions.delete(owner.sessionId);
        changed = true;
      }
    }
    if (changed) {
      // §5.1 — both v1 and v2 mutations must hit the WAL before we return.
      // Skipping the v2 persist here would let the zombies resurrect on the
      // next restart, since v2 in-memory state is the only truth source for
      // the three-table model (§4.1).
      ctx.wal.persist(ctx.state);
      ctx.walV2.persist(ctx.stateV2);
    }
  });
}
