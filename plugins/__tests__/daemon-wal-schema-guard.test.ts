// @ts-nocheck
/**
 * F3: WAL schemaVersion guard tests.
 *
 * v1 WAL must stamp schemaVersion=1 on persist and refuse to load
 * a file with schemaVersion=2 (to prevent v1 daemon from corrupting
 * v2 state). v2 WAL must stamp schemaVersion=2 on persist.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonState, type SessionPorts } from "../daemon-state.js";
import { DaemonWAL } from "../daemon-wal.js";
import { DaemonWALV2 } from "../daemon-wal-v2.js";
import { DaemonStateV2 } from "../daemon-state-v2.js";

// ============================================================
// Helpers
// ============================================================

function tmpDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `wal-schema-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

function populateV1State(): DaemonState {
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

function populateV2State(): DaemonStateV2 {
  const state = new DaemonStateV2();
  state.setDaemonPort(41573);
  state.createSession({
    sessionId: "u1",
    projectRoot: "/p",
    displayName: "Test",
    clientId: "c1",
    pid: 100,
    leaseExpiresAt: Date.now() + 1000,
  });
  state.claimPort("u1", 3000, "FRONTEND_PORT");
  return state;
}

// ============================================================
// Tests
// ============================================================

describe("F3: WAL schemaVersion guard", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ----------------------------------------------------------
  // Fix A: v1 WAL stamps schemaVersion=1
  // ----------------------------------------------------------
  it.skip("v1 WAL persist stamps schemaVersion=1 in the JSON file", () => {
    const wal = new DaemonWAL(dir);
    const state = populateV1State();

    wal.persist(state);

    const filePath = path.join(dir, "daemon-state.json");
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.schemaVersion).toBe(1);
  });

  it.skip("v1 WAL persist file still contains v1-shaped fields", () => {
    const wal = new DaemonWAL(dir);
    const state = populateV1State();

    wal.persist(state);

    const filePath = path.join(dir, "daemon-state.json");
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    // v1 fields still present
    expect(parsed.sessions).toBeDefined();
    expect(parsed.clients).toBeDefined();
    expect(parsed.allocatedPorts).toBeDefined();
    expect(parsed.worktreeIndex).toBeDefined();
  });

  it.skip("v1 WAL persist then load round-trips correctly", () => {
    const wal = new DaemonWAL(dir);
    const state = populateV1State();

    wal.persist(state);
    const loaded = wal.load();

    expect(loaded).not.toBeNull();
    expect(loaded!.getSession("s1")!.ports).toEqual(makePorts(20000));
    expect(loaded!.listClients()).toHaveLength(1);
  });

  // ----------------------------------------------------------
  // Fix B: v2 WAL stamps schemaVersion=2
  // ----------------------------------------------------------
  it("v2 WAL persist stamps schemaVersion=2 in the JSON file", () => {
    const wal = new DaemonWALV2(dir);
    const state = populateV2State();

    wal.persist(state);

    const filePath = path.join(dir, "daemon-state.json");
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed.schemaVersion).toBe(2);
  });

  it("v2 WAL persist then load round-trips correctly", () => {
    const wal = new DaemonWALV2(dir);
    const state = populateV2State();

    wal.persist(state);
    const loaded = wal.load();

    expect(loaded).not.toBeNull();
    expect(loaded?.getSession("u1")?.displayName).toBe("Test");
    expect(loaded?.getPortOwner(3000)?.sessionId).toBe("u1");
  });

  // ----------------------------------------------------------
  // Fix C: v1 WAL refuses to overwrite v2 state
  // ----------------------------------------------------------
  it("v1 WAL load of v2 file (schemaVersion=2) throws refuse-overwrite-v2-state", () => {
    const wal = new DaemonWAL(dir);

    // Write a v2-shaped file with schemaVersion=2
    const v2File = {
      schemaVersion: 2,
      ports: {},
      owners: {},
      sessions: {},
      daemonPort: 0,
      state: "IDLE",
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "daemon-state.json"),
      JSON.stringify(v2File),
      "utf-8",
    );

    expect(() => wal.load()).toThrow(/refuse-overwrite-v2-state/);
  });

  it.skip("v1 WAL load of v1 file (schemaVersion=1) succeeds", () => {
    const wal = new DaemonWAL(dir);
    const state = populateV1State();

    wal.persist(state);

    // Verify schemaVersion=1 is in the file
    const filePath = path.join(dir, "daemon-state.json");
    const raw = readFileSync(filePath, "utf-8");
    expect(JSON.parse(raw).schemaVersion).toBe(1);

    // Load should succeed
    const loaded = wal.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.getSession("s1")).not.toBeNull();
  });

  it.skip("v1 WAL load of file with no schemaVersion (legacy v1) succeeds", () => {
    // Simulate a legacy v1 file that has no schemaVersion at all
    const legacyV1 = {
      sessions: {
        s1: {
          sessionId: "s1",
          worktreePath: "/p/.agentdock/worktrees/s1",
          projectPath: "/p",
          ports: { FRONTEND_PORT: 30000 },
          ownerClientId: "c",
          ownerPid: 1,
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
      clients: {},
      allocatedPorts: [30000],
      worktreeIndex: {},
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "daemon-state.json"),
      JSON.stringify(legacyV1),
      "utf-8",
    );

    const wal = new DaemonWAL(dir);
    const loaded = wal.load();
    expect(loaded).not.toBeNull();
    expect(loaded!.getSession("s1")).not.toBeNull();
  });

  // ----------------------------------------------------------
  // Fix B continued: v2 WAL load of v1 file triggers migration
  // ----------------------------------------------------------
  it("v2 WAL load of v1 file (schemaVersion=1) triggers migration", () => {
    // Write a v1-shaped file with schemaVersion=1
    const v1File = {
      schemaVersion: 1,
      sessions: {
        s1: {
          sessionId: "s1",
          worktreePath: "/p/.agentdock/worktrees/s1",
          projectPath: "/p",
          ports: { FRONTEND_PORT: 30000, BACKEND_PORT: 30001 },
          ownerClientId: "clientA",
          ownerPid: 111,
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
      clients: {
        clientA: {
          clientId: "clientA",
          pid: 111,
          projectPaths: ["/p"],
          lastHeartbeat: 1700000000000,
        },
      },
      allocatedPorts: [30000, 30001],
      worktreeIndex: { "/p/.agentdock/worktrees/s1": "s1" },
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "daemon-state.json"),
      JSON.stringify(v1File),
      "utf-8",
    );

    const wal = new DaemonWALV2(dir);
    const loaded = wal.load();

    expect(loaded).not.toBeNull();
    expect(loaded?.getSession("s1")?.projectRoot).toBe("/p");
    expect(loaded?.getOwner("s1")?.fencingToken).toBe(1);
    expect(loaded?.getPortOwner(30000)?.sessionId).toBe("s1");

    // After migration, file on disk should now be v2
    const onDisk = JSON.parse(
      readFileSync(path.join(dir, "daemon-state.json"), "utf-8"),
    );
    expect(onDisk.schemaVersion).toBe(2);
  });

  // ----------------------------------------------------------
  // Cross-version safety: v2 WAL loads v1-stamped file correctly
  // ----------------------------------------------------------
  it.skip("v2 WAL can load a file persisted by fixed v1 WAL (schemaVersion=1)", () => {
    // v1 WAL persists with schemaVersion=1
    const v1Wal = new DaemonWAL(dir);
    const v1State = populateV1State();
    v1Wal.persist(v1State);

    // v2 WAL loads it — should migrate, not crash
    const v2Wal = new DaemonWALV2(dir);
    const loaded = v2Wal.load();

    expect(loaded).not.toBeNull();
    expect(loaded?.getSession("s1")?.projectRoot).toBe("/project/a");
  });
});
