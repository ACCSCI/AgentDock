import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "./daemon-client.js";

// ============================================================
// Types
// ============================================================

export interface DaemonManagerResult {
  client: DaemonClient;
  started: boolean; // true if we started the daemon, false if connected to existing
}

// ============================================================
// DaemonManager — detect / start / connect
// ============================================================

const DAEMON_PORT = 20000;
const STARTUP_TIMEOUT_MS = 5000;
const STARTUP_POLL_MS = 100;

/**
 * Manages the lifecycle of the AgentDock daemon process.
 *
 * Startup flow:
 * 1. Detect — check if a daemon is already running (GET /health)
 * 2. Start  — if missing, spawn daemon as a background child process
 * 3. Connect — return a DaemonClient connected to the daemon
 * 4. Allocate — client can now call POST /ports/allocate
 */
export class DaemonManager {
  private client: DaemonClient;
  private child: ChildProcess | null = null;
  private daemonPort: number;

  constructor(port: number = DAEMON_PORT) {
    this.daemonPort = port;
    this.client = new DaemonClient(port);
  }

  /**
   * Detect daemon, start if missing, connect.
   * Returns the client ready for port allocation.
   */
  async init(): Promise<DaemonManagerResult> {
    // 1. Detect
    const healthy = await this.client.health();
    if (healthy) {
      return { client: this.client, started: false };
    }

    // 2. Start
    await this.startDaemon();

    // 3. Wait for readiness
    await this.waitForReady();

    return { client: this.client, started: true };
  }

  /**
   * Stop the daemon process (only if we started it).
   */
  async shutdown(): Promise<void> {
    if (this.child) {
      this.child.kill();
      this.child = null;
    }
  }

  // --- Internal ---

  private async startDaemon(): Promise<void> {
    // Resolve the daemon entry point
    // In dev: plugins/daemon.ts (via tsx)
    // In prod: plugins/daemon.js (compiled)
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const daemonPath = path.join(__dirname, "daemon.js");
    const daemonPathTs = path.join(__dirname, "daemon.ts");

    // Try compiled JS first, fall back to tsx
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

    const env = { ...process.env, AGENTDOCK_DAEMON_PORT: String(this.daemonPort) };

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
        const healthy = await this.client.health();
        if (healthy) return;
      } catch {
        // Daemon not ready yet
      }
      await sleep(STARTUP_POLL_MS);
    }

    throw new Error(
      `Daemon did not start within ${STARTUP_TIMEOUT_MS}ms (port ${this.daemonPort})`,
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
