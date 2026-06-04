import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const LOCK_DIR = path.join(os.homedir(), ".agentdock");
const LOCK_FILE = path.join(LOCK_DIR, "lock.json");

interface LockData {
  pid: number;
  port: number;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    // process.kill(pid, 0) checks if process exists without sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock(): LockData | null {
  try {
    if (!existsSync(LOCK_FILE)) return null;
    const raw = readFileSync(LOCK_FILE, "utf-8");
    return JSON.parse(raw) as LockData;
  } catch {
    return null;
  }
}

function writeLock(data: LockData): void {
  if (!existsSync(LOCK_DIR)) {
    mkdirSync(LOCK_DIR, { recursive: true });
  }
  writeFileSync(LOCK_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function removeLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      unlinkSync(LOCK_FILE);
    }
  } catch {
    // ignore cleanup errors
  }
}

export interface AcquireResult {
  acquired: true;
}

export interface AcquireDenied {
  acquired: false;
  existing: LockData;
}

/**
 * Try to acquire the singleton lock.
 * Returns { acquired: true } on success, or { acquired: false, existing } if another instance is running.
 */
export function acquireLock(port: number): AcquireResult | AcquireDenied {
  const existing = readLock();

  if (existing) {
    if (isProcessAlive(existing.pid)) {
      // Another instance is still running
      return { acquired: false, existing };
    }
    // Stale lock — previous process crashed
    removeLock();
  }

  writeLock({ pid: process.pid, port, startedAt: new Date().toISOString() });

  // Register cleanup on exit
  const cleanup = () => removeLock();
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("SIGTERM", () => { cleanup(); process.exit(0); });

  return { acquired: true };
}

/**
 * Open the existing instance's URL in the default browser.
 */
export function openExistingUrl(port: number): void {
  const url = `http://localhost:${port}`;
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;

  const { exec } = require("node:child_process") as typeof import("node:child_process");
  exec(cmd, () => {});
}
