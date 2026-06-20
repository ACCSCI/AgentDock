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
import { FilePortAllocator, type PortAllocator } from "../port-allocator.js";
import { Mutex } from "../mutex.js";
import { DaemonState } from "../daemon-state.js";
import { DaemonStateV2 } from "../daemon-state-v2.js";
import { DaemonWAL } from "../daemon-wal.js";
import { DaemonWALV2 } from "../daemon-wal-v2.js";
import { SseBus } from "../sse-bus.js";

/** Tunables — same constants the old AgentDockDaemon used. */
export const HEARTBEAT_TIMEOUT_MS = 90_000;
export const HEARTBEAT_CHECK_INTERVAL_MS = 30_000;
export const HEARTBEAT_PERSIST_INTERVAL_MS = 30_000;

export interface DaemonOptions {
  /** Port to listen on. Default: 0 (OS-assigned random port). */
  port?: number;
  /** Base directory for state files. Default: ~/.agentdock */
  baseDir?: string;
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
}

export function makeContext(options: DaemonOptions = {}): DaemonContext {
  const baseDir = options.baseDir ?? path.join(os.homedir(), ".agentdock");
  const registryPath = path.join(baseDir, "registry.json");

  const registry = new Map<string, RegistryEntry>();
  const mutex = new Mutex();
  const allocator = new FilePortAllocator(baseDir);
  const wal = new DaemonWAL(baseDir);
  const state = wal.load() ?? new DaemonState();
  // v2 state — loaded from the same daemon-state.json; if missing/empty,
  // DaemonWALV2 returns null and we start fresh. P3 routes will use this;
  // v1 routes keep using ctx.state.
  const walV2 = new DaemonWALV2(baseDir);
  const stateV2 = walV2.load() ?? new DaemonStateV2();

  // Port resolution: explicit > restored from WAL > 0 (random).
  let port = 0;
  if (options.port !== undefined) {
    port = options.port;
  } else if (state.getDaemonPort() !== null) {
    port = state.getDaemonPort()!;
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
 * Run the heartbeat cleanup: release sessions owned by stale clients,
 * unregister those clients, and persist WAL if anything changed.
 * Called periodically by the server heartbeat timer.
 */
export async function cleanupStaleClients(ctx: DaemonContext): Promise<void> {
  await ctx.mutex.runExclusive("state", () => {
    const now = Date.now();
    let changed = false;
    for (const client of ctx.state.listClients()) {
      if (now - client.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        for (const session of ctx.state.listSessions()) {
          if (session.ownerClientId === client.clientId) {
            ctx.state.releaseSession(session.sessionId);
            changed = true;
          }
        }
        ctx.state.unregisterClient(client.clientId);
        ctx.lastPersistedHeartbeatAt.delete(client.clientId);
        changed = true;
      }
    }
    if (changed) {
      ctx.wal.persist(ctx.state);
    }
  });
}