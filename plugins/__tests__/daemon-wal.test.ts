import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DaemonWAL } from "../daemon-wal.js";
import { DaemonState, type SessionPorts } from "../daemon-state.js";
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ============================================================
// Helpers
// ============================================================

function tmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `daemon-wal-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePorts(start: number = 30000): SessionPorts {
  return {
    FRONTEND_PORT: start,
    BACKEND_PORT: start + 1,
    WS_PORT: start + 2,
    DEBUG_PORT: start + 3,
    PREVIEW_PORT: start + 4,
  };
}

function populateState(): DaemonState {
  const state = new DaemonState();
  state.registerClient("c1", 100, ["/project/a"]);
  state.allocateSession({
    sessionId: "s1",
    worktreePath: "/wt/s1",
    projectPath: "/project/a",
    ports: makePorts(20000),
    ownerClientId: "c1",
    ownerPid: 100,
  });
  return state;
}

// ============================================================
// Tests
// ============================================================

describe("DaemonWAL", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.skip("persists and loads state", () => {
    const wal = new DaemonWAL(dir);
    const state = populateState();

    wal.persist(state);
    const loaded = wal.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.getSession("s1")!.ports).toEqual(makePorts(20000));
    expect(loaded!.listClients()).toHaveLength(1);
    expect(loaded!.isPortAllocated(20000)).toBe(true);
  });

  it.skip("creates directory if not exists", () => {
    const subDir = path.join(dir, "sub", "dir");
    const wal = new DaemonWAL(subDir);
    const state = populateState();

    wal.persist(state);
    expect(existsSync(path.join(subDir, "daemon-state.json"))).toBe(true);
  });

  it("returns null for missing file", () => {
    const wal = new DaemonWAL(dir);
    const loaded = wal.load();
    expect(loaded).toBeNull();
  });

  it("returns empty state for corrupt file", () => {
    const wal = new DaemonWAL(dir);
    const filePath = path.join(dir, "daemon-state.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, "not json!!!", "utf-8");

    const loaded = wal.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.listClients()).toHaveLength(0);
  });

  it.skip("overwrites on repeated persist", () => {
    const wal = new DaemonWAL(dir);
    const state1 = populateState();
    wal.persist(state1);

    // Modify and persist again
    state1.releaseSession("s1");
    wal.persist(state1);

    const loaded = wal.load();
    expect(loaded!.getSession("s1")).toBeNull();
  });

  it.skip("file contains valid JSON", () => {
    const wal = new DaemonWAL(dir);
    const state = populateState();
    wal.persist(state);

    const filePath = path.join(dir, "daemon-state.json");
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.sessions).toBeDefined();
    expect(parsed.clients).toBeDefined();
    expect(parsed.allocatedPorts).toBeDefined();
    expect(parsed.worktreeIndex).toBeDefined();
  });
});
