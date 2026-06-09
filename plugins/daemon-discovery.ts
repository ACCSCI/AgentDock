import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { acquireLock, LockAcquisitionError } from "./os-file-lock.js";

// ============================================================
// Constants
// ============================================================

const AGENTDOCK_DIR = ".agentdock";
const DAEMON_INFO_FILE = "daemon.json";
const DAEMON_LOCK_FILE = "daemon-lock";

/** Timeout for daemon health check after spawning (ms) */
export const DAEMON_STARTUP_TIMEOUT_MS = 5_000;
/** Poll interval during startup wait (ms) */
export const DAEMON_STARTUP_POLL_MS = 100;
/** Max time to hold the leader lock during startup (ms) */
export const LEADER_LOCK_TIMEOUT_MS = 10_000;
/** Random delay range before spawning to reduce thundering herd (ms) */
export const SPAWN_JITTER_MAX_MS = 500;

// ============================================================
// Types
// ============================================================

export interface DaemonInfo {
  pid: number;
  port: number;
  version: string;
  updatedAt: string;
}

export interface DaemonDiscoveryResult {
  /** Whether a daemon was found and is alive. */
  alive: boolean;
  /** Daemon info if alive, null otherwise. */
  info: DaemonInfo | null;
  /** Whether this instance is the leader that should start the daemon. */
  isLeader: boolean;
}

// ============================================================
// DaemonInfo file operations
// ============================================================

function getDataDir(): string {
  return path.join(os.homedir(), AGENTDOCK_DIR);
}

function getDaemonInfoPath(): string {
  return path.join(getDataDir(), DAEMON_INFO_FILE);
}

function getDaemonLockPath(): string {
  return path.join(getDataDir(), DAEMON_LOCK_FILE);
}

/**
 * Read and parse the daemon info file.
 * Returns null if file doesn't exist or is invalid.
 */
export function readDaemonInfo(): DaemonInfo | null {
  const infoPath = getDaemonInfoPath();
  if (!existsSync(infoPath)) return null;

  try {
    const raw = readFileSync(infoPath, "utf-8");
    const parsed = JSON.parse(raw);

    // Validate required fields
    if (typeof parsed.pid !== "number" || typeof parsed.port !== "number") {
      return null;
    }

    return {
      pid: parsed.pid,
      port: parsed.port,
      version: typeof parsed.version === "string" ? parsed.version : "1",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Write daemon info to the info file (atomic: write then rename).
 */
export function writeDaemonInfo(pid: number, port: number): void {
  const infoPath = getDaemonInfoPath();
  const info: DaemonInfo = {
    pid,
    port,
    version: "1",
    updatedAt: new Date().toISOString(),
  };

  // Ensure directory exists
  const dir = path.dirname(infoPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${infoPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(info, null, 2), "utf-8");

  try {
    if (existsSync(infoPath)) {
      unlinkSync(infoPath);
    }
    renameSync(tmpPath, infoPath);
  } catch {
    // Fallback: direct write
    writeFileSync(infoPath, JSON.stringify(info, null, 2), "utf-8");
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

/**
 * Delete the daemon info file.
 */
export function deleteDaemonInfo(): void {
  const infoPath = getDaemonInfoPath();
  try { unlinkSync(infoPath); } catch { /* ignore */ }
}

/**
 * Check if a process is alive (cross-platform).
 */
export function isProcessAlive(pid: number): boolean {
  if (pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // ESRCH = no such process (dead)
    // EPERM = process exists but owned by another user (alive)
    if (err?.code === "EPERM") return true;
    return false;
  }
}

// ============================================================
// Leader election via file lock
// ============================================================

export interface LeaderElectionResult {
  /** Whether this instance won the election. */
  elected: boolean;
  /** Release function — must be called when done. */
  release: () => Promise<void>;
}

/**
 * Participate in leader election. Only one instance among concurrent
 * callers will receive `elected: true`.
 *
 * Uses OS-level file locking via `flock` package with fallback to
 * O_EXCL-based simple lock.
 */
export async function electLeader(): Promise<LeaderElectionResult> {
  const lockPath = getDaemonLockPath();
  const metadata = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };

  try {
    const lock = await acquireLock(lockPath, {
      timeoutMs: LEADER_LOCK_TIMEOUT_MS,
      retryMs: 50,
      metadata,
    });

    return {
      elected: true,
      release: async () => {
        await lock.release();
        deleteDaemonInfo();
      },
    };
  } catch (err: any) {
    // If we can't acquire the lock, another instance is the leader
    if (err instanceof LockAcquisitionError) {
      return {
        elected: false,
        release: async () => {
          // Nothing to release — we didn't acquire the lock
        },
      };
    }
    throw err;
  }
}

// ============================================================
// Daemon discovery (the main entry point)
// ============================================================

/**
 * Discover the daemon or participate in leader election.
 *
 * Flow:
 * 1. Read daemon info file.
 * 2. If info exists and daemon is alive → connect.
 * 3. If info missing/stale → try to become leader.
 * 4. If elected → spawn daemon and wait.
 * 5. If not elected → wait for leader to write info, then connect.
 */
export async function discoverDaemon(
  onSpawnRequired: (port: number) => Promise<void>,
  onWaitForLeader: () => Promise<DaemonInfo>,
): Promise<DaemonDiscoveryResult> {
  // Phase 1: Read existing info
  let info = readDaemonInfo();

  if (info && isProcessAlive(info.pid)) {
    // Info exists and process is alive — verify TCP connectivity
    if (await isDaemonListening(info.port)) {
      return { alive: true, info, isLeader: false };
    }
    // Process alive but not listening → stale info, fall through
  }

  // Phase 2: Leader election (info missing, process dead, or daemon not listening)
  const { elected, release } = await electLeader();

  if (!elected) {
    // Another instance is the leader — wait for them to write info
    try {
      info = await onWaitForLeader();
      return { alive: true, info, isLeader: false };
    } catch {
      // Leader failed — clean up and throw
      await release();
      throw new Error("Leader election failed: follower could not connect to daemon");
    }
  }

  // Phase 3: We are the leader — random jitter to reduce thundering herd
  const jitter = Math.random() * SPAWN_JITTER_MAX_MS;
  await sleep(jitter);

  // Re-check: the daemon might have been started by another instance
  // between our election and now (in case we had to wait for the lock)
  info = readDaemonInfo();
  if (info && isProcessAlive(info.pid) && await isDaemonListening(info.port)) {
    await release();
    return { alive: true, info, isLeader: false };
  }

  // Phase 4: Spawn daemon with port=0 (OS assigns random port)
  // The caller (onSpawnRequired) will start the daemon and return the port.
  await onSpawnRequired(0);

  // Phase 5: Wait for daemon to write info
  const deadline = Date.now() + DAEMON_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    info = readDaemonInfo();
    if (info && isProcessAlive(info.pid) && await isDaemonListening(info.port)) {
      await release();
      return { alive: true, info, isLeader: true };
    }
    await sleep(DAEMON_STARTUP_POLL_MS);
  }

  // Timeout — clean up
  await release();
  throw new Error(
    `Daemon did not become ready within ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
  );
}

/**
 * Check if the daemon is listening on the given port.
 */
async function isDaemonListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = require("node:net").createConnection(port, "127.0.0.1", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renameSync(from: string, to: string): void {
  try {
    const { renameSync } = require("node:fs");
    renameSync(from, to);
  } catch {
    // On Windows, rename fails if target exists
    const { unlinkSync, renameSync } = require("node:fs");
    try { unlinkSync(to); } catch { /* ignore */ }
    renameSync(from, to);
  }
}
