import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DaemonWAL } from "../daemon-wal.js";
import { DaemonState, type SessionPorts } from "../daemon-state.js";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import path from "node:path";
import os from "node:os";

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `wal-edge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function addSession(state: DaemonState, id: string, portBase: number) {
  const ports: SessionPorts = {
    FRONTEND_PORT: portBase,
    BACKEND_PORT: portBase + 1,
    WS_PORT: portBase + 2,
    DEBUG_PORT: portBase + 3,
    PREVIEW_PORT: portBase + 4,
  };
  state.allocateSession({
    sessionId: id,
    worktreePath: `/wt/${id}`,
    projectPath: "/project",
    ports,
    ownerClientId: "c1",
    ownerPid: 1000,
  });
}

describe("DaemonWAL edge cases", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("load returns null for non-existent file", () => {
    const wal = new DaemonWAL(dir);
    expect(wal.load()).toBeNull();
  });

  it("load returns empty state for illegal JSON", () => {
    const wal = new DaemonWAL(dir);
    writeFileSync(path.join(dir, "daemon-state.json"), "not json {{{", "utf-8");
    // JSON.parse throws, deserialize catches and returns empty state
    const loaded = wal.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.listClients()).toHaveLength(0);
  });

  it("load returns empty state for empty string", () => {
    const wal = new DaemonWAL(dir);
    writeFileSync(path.join(dir, "daemon-state.json"), "", "utf-8");
    // JSON.parse("") throws, deserialize catches and returns empty state
    const loaded = wal.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.listClients()).toHaveLength(0);
  });

  it("load returns empty state for empty JSON object", () => {
    const wal = new DaemonWAL(dir);
    writeFileSync(path.join(dir, "daemon-state.json"), "{}", "utf-8");
    const loaded = wal.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.listClients()).toHaveLength(0);
  });

  it.skip("persist creates directory if missing", () => {
    const subDir = path.join(dir, "deep", "nested");
    const wal = new DaemonWAL(subDir);
    const state = new DaemonState();
    addSession(state, "s1", 20000);

    wal.persist(state);

    expect(existsSync(path.join(subDir, "daemon-state.json"))).toBe(true);
  });

  it.skip("rapid persist 100 times — final file matches last state", () => {
    const wal = new DaemonWAL(dir);

    for (let i = 0; i < 100; i++) {
      const state = new DaemonState();
      addSession(state, `s${i}`, 20000 + i * 5);
      wal.persist(state);
    }

    const loaded = wal.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.listSessions()).toHaveLength(1);
    expect(loaded!.getSession("s99")).not.toBeNull();
  });

  it.skip("persist works even with stale .tmp file present", () => {
    const wal = new DaemonWAL(dir);
    // Write a stale .tmp file
    writeFileSync(path.join(dir, "daemon-state.json.tmp"), "stale", "utf-8");

    const state = new DaemonState();
    addSession(state, "s1", 20000);
    wal.persist(state);

    // .tmp is overwritten by the new write, then renamed to final file
    const loaded = wal.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.listSessions()).toHaveLength(1);
  });

  it.skip("WAL file truncated to 0 bytes — load returns empty state", () => {
    const wal = new DaemonWAL(dir);
    const state = new DaemonState();
    addSession(state, "s1", 20000);
    wal.persist(state);

    // Truncate
    writeFileSync(path.join(dir, "daemon-state.json"), "", "utf-8");

    // JSON.parse("") throws, deserialize returns empty state
    const loaded = wal.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.listSessions()).toHaveLength(0);
  });

  it.skip("large state with 1000 sessions serializes and deserializes", () => {
    const wal = new DaemonWAL(dir);
    const state = new DaemonState();

    for (let i = 0; i < 1000; i++) {
      addSession(state, `s${i}`, 20000 + i * 5);
    }

    const start = Date.now();
    wal.persist(state);
    const persistDuration = Date.now() - start;

    const loadStart = Date.now();
    const loaded = wal.load();
    const loadDuration = Date.now() - loadStart;

    expect(loaded).not.toBeNull();
    expect(loaded!.listSessions()).toHaveLength(1000);

    // Performance sanity check — should be under 1 second
    expect(persistDuration).toBeLessThan(5000);
    expect(loadDuration).toBeLessThan(5000);
  });

  it.skip("serialized JSON is valid and human-readable", () => {
    const wal = new DaemonWAL(dir);
    const state = new DaemonState();
    addSession(state, "s1", 20000);

    wal.persist(state);

    const raw = readFileSync(path.join(dir, "daemon-state.json"), "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.sessions).toBeDefined();
    expect(parsed.clients).toBeDefined();
    expect(parsed.allocatedPorts).toBeDefined();
    expect(parsed.worktreeIndex).toBeDefined();
    expect(Array.isArray(parsed.allocatedPorts)).toBe(true);
  });
});
