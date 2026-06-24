import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "./daemon-client.js";
import {
  readDaemonInfo,
  isProcessAlive,
  deleteDaemonInfo,
  writeDaemonInfo,
  DAEMON_STARTUP_TIMEOUT_MS,
  DAEMON_STARTUP_POLL_MS,
  FOLLOWER_STARTUP_TIMEOUT_MS,
} from "./daemon-discovery.js";
import { acquireLock, LockAcquisitionError } from "./os-file-lock.js";
import { FOLLOWER_BACKOFF_MS, FOLLOWER_RETRY_MAX, LEADER_LOCK_TIMEOUT_MS, SPAWN_JITTER_MS } from "./constants.js";
import { log } from "./logger.js";

// ============================================================
// Types
// ============================================================

export interface DaemonManagerResult {
  client: DaemonClient;
  started: boolean; // true if we started the daemon, false if connected to existing
}

// ============================================================
// DaemonManager — discover / elect / start / connect
// ============================================================

/**
 * Leader-side: timeout for our OWN daemon (process spawn + listen + write
 * daemon.json). New architecture §1.1 — bound to DAEMON_STARTUP_TIMEOUT_MS.
 */
const SELF_STARTUP_TIMEOUT_MS = DAEMON_STARTUP_TIMEOUT_MS;
/**
 * Follower-side: timeout for waiting on the leader to publish daemon.json.
 * New architecture §1.1 — must exceed LEADER_LOCK_TIMEOUT_MS, otherwise a
 * slow leader (spawn + listen + atomic-rename) is abandoned while it is
 * still finishing. Bound to FOLLOWER_STARTUP_TIMEOUT_MS (= 15000ms).
 */
const FOLLOWER_WAIT_MS = FOLLOWER_STARTUP_TIMEOUT_MS;
const STARTUP_POLL_MS = DAEMON_STARTUP_POLL_MS;

/**
 * Manages the lifecycle of the AgentDock daemon process.
 *
 * Startup flow (dynamic discovery):
 * 1. Read daemon.json — check if daemon info exists
 * 2. Verify daemon is alive (PID alive + TCP listening)
 * 3. If alive → connect to existing daemon
 * 4. If dead/missing → participate in leader election
 * 5. Leader: spawn daemon with random port, wait for readiness
 * 6. Follower: wait for leader to write daemon.json, then connect
 *
 * Uses OS-level file locking for leader election to prevent
 * multiple daemons from starting simultaneously.
 */
export class DaemonManager {
  private client: DaemonClient | null = null;
  private child: ChildProcess | null = null;
  private baseDir: string;
  /**
   * Optional override for the daemon entry path. When set, the manager
   * spawns this exact file instead of looking for `daemon.js` / `daemon.ts`
   * next to this file. Phase 3 needs this because Electron main bundles
   * to out/main/main.js where the original __dirname-relative lookup fails.
   */
  daemonEntry?: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.join(os.homedir(), ".agentdock");
  }

  /**
   * Discover daemon, start if missing, connect.
   * Returns the client ready for port allocation.
   */
  async init(): Promise<DaemonManagerResult> {
    // Phase 1: Try to discover an existing daemon
    const existingInfo = readDaemonInfo();
    if (existingInfo && isProcessAlive(existingInfo.pid)) {
      // Info file exists and PID is alive — try to connect
      const tempClient = new DaemonClient(existingInfo.port);
      if (await tempClient.health()) {
        this.client = tempClient;
        return { client: this.client, started: false };
      }
      // Process alive but not listening → stale, fall through to election
    }

    // Phase 2: Leader election
    const result = await this.runLeaderElection();
    return result;
  }

  /**
   * Stop the daemon process (only if we started it).
   */
  async shutdown(): Promise<void> {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
    this.client = null;
  }

  // --- Internal ---

  private async runLeaderElection(): Promise<DaemonManagerResult> {
    const lockPath = path.join(this.baseDir, "daemon-lock");

    // Try to acquire the leader lock
    let lock: { path: string; release: () => Promise<void> } | null = null;
    let isLeader = false;

    try {
      lock = await acquireLock(lockPath, {
        timeoutMs: LEADER_LOCK_TIMEOUT_MS,
        retryMs: 50,
        metadata: { role: "leader-election" },
      });
      isLeader = true;
    } catch (err) {
      if (err instanceof LockAcquisitionError) {
        isLeader = false;
      } else {
        throw err;
      }
    }

    if (!isLeader) {
      // Follower: wait for leader to start the daemon
      return this.waitForLeaderDaemon();
    }

    // Leader: spawn the daemon
    try {
      return await this.spawnDaemonAsLeader(async () => {
        await lock?.release();
      });
    } catch (err) {
      // If spawning fails, release lock and clean up
      await lock?.release();
      deleteDaemonInfoQuiet();
      throw err;
    }
  }

  private async waitForLeaderDaemon(): Promise<DaemonManagerResult> {
    // §1.1 — Follower 等待 Leader 写 daemon.json + TCP 探活成功.
    // 超时后**不直接失败** — 退化为重新抢锁 (最多 FOLLOWER_RETRY_MAX 次),
    // 每轮重抢前要重读 daemon.json + TCP 探活, 避免无谓争抢.
    //
    // 退避: 第 1 轮 0ms, 第 2 轮 FOLLOWER_BACKOFF_MS, 第 3 轮 2×, 封顶
    // LEADER_LOCK_TIMEOUT_MS. 达到 FOLLOWER_RETRY_MAX 仍失败 → 抛错
    // 由 UI 弹"启动 Daemon"模态.
    let attempt = 0;
    let backoffMs = 0;

    while (attempt <= FOLLOWER_RETRY_MAX) {
      const deadline = Date.now() + FOLLOWER_WAIT_MS;
      while (Date.now() < deadline) {
        const info = readDaemonInfo();
        if (info && isProcessAlive(info.pid)) {
          const tempClient = new DaemonClient(info.port);
          if (await tempClient.health()) {
            return { client: tempClient, started: false };
          }
        }
        await sleep(STARTUP_POLL_MS);
      }

      // 本轮超时, 准备重抢.
      attempt++;
      if (attempt > FOLLOWER_RETRY_MAX) {
        break;
      }
      log.warn(
        { attempt, max: FOLLOWER_RETRY_MAX },
        "Follower: leader daemon did not become ready — re-entering EnsureRunning",
      );
      // 退避 (从 0 起, 每轮 ×2, 封顶 LEADER_LOCK_TIMEOUT_MS)
      backoffMs = backoffMs === 0
        ? FOLLOWER_BACKOFF_MS
        : Math.min(backoffMs * 2, LEADER_LOCK_TIMEOUT_MS);
      await sleep(backoffMs);
      // 重新进入 Leader 选举 — 顶层入口会再次走 Phase 1 (重读 daemon.json
      // + TCP 探活), 然后 Phase 2 (抢锁). 这样:
      //   - 如果其他实例在我们等待期间成功启动了 Daemon, 我们直接发现
      //   - 如果仍没有, 我们有机会自己成为 Leader
      return this.runLeaderElection();
    }

    // 重抢锁次数耗尽 — 弹人工模态
    throw new Error(
      `Follower: leader daemon did not become ready after ${FOLLOWER_RETRY_MAX + 1} attempts of ${FOLLOWER_WAIT_MS}ms each`,
    );
  }

  private async spawnDaemonAsLeader(
    onDone: () => void,
  ): Promise<DaemonManagerResult> {
    // Random jitter to reduce thundering herd if multiple instances
    // somehow pass the lock simultaneously
    const jitter = Math.random() * SPAWN_JITTER_MS;
    await sleep(jitter);

    // Re-check: daemon may have been started between election and now
    const info = readDaemonInfo();
    if (info && isProcessAlive(info.pid)) {
      const tempClient = new DaemonClient(info.port);
      if (await tempClient.health()) {
        onDone();
        return { client: tempClient, started: false };
      }
    }

    // Spawn daemon with port=0 (OS assigns random available port)
    await this.startDaemon(0);

    // Wait for daemon to become ready
    await this.waitForReady();

    // Verify the daemon info file was written correctly
    const finalInfo = readDaemonInfo();
    if (!finalInfo || !isProcessAlive(finalInfo.pid)) {
      throw new Error("Daemon started but did not write daemon.json");
    }

    // Re-create client with the actual port from daemon.json
    this.client = new DaemonClient(finalInfo.port);

    onDone();
    return { client: this.client, started: true };
  }

  private async startDaemon(port: number): Promise<void> {
    // Phase 3: support a custom daemonEntry (Electron main sets this to the
    // project root + plugins/daemon.ts, since electron-vite bundles main to
    // out/main/main.js and the original __dirname-relative lookup fails).
    //
    // Also: when invoked from Electron's main process, process.execPath is
    // electron.exe — that can't run a plain TS file with --import tsx. We
    // explicitly prefer `bun run` (TS-native, no loader dance) when
    // available, falling back to `node --import tsx` otherwise.
    const { daemonEntry } = this;
    let cmd: string;
    let args: string[];
    const { existsSync } = await import("node:fs");

    // Helper: pick the best runtime for a .ts / .js entry.
    const pickRuntime = (entry: string): { cmd: string; args: string[] } => {
      const isTs = entry.endsWith(".ts");
      const isEsm = entry.endsWith(".mjs") || entry.endsWith(".esm");

      // 打包后的 Electron 应用：daemon 已预编译为 JS，
      // 通过 ELECTRON_RUN_AS_NODE=1 运行（bun 在用户机器上不可用）。
      if (process.env.AGENTDOCK_ELECTRON === "1" && isEsm) {
        // AGENTDOCK_ELECTRON=1 表示从 Electron 主进程启动，
        // isEsm 表示传入的是预编译后的 daemon.mjs，直接运行即可。
        // 注意：不在这里设置 ELECTRON_RUN_AS_NODE，
        // 由 main.ts 中的 bootstrap() 统一设置 spawn env。
        return { cmd: process.execPath, args: ["--experimental-sqlite", entry] };
      }

      // 开发环境：优先 bun（原生 TS，无需 loader），回退到 node+tsx
      if (process.env.BUN_INSTALL || process.env.AGENTDOCK_USE_BUN) {
        return { cmd: "bun", args: ["run", entry] };
      }
      // Fallback: node with tsx loader for .ts, plain for .js.
      return isTs
        ? { cmd: process.execPath, args: ["--import", "tsx", entry] }
        : { cmd: process.execPath, args: [entry] };
    };

    if (daemonEntry) {
      // Explicit override — caller knows where the daemon entry lives.
      if (!existsSync(daemonEntry)) {
        throw new Error(`Daemon entry point not found at: ${daemonEntry}`);
      }
      const picked = pickRuntime(daemonEntry);
      cmd = picked.cmd;
      args = picked.args;
    } else {
      // Default: same dir as this DaemonManager file (plugins/).
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const daemonPath = path.join(__dirname, "daemon.js");
      const daemonPathTs = path.join(__dirname, "daemon.ts");
      if (existsSync(daemonPath)) {
        const picked = pickRuntime(daemonPath);
        cmd = picked.cmd;
        args = picked.args;
      } else if (existsSync(daemonPathTs)) {
        const picked = pickRuntime(daemonPathTs);
        cmd = picked.cmd;
        args = picked.args;
      } else {
        throw new Error(`Daemon entry point not found: ${daemonPath} or ${daemonPathTs}`);
      }
    }

    // 打包环境下 daemon 是预编译的 JS，需要用 ELECTRON_RUN_AS_NODE=1
    // 让 electron.exe 以 Node 模式运行它。此变量仅注入 daemon 子进程的 env，
    // 不污染主进程（否则渲染器/GPU 进程会退化为 Node 模式）。
    const isPackagedJs = process.env.AGENTDOCK_ELECTRON === "1" && daemonEntry?.endsWith(".mjs");
    const env = {
      ...process.env,
      AGENTDOCK_DAEMON_PORT: String(port),
      ...(isPackagedJs ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    };

    // Phase 3: when running from Electron, detached:true + stdio:"ignore"
    // can cause the child to be killed by the parent process tree cleanup
    // (Chromium's child tracking is aggressive on Windows). Detect
    // AGENTDOCK_ELECTRON=1 and spawn without detached/stdio:ignore so the
    // daemon stays alive and we can see its stderr if it crashes.
    const isElectron = process.env.AGENTDOCK_ELECTRON === "1";

    this.child = spawn(cmd, args, {
      detached: !isElectron,
      stdio: isElectron ? ["ignore", "pipe", "pipe"] : "ignore",
      env,
    });

    if (!isElectron) this.child.unref();

    if (isElectron && this.child.stdout) {
      this.child.stdout.on("data", (d: Buffer) => {
        process.stderr.write(`[daemon] ${d}`);
      });
    }
    if (isElectron && this.child.stderr) {
      this.child.stderr.on("data", (d: Buffer) => {
        process.stderr.write(`[daemon:err] ${d}`);
      });
    }

    this.child.on("error", (err) => {
      // Use log (pino JSON) instead of console.error to avoid the
      // EPIPE-during-Electron-shutdown trap.
      process.stderr.write(`[daemon-manager] spawn error: ${err.message}\n`);
      this.child = null;
    });

    this.child.on("exit", (code) => {
      if (isElectron) {
        process.stderr.write(`[daemon-manager] daemon exited with code ${code}\n`);
      }
      this.child = null;
    });
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + SELF_STARTUP_TIMEOUT_MS;

    while (Date.now() < deadline) {
      try {
        const info = readDaemonInfo();
        if (info && isProcessAlive(info.pid)) {
          const tempClient = new DaemonClient(info.port);
          const healthy = await tempClient.health();
          if (healthy) {
            this.client = tempClient;
            return;
          }
        }
      } catch {
        // Daemon not ready yet
      }
      await sleep(STARTUP_POLL_MS);
    }

    throw new Error(
      `Daemon did not start within ${SELF_STARTUP_TIMEOUT_MS}ms`,
    );
  }
}

// ============================================================
// Singleton
// ============================================================

let _manager: DaemonManager | null = null;
let _client: DaemonClient | null = null;

/**
 * Get or create the global daemon manager.
 */
export function getDaemonManager(): DaemonManager {
  if (!_manager) {
    _manager = new DaemonManager();
  }
  return _manager;
}

/**
 * Get the connected daemon client (call after init()).
 * Returns null if daemon is not initialized.
 */
export function getDaemonClient(): DaemonClient | null {
  return _client;
}

/**
 * Set the daemon client (used by tests and manual initialization).
 */
export function setDaemonClient(client: DaemonClient): void {
  _client = client;
}

// ============================================================
// Helpers
// ============================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deleteDaemonInfoQuiet(): void {
  try { deleteDaemonInfo(); } catch { /* ignore */ }
}
