import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  closeSync,
  unlinkSync,
  unlink,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:net";

// ============================================================
// Constants
// ============================================================

const PORT_RANGE_START = 30000;
const PORT_RANGE_END = 65535;

const AGENTDOCK_DIR = ".agentdock";
const PORTS_FILE = "ports.json";
const LOCK_FILE = "ports.lock";

const LOCK_RETRY_MS = 10;
const LOCK_MAX_RETRIES = 500; // 5 seconds total
const LOCK_STALE_MS = 30_000; // a lock older than this is considered stale

// ============================================================
// PortAllocator Interface
// ============================================================

export interface PortAllocator {
  /**
   * Allocate `count` unique available ports.
   * Ports in `exclude` and previously allocated ports will be skipped.
   * Returns an array of allocated port numbers.
   */
  allocate(count: number, exclude?: Set<number>): Promise<number[]>;

  /**
   * Release previously allocated ports so they can be reused.
   */
  release(ports: number[]): void;
}

// ============================================================
// FilePortAllocator
// ============================================================

/**
 * File-based port allocator with atomic locking.
 *
 * Storage: ~/.agentdock/ports.json — list of allocated port numbers.
 * Lock:    ~/.agentdock/ports.lock — exclusive file lock for atomic allocation.
 *
 * Two concurrent processes cannot get the same port because:
 * 1. Lock acquisition is atomic (O_EXCL file creation).
 * 2. Port scan + write happens under the lock.
 * 3. TCP bind check provides a final safety net.
 */
export class FilePortAllocator implements PortAllocator {
  private lockPath: string;
  private dataPath: string;

  constructor(baseDir?: string) {
    const dir = baseDir ?? path.join(os.homedir(), AGENTDOCK_DIR);
    this.lockPath = path.join(dir, LOCK_FILE);
    this.dataPath = path.join(dir, PORTS_FILE);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  async allocate(count: number, exclude?: Set<number>): Promise<number[]> {
    return this.withLock(async () => {
      const allocated = this.readAllocated();
      const combined = new Set<number>(allocated);
      if (exclude) {
        for (const p of exclude) combined.add(p);
      }

      const result: number[] = [];

      for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
        if (result.length >= count) break;
        if (combined.has(port)) continue;

        if (await isPortAvailable(port)) {
          result.push(port);
          combined.add(port);
        }
      }

      if (result.length < count) {
        throw new Error(
          `Could not allocate ${count} ports (only found ${result.length} available)`,
        );
      }

      this.writeAllocated([...allocated, ...result]);
      return result;
    });
  }

  release(ports: number[]): void {
    const allocated = this.readAllocated();
    const toRelease = new Set(ports);
    const remaining = allocated.filter((p) => !toRelease.has(p));
    this.writeAllocated(remaining);
  }

  // --- File operations ---

  private readAllocated(): number[] {
    if (!existsSync(this.dataPath)) return [];
    try {
      const data = JSON.parse(readFileSync(this.dataPath, "utf-8"));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  private writeAllocated(ports: number[]): void {
    writeFileSync(this.dataPath, JSON.stringify(ports, null, 2), "utf-8");
  }

  // --- File locking ---

  /**
   * Decide whether an existing lock file is stale and safe to break.
   *
   * The lock content is JSON `{ pid, ts }`. A lock is considered stale when:
   *  - its content cannot be parsed or carries no usable pid (legacy/corrupt), OR
   *  - the recorded pid no longer corresponds to a live process, OR
   *  - the lock is older than LOCK_STALE_MS.
   *
   * A lock held by a live process that is younger than LOCK_STALE_MS is NOT
   * stale and must not be broken (doing so would let two processes enter the
   * critical section and hand out duplicate ports).
   */
  private isLockStale(): boolean {
    let raw: string;
    try {
      raw = readFileSync(this.lockPath, "utf-8");
    } catch {
      // Lock vanished — treat as breakable so the caller can retry acquisition.
      return true;
    }

    let pid: number | undefined;
    let ts: number | undefined;
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown; ts?: unknown };
      if (typeof parsed.pid === "number") pid = parsed.pid;
      if (typeof parsed.ts === "number") ts = parsed.ts;
    } catch {
      // Legacy/corrupt lock content (e.g. empty or non-JSON) — break it.
      return true;
    }

    // No usable pid recorded — fall back to age-based decision only.
    if (pid === undefined) {
      return true;
    }

    // Age check: an old lock is stale regardless of liveness.
    if (ts !== undefined && Date.now() - ts > LOCK_STALE_MS) {
      return true;
    }

    // Liveness check: signal 0 probes existence without affecting the process.
    try {
      process.kill(pid, 0);
      // Process is alive and the lock is fresh — NOT stale.
      return false;
    } catch (err: any) {
      // ESRCH: no such process → dead holder → stale.
      // EPERM: process exists but owned by another user → treat as alive.
      if (err?.code === "EPERM") {
        return false;
      }
      return true;
    }
  }

  /**
   * Execute `fn` under an exclusive file lock.
   * Uses O_EXCL for atomic lock acquisition.
   * Retries with backoff when the lock is held by another process, and only
   * force-breaks the lock when it is provably stale (dead holder or aged out).
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt <= LOCK_MAX_RETRIES; attempt++) {
      try {
        // Atomic lock: O_CREAT | O_EXCL fails if file already exists
        const fd = openSync(this.lockPath, "wx");
        // Record holder identity so others can assess liveness/age.
        try {
          writeFileSync(
            this.lockPath,
            JSON.stringify({ pid: process.pid, ts: Date.now() }),
            "utf-8",
          );
        } catch {
          // Best-effort metadata; lock is already held atomically.
        }
        closeSync(fd);

        try {
          return await fn();
        } finally {
          // Release lock (best-effort)
          try {
            unlinkSync(this.lockPath);
          } catch {
            // Another process may have cleaned it up
          }
        }
      } catch (err: any) {
        if (err.code === "EEXIST") {
          // Lock held — if it is stale, break it and retry immediately.
          if (this.isLockStale()) {
            try {
              unlinkSync(this.lockPath);
            } catch {
              // Someone else cleaned it up; just retry.
            }
            continue;
          }
          // Lock is alive and fresh — wait and retry.
          if (attempt < LOCK_MAX_RETRIES) {
            await sleep(LOCK_RETRY_MS);
            continue;
          }
          throw new Error(
            `FilePortAllocator: Could not acquire lock after ${LOCK_MAX_RETRIES} retries (held by a live process)`,
          );
        }
        throw err;
      }
    }
    throw new Error("FilePortAllocator: lock acquisition failed");
  }
}

// ============================================================
// PoolPortAllocator (in-memory, for backward compatibility)
// ============================================================

/**
 * In-memory port allocator. Scans TCP ports sequentially.
 * Used as the default when no file-based state is needed.
 */
export class PoolPortAllocator implements PortAllocator {
  async allocate(count: number, exclude?: Set<number>): Promise<number[]> {
    const allocated: number[] = [];

    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      if (allocated.length >= count) break;
      if (exclude?.has(port)) continue;

      if (await isPortAvailable(port)) {
        allocated.push(port);
      }
    }

    if (allocated.length < count) {
      throw new Error(
        `Could not allocate ${count} ports (only found ${allocated.length} available)`,
      );
    }

    return allocated;
  }

  release(_ports: number[]): void {
    // No-op: in-memory allocator has no persistent state
  }
}

// ============================================================
// Utility
// ============================================================

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

/**
 * Pick a single free port using OS port=0 to get a random one (新架构 §3.3).
 *
 * Tries up to `maxAttempts` times to bind a random port; returns the first
 * one that succeeds. Excludes ports in `exclude`. This avoids "increment
 * through a range" which can collide with consecutive occupied ranges.
 */
export async function pickFreePort(
  exclude: readonly number[] = [],
  maxAttempts = 50,
): Promise<number> {
  const excludeSet = new Set(exclude);
  for (let i = 0; i < maxAttempts; i++) {
    const server = createServer();
    const port = await new Promise<number | null>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : null);
      });
      server.on("error", () => resolve(null));
    });
    // Close immediately so the OS releases the port (it's not in
    // `excludeSet` yet, so we won't hand it back twice in this call).
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (port !== null && !excludeSet.has(port)) {
      return port;
    }
  }
  throw new Error(
    `pickFreePort: failed to find a free port in ${maxAttempts} attempts`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
