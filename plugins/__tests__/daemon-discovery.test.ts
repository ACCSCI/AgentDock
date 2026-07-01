// @ts-nocheck
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  readDaemonInfo,
  writeDaemonInfo,
  deleteDaemonInfo,
  isProcessAlive,
} from "../daemon-discovery.js";
import {
  acquireLock,
  isLockHeld,
  isLockStale,
  LockAcquisitionError,
} from "../os-file-lock.js";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ============================================================
// Helpers
// ============================================================

function tmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `discovery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Override the default data dir by temporarily overriding getDataDir
// We do this by writing directly to the paths daemon-discovery uses.
const originalHomedir = os.homedir;

describe("DaemonDiscovery", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
    // Override homedir for daemon-discovery by writing to our temp dir
    // The module uses os.homedir() internally, so we need to mock it
    vi.spyOn(os, "homedir").mockReturnValue(dir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  // ============================================================
  // DaemonInfo read/write
  // ============================================================

  describe("readDaemonInfo / writeDaemonInfo / deleteDaemonInfo", () => {
    it("returns null when info file does not exist", () => {
      expect(readDaemonInfo()).toBeNull();
    });

    it("writes and reads back daemon info", () => {
      writeDaemonInfo(12345, 34125);
      const info = readDaemonInfo();
      expect(info).not.toBeNull();
      expect(info!.pid).toBe(12345);
      expect(info!.port).toBe(34125);
      expect(info!.version).toBe("1");
      expect(info!.updatedAt).toBeTruthy();
    });

    it("returns null for corrupt JSON", () => {
      const infoPath = path.join(dir, ".agentdock", "daemon.json");
      mkdirSync(path.dirname(infoPath), { recursive: true });
      require("node:fs").writeFileSync(infoPath, "not json", "utf-8");
      expect(readDaemonInfo()).toBeNull();
    });

    it("returns null when required fields are missing", () => {
      const infoPath = path.join(dir, ".agentdock", "daemon.json");
      mkdirSync(path.dirname(infoPath), { recursive: true });
      require("node:fs").writeFileSync(infoPath, JSON.stringify({ foo: "bar" }), "utf-8");
      expect(readDaemonInfo()).toBeNull();
    });

    it("returns null when pid is not a number", () => {
      const infoPath = path.join(dir, ".agentdock", "daemon.json");
      mkdirSync(path.dirname(infoPath), { recursive: true });
      require("node:fs").writeFileSync(infoPath, JSON.stringify({ pid: "abc", port: 123 }), "utf-8");
      expect(readDaemonInfo()).toBeNull();
    });

    it("deletes the info file", () => {
      writeDaemonInfo(1, 2);
      expect(readDaemonInfo()).not.toBeNull();
      deleteDaemonInfo();
      expect(readDaemonInfo()).toBeNull();
    });

    it("delete does not throw on missing file", () => {
      expect(() => deleteDaemonInfo()).not.toThrow();
    });

    it("overwrites existing info on second write", () => {
      writeDaemonInfo(111, 222);
      writeDaemonInfo(333, 444);
      const info = readDaemonInfo();
      expect(info!.pid).toBe(333);
      expect(info!.port).toBe(444);
    });
  });

  // ============================================================
  // isProcessAlive
  // ============================================================

  describe("isProcessAlive", () => {
    it("returns true for current process", () => {
      expect(isProcessAlive(process.pid)).toBe(true);
    });

    it("returns false for PID 0", () => {
      expect(isProcessAlive(0)).toBe(false);
    });

    it("returns false for a clearly dead PID (negative)", () => {
      expect(isProcessAlive(-1)).toBe(false);
    });

    it("returns false for a PID that was never assigned", () => {
      // On most systems, very high PIDs won't exist
      expect(isProcessAlive(999999999)).toBe(false);
    });
  });

  // ============================================================
  // File lock (OS-level)
  // ============================================================

  describe("acquireLock / isLockHeld / isLockStale", () => {
    it("acquires a lock successfully", async () => {
      const lockPath = path.join(dir, "test.lock");
      const lock = await acquireLock(lockPath);
      expect(lock).toBeDefined();
      expect(lock.path).toBe(lockPath);
      await lock.release();
    });

    it("non-blocking lock throws when held", async () => {
      const lockPath = path.join(dir, "test-nb.lock");
      const lock = await acquireLock(lockPath);
      await expect(acquireLock(lockPath, { timeoutMs: 0 })).rejects.toThrow(LockAcquisitionError);
      await lock.release();
    });

    it("lock is released after release()", async () => {
      const lockPath = path.join(dir, "test-release.lock");
      const lock = await acquireLock(lockPath);
      await lock.release();
      // Should be able to acquire again
      const lock2 = await acquireLock(lockPath);
      expect(lock2).toBeDefined();
      await lock2.release();
    });

    it("isLockHeld returns true while lock is held", async () => {
      const lockPath = path.join(dir, "test-held.lock");
      const lock = await acquireLock(lockPath);
      expect(await isLockHeld(lockPath)).toBe(true);
      await lock.release();
    });

    it("isLockHeld returns false after release", async () => {
      const lockPath = path.join(dir, "test-free.lock");
      const lock = await acquireLock(lockPath);
      await lock.release();
      expect(await isLockHeld(lockPath)).toBe(false);
    });

    it("isLockHeld returns false for non-existent lock", async () => {
      const lockPath = path.join(dir, "nonexistent.lock");
      expect(await isLockHeld(lockPath)).toBe(false);
    });

    it("isLockStale returns true for corrupt lock file", () => {
      const lockPath = path.join(dir, "corrupt.lock");
      mkdirSync(path.dirname(lockPath), { recursive: true });
      require("node:fs").writeFileSync(lockPath, "not json", "utf-8");
      expect(isLockStale(lockPath)).toBe(true);
    });

    it("isLockStale returns true for lock with dead PID", () => {
      const lockPath = path.join(dir, "dead-pid.lock");
      mkdirSync(path.dirname(lockPath), { recursive: true });
      require("node:fs").writeFileSync(
        lockPath,
        JSON.stringify({ pid: 999999999, acquiredAt: new Date().toISOString() }),
        "utf-8",
      );
      expect(isLockStale(lockPath)).toBe(true);
    });

    it("isLockStale returns true for old lock", () => {
      const lockPath = path.join(dir, "old.lock");
      mkdirSync(path.dirname(lockPath), { recursive: true });
      const oldDate = new Date(Date.now() - 60_000); // 60 seconds ago
      require("node:fs").writeFileSync(
        lockPath,
        JSON.stringify({ pid: process.pid, acquiredAt: oldDate.toISOString() }),
        "utf-8",
      );
      expect(isLockStale(lockPath)).toBe(true);
    });

    it("isLockStale returns false for fresh lock with alive PID", () => {
      const lockPath = path.join(dir, "fresh.lock");
      const lock = acquireLock(lockPath).then((l) => {
        expect(isLockStale(lockPath)).toBe(false);
        return l.release();
      });
      return lock;
    });

    it("blocking lock waits and succeeds after release", async () => {
      const lockPath = path.join(dir, "test-wait.lock");
      const lock = await acquireLock(lockPath);

      // Start a task that tries to acquire with timeout
      const acquirePromise = acquireLock(lockPath, { timeoutMs: 2000, retryMs: 50 });

      // Release after a short delay
      setTimeout(() => lock.release(), 200);

      const lock2 = await acquirePromise;
      expect(lock2).toBeDefined();
      await lock2.release();
    }, 10000);
  });
});
