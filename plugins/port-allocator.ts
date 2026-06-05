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

const PORT_RANGE_START = 20000;
const PORT_RANGE_END = 65535;

const AGENTDOCK_DIR = ".agentdock";
const PORTS_FILE = "ports.json";
const LOCK_FILE = "ports.lock";

const LOCK_RETRY_MS = 10;
const LOCK_MAX_RETRIES = 500; // 5 seconds total

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
   * Execute `fn` under an exclusive file lock.
   * Uses O_EXCL for atomic lock acquisition.
   * Retries with backoff when the lock is held by another process.
   */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt <= LOCK_MAX_RETRIES; attempt++) {
      try {
        // Atomic lock: O_CREAT | O_EXCL fails if file already exists
        const fd = openSync(this.lockPath, "wx");
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
          // Lock held by another process — wait and retry
          if (attempt < LOCK_MAX_RETRIES) {
            await sleep(LOCK_RETRY_MS);
            continue;
          }
          // Force-break stale lock after max retries
          try {
            unlinkSync(this.lockPath);
          } catch {
            // ignore
          }
          throw new Error(
            `FilePortAllocator: Could not acquire lock after ${LOCK_MAX_RETRIES} retries`,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
