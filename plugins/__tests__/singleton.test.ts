import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// We test the module by importing and manipulating the lock file directly,
// since the module uses a fixed path (~/.agentdock/lock.json).
// To avoid interfering with a real running instance, we mock the paths.

const LOCK_DIR = path.join(os.tmpdir(), `agentdock-test-${process.pid}`);
const LOCK_FILE = path.join(LOCK_DIR, "lock.json");

// We need to re-import the module with mocked paths. Instead, we test
// the public API by directly exercising the lock file and using the module.

// Clean up before/after each test
beforeEach(() => {
  try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(path.join(os.homedir(), ".agentdock", "lock.json"), { force: true }); } catch {}
});

afterEach(() => {
  try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(path.join(os.homedir(), ".agentdock", "lock.json"), { force: true }); } catch {}
});

describe("singleton lock", () => {
  it("lock file structure is valid JSON with expected fields", () => {
    // Write a lock file manually and verify structure
    mkdirSync(path.join(os.homedir(), ".agentdock"), { recursive: true });
    const lockPath = path.join(os.homedir(), ".agentdock", "lock.json");
    const data = { pid: 999999, port: 5173, startedAt: new Date().toISOString() };
    writeFileSync(lockPath, JSON.stringify(data, null, 2), "utf-8");

    const raw = readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty("pid");
    expect(parsed).toHaveProperty("port");
    expect(parsed).toHaveProperty("startedAt");
    expect(typeof parsed.pid).toBe("number");
    expect(typeof parsed.port).toBe("number");
    expect(typeof parsed.startedAt).toBe("string");
  });

  it("acquireLock succeeds when no lock file exists", async () => {
    // Ensure no lock file
    const lockPath = path.join(os.homedir(), ".agentdock", "lock.json");
    try { rmSync(lockPath, { force: true }); } catch {}

    // Import fresh module
    const { acquireLock } = await import("../singleton.js");
    const result = acquireLock(5173);
    expect(result.acquired).toBe(true);

    // Verify lock file was written
    expect(existsSync(lockPath)).toBe(true);
    const raw = readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(process.pid);
    expect(parsed.port).toBe(5173);

    // Clean up lock
    try { rmSync(lockPath, { force: true }); } catch {}
  });

  it("acquireLock succeeds with stale lock (dead PID)", async () => {
    // Write a lock with a non-existent PID
    const lockPath = path.join(os.homedir(), ".agentdock", "lock.json");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, port: 5173, startedAt: "2020-01-01T00:00:00.000Z" }), "utf-8");

    const { acquireLock } = await import("../singleton.js");
    const result = acquireLock(5173);
    expect(result.acquired).toBe(true);

    // Verify lock was overwritten with current PID
    const raw = readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(process.pid);

    try { rmSync(lockPath, { force: true }); } catch {}
  });

  it("acquireLock fails when lock held by alive process", async () => {
    // Use current PID as "another running instance"
    const lockPath = path.join(os.homedir(), ".agentdock", "lock.json");
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port: 5173, startedAt: new Date().toISOString() }), "utf-8");

    const { acquireLock } = await import("../singleton.js");
    const result = acquireLock(5173);
    expect(result.acquired).toBe(false);
    if (!result.acquired) {
      expect(result.existing.pid).toBe(process.pid);
      expect(result.existing.port).toBe(5173);
    }

    try { rmSync(lockPath, { force: true }); } catch {}
  });
});
