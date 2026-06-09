import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "./daemon-client.js";
import { readDaemonInfo, isProcessAlive, deleteDaemonInfo, writeDaemonInfo, DAEMON_STARTUP_TIMEOUT_MS, DAEMON_STARTUP_POLL_MS, LEADER_LOCK_TIMEOUT_MS, SPAWN_JITTER_MAX_MS } from "./daemon-discovery.js";
import { acquireLock, LockAcquisitionError } from "./os-file-lock.js";

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

const STARTUP_TIMEOUT_MS = DAEMON_STARTUP_TIMEOUT_MS;
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
      return await this.spawnDaemonAsLeader(() => {
        lock?.release();
      });
    } catch (err) {
      // If spawning fails, release lock and clean up
      await lock?.release();
      deleteDaemonInfoQuiet();
      throw err;
    }
  }

  private async waitForLeaderDaemon(): Promise<DaemonManagerResult> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

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

    // Leader timed out — try to become leader ourselves
    throw new Error(
      `Leader daemon did not become ready within ${STARTUP_TIMEOUT_MS}ms`,
    );
  }

  private async spawnDaemonAsLeader(
    onDone: () => void,
  ): Promise<DaemonManagerResult> {
    // Random jitter to reduce thundering herd if multiple instances
    // somehow pass the lock simultaneously
    const jitter = Math.random() * SPAWN_JITTER_MAX_MS;
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
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const daemonPath = path.join(__dirname, "daemon.js");
    const daemonPathTs = path.join(__dirname, "daemon.ts");

    let cmd: string;
    let args: string[];
    const { existsSync } = await import("node:fs");
    if (existsSync(daemonPath)) {
      cmd = process.execPath;
      args = [daemonPath];
    } else if (existsSync(daemonPathTs)) {
      cmd = process.execPath;
      args = ["--import", "tsx", daemonPathTs];
    } else {
      throw new Error(`Daemon entry point not found: ${daemonPath} or ${daemonPathTs}`);
    }

    const env = { ...process.env, AGENTDOCK_DAEMON_PORT: String(port) };

    this.child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
      env,
    });

    this.child.unref();

    this.child.on("error", (err) => {
      console.error("[daemon-manager] Failed to start daemon:", err.message);
      this.child = null;
    });

    this.child.on("exit", () => {
      this.child = null;
    });
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;

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
      `Daemon did not start within ${STARTUP_TIMEOUT_MS}ms`,
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
