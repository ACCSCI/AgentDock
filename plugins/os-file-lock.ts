import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// ============================================================
// OS-level file lock — cross-platform, no external deps
// ============================================================
//
// Uses atomic file creation (openSync(path, 'wx')) which maps to:
//   - POSIX: O_CREAT | O_EXCL  → atomic at inode level
//   - Windows: CREATE_NEW      → atomic at filesystem level
//
// Two processes cannot create the same file simultaneously — this is
// guaranteed by the OS kernel.
//
// Crash safety:
//   - POSIX: lock file remains but is detected as stale via pid check
//   - Windows: same — stale detection recovers
// ============================================================

export interface FileLock {
  readonly path: string;
  release(): Promise<void>;
}

export interface LockOptions {
  /** Max wait in ms. 0 = non-blocking. Default: 0. */
  readonly timeoutMs?: number;
  /** Retry interval in ms. Default: 50. */
  readonly retryMs?: number;
  /** Extra metadata to store in the lock file. */
  readonly metadata?: Record<string, unknown>;
}

export class LockAcquisitionError extends Error {
  constructor(lockPath: string, cause: string) {
    super(`Failed to acquire lock at ${lockPath}: ${cause}`);
    this.name = "LockAcquisitionError";
  }
}

/**
 * Acquire an exclusive file lock. Uses OS-level atomic file creation.
 *
 * The lock file contains JSON with `pid` and `acquiredAt` for stale detection.
 */
export async function acquireLock(lockPath: string, options: LockOptions = {}): Promise<FileLock> {
  const { timeoutMs = 0, retryMs = 50, metadata } = options;
  const lockDir = path.dirname(lockPath);

  if (!existsSync(lockDir)) {
    try {
      mkdirSync(lockDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  let lastErr: Error | undefined;

  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, "wx");
      const payload: Record<string, unknown> = {
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      };
      if (metadata) Object.assign(payload, metadata);
      writeFileSync(lockPath, JSON.stringify(payload), "utf-8");
      closeSync(fd);
      return { path: lockPath, release: async () => unlinkSyncQuiet(lockPath) };
    } catch (err: unknown) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      const errorCode =
        typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined;
      if (errorCode === "EEXIST") {
        // A crashed process leaves the lock file behind. Recover it even for
        // non-blocking callers (the production single-instance path), but
        // never replace a lock whose PID is still alive.
        if (isLockStale(lockPath)) {
          try {
            unlinkSync(lockPath);
          } catch {
            /* ignore */
          }
          continue;
        }
        if (timeoutMs === 0) {
          // Non-blocking: a live holder is genuine contention.
          throw new LockAcquisitionError(lockPath, "held by another process");
        }
        // Lock held by live process — wait
        await sleep(retryMs);
        continue;
      }
      throw err;
    }
  }

  throw new LockAcquisitionError(lockPath, lastErr?.message ?? "timeout waiting for lock");
}

/** Non-blocking lock acquisition — throws immediately if unavailable. */
export async function tryAcquireLock(
  lockPath: string,
  metadata?: Record<string, unknown>,
): Promise<FileLock> {
  return acquireLock(lockPath, { timeoutMs: 0, metadata });
}

/** Check if a lock file is currently held by a live process. */
export async function isLockHeld(lockPath: string): Promise<boolean> {
  return existsSync(lockPath) && !isLockStale(lockPath);
}

/**
 * Check whether an existing lock file is stale.
 * A lock is stale when its holder process is no longer alive.
 */
export function isLockStale(lockPath: string): boolean {
  try {
    const raw = readFileSync(lockPath, "utf-8");
    const data = JSON.parse(raw) as { pid?: number; acquiredAt?: string };

    if (typeof data.pid !== "number" || data.pid <= 0) return true;

    // Liveness is authoritative. A healthy AgentDock process normally holds
    // this lock for much longer than LOCK_STALE_MS, so age alone must never
    // invalidate a live owner.
    try {
      process.kill(data.pid, 0);
      return false; // Process is alive, lock is valid
    } catch (err: unknown) {
      const errorCode =
        typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined;
      if (errorCode === "EPERM") return false; // Process exists, different user
      return true; // Process is dead
    }
  } catch {
    return true; // Corrupt/unreadable → stale
  }
}

function unlinkSyncQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
