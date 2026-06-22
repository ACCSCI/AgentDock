/**
 * WAL v1→v2 migration tests — 新架构 §5.1.1.
 */
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonStateV2 } from "../daemon-state-v2.js";
import { DaemonWALV2 as DaemonWAL } from "../daemon-wal-v2.js";
import {
  MIGRATIONS,
  migrateToCurrent,
  validateV2State,
} from "../daemon-migrate.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "agentdock-wal-v2-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("migrateToCurrent — version chain", () => {
  it("passes through if already at CURRENT_SCHEMA_VERSION", () => {
    const cur = { schemaVersion: 2, ports: {}, owners: {}, sessions: {} };
    const out = migrateToCurrent(cur);
    expect(out).toBe(cur); // identity, no copy
  });

  it("treats missing schemaVersion as v1 (real-world v1 has no field)", () => {
    const v1 = {
      sessions: {},
      clients: {},
      allocatedPorts: [],
      worktreeIndex: {},
    };
    const out = migrateToCurrent(v1 as never);
    expect(out.schemaVersion).toBe(2);
  });

  it("rejects downgrade — schemaVersion higher than CURRENT throws", () => {
    expect(() => migrateToCurrent({ schemaVersion: 99 })).toThrow(
      /newer daemon/,
    );
  });

  it("rejects migration chain gaps", () => {
    // Pretend we lost the v1→v2 migrator
    const original = MIGRATIONS[1];
    delete MIGRATIONS[1];
    try {
      expect(() =>
        migrateToCurrent({ sessions: {}, clients: {} } as never),
      ).toThrow(/Migration gap/);
    } finally {
      MIGRATIONS[1] = original;
    }
  });

  it("catches a buggy migrator that forgets to bump schemaVersion", () => {
    const original = MIGRATIONS[1];
    MIGRATIONS[1] = (s) => s; // bug: no bump
    try {
      expect(() =>
        migrateToCurrent({ sessions: {}, clients: {} } as never),
      ).toThrow(/did not bump schemaVersion/);
    } finally {
      MIGRATIONS[1] = original;
    }
  });
});

describe("migrate_v1_to_v2 — field mapping (§5.1.1)", () => {
  it("preserves ports by expanding v1 SessionEntry.ports into per-port records", () => {
    const v1 = {
      sessions: {
        s1: {
          sessionId: "s1",
          worktreePath: "/proj/.agentdock/worktrees/s1",
          projectPath: "/proj",
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
          projectPaths: ["/proj"],
          lastHeartbeat: 1700000000000,
        },
      },
      allocatedPorts: [30000, 30001],
      worktreeIndex: { "/proj/.agentdock/worktrees/s1": "s1" },
    };
    const v2 = migrateToCurrent(v1 as never) as Record<string, unknown>;
    const ports = v2.ports as Record<number, { sessionId: string; name: string }>;
    expect(ports[30000]).toEqual({
      port: 30000,
      sessionId: "s1",
      name: "FRONTEND_PORT",
      state: "RESERVED",
    });
    expect(ports[30001]?.name).toBe("BACKEND_PORT");
  });

  it("promotes owner to owners table with fencingToken=1", () => {
    const v1 = {
      sessions: {
        s1: {
          sessionId: "s1",
          worktreePath: "/p/.agentdock/worktrees/s1",
          projectPath: "/p",
          ports: {},
          ownerClientId: "clientA",
          ownerPid: 111,
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
      clients: {},
      allocatedPorts: [],
      worktreeIndex: {},
    };
    const v2 = migrateToCurrent(v1 as never) as Record<string, unknown>;
    const owners = v2.owners as Record<
      string,
      { clientId: string; pid: number; fencingToken: number }
    >;
    expect(owners.s1).toEqual({
      clientId: "clientA",
      pid: 111,
      fencingToken: 1,
    });
  });

  it("renames projectPath → projectRoot and derives displayName", () => {
    const v1 = {
      sessions: {
        abc12345: {
          sessionId: "abc12345",
          worktreePath: "/p/.agentdock/worktrees/abc12345",
          projectPath: "/p",
          ports: {},
          ownerClientId: "c",
          ownerPid: 1,
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
      clients: {},
      allocatedPorts: [],
      worktreeIndex: {},
    };
    const v2 = migrateToCurrent(v1 as never) as Record<string, unknown>;
    const sessions = v2.sessions as Record<
      string,
      { projectRoot: string; displayName: string; status: string }
    >;
    expect(sessions.abc12345.projectRoot).toBe("/p");
    expect(sessions.abc12345.displayName).toBe("abc12345"); // first 8 of sessionId
    expect(sessions.abc12345.status).toBe("active");
  });

  it("derives projectRoot from worktreePath when projectPath is missing", () => {
    const v1 = {
      sessions: {
        s1: {
          sessionId: "s1",
          worktreePath: "/home/user/proj/.agentdock/worktrees/s1",
          // no projectPath
          ports: {},
          ownerClientId: "c",
          ownerPid: 1,
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
      clients: {},
      allocatedPorts: [],
      worktreeIndex: {},
    };
    const v2 = migrateToCurrent(v1 as never) as Record<string, unknown>;
    const sessions = v2.sessions as Record<string, { projectRoot: string }>;
    expect(sessions.s1.projectRoot).toBe("/home/user/proj");
  });

  it("warns but proceeds when worktreePath suffix doesn't match sessionId", () => {
    const v1 = {
      sessions: {
        s1: {
          sessionId: "s1",
          worktreePath: "/some/random/path/no_marker",
          ports: {},
          ownerClientId: "c",
          ownerPid: 1,
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
      clients: {},
      allocatedPorts: [],
      worktreeIndex: {},
    };
    const v2 = migrateToCurrent(v1 as never) as Record<string, unknown>;
    const sessions = v2.sessions as Record<string, { projectRoot: string }>;
    expect(sessions.s1.projectRoot).toBe("");
    expect(
      (v2._migrationWarnings as string[]).some((w) => w.includes("s1")),
    ).toBe(true);
  });

  it("drop v1 worktreeIndex (v2 derives worktreePath live from sessionId)", () => {
    const v1 = {
      sessions: {},
      clients: {},
      allocatedPorts: [],
      worktreeIndex: { "/some/path": "s1" },
    };
    const v2 = migrateToCurrent(v1 as never) as Record<string, unknown>;
    expect(v2).not.toHaveProperty("worktreeIndex");
  });

  it("port collision between two sessions in v1 → keep first, warn", () => {
    const v1 = {
      sessions: {
        s1: {
          sessionId: "s1",
          worktreePath: "/p/.agentdock/worktrees/s1",
          projectPath: "/p",
          ports: { X: 30000 },
          ownerClientId: "c",
          ownerPid: 1,
          createdAt: "2026-01-01T00:00:00Z",
        },
        s2: {
          sessionId: "s2",
          worktreePath: "/p/.agentdock/worktrees/s2",
          projectPath: "/p",
          ports: { X: 30000 }, // SAME port!
          ownerClientId: "c",
          ownerPid: 1,
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
      clients: {},
      allocatedPorts: [30000],
      worktreeIndex: {},
    };
    const v2 = migrateToCurrent(v1 as never) as Record<string, unknown>;
    const ports = v2.ports as Record<number, { sessionId: string }>;
    expect(ports[30000]?.sessionId).toBe("s1");
    expect(
      (v2._migrationWarnings as string[]).some((w) => w.includes("skipped s2")),
    ).toBe(true);
  });

  it("v1 allocatedPorts referencing unowned ports → dropped from registry", () => {
    const v1 = {
      sessions: {
        s1: {
          sessionId: "s1",
          worktreePath: "/p/.agentdock/worktrees/s1",
          projectPath: "/p",
          ports: { X: 30000 },
          ownerClientId: "c",
          ownerPid: 1,
          createdAt: "2026-01-01T00:00:00Z",
        },
      },
      clients: {},
      allocatedPorts: [30000, 30001], // 30001 is orphan
      worktreeIndex: {},
    };
    const v2 = migrateToCurrent(v1 as never) as Record<string, unknown>;
    const ports = v2.ports as Record<number, unknown>;
    expect(ports[30001]).toBeUndefined();
    expect(
      (v2._migrationWarnings as string[]).some((w) =>
        w.includes("30001"),
      ),
    ).toBe(true);
  });
});

describe("validateV2State", () => {
  it("accepts a well-formed v2 state", () => {
    expect(
      validateV2State({
        schemaVersion: 2,
        ports: {},
        owners: {},
        sessions: {},
      }),
    ).toEqual([]);
  });

  it("rejects wrong schemaVersion", () => {
    expect(
      validateV2State({
        schemaVersion: 3,
        ports: {},
        owners: {},
        sessions: {},
      }),
    ).toContain("schemaVersion=3 (expected 2)");
  });

  it("rejects missing ports/owners/sessions", () => {
    expect(
      validateV2State({ schemaVersion: 2 } as never),
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining("ports"),
        expect.stringContaining("owners"),
        expect.stringContaining("sessions"),
      ]),
    );
  });
});

describe("DaemonWAL — load/persist round-trip with v2", () => {
  it("persist then load returns identical state", () => {
    const wal = new DaemonWAL(tmpDir);
    const s = new DaemonStateV2();
    s.setDaemonPort(41573);
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "Test",
      clientId: "c1",
      pid: 100,
      leaseExpiresAt: Date.now() + 1000,
    });
    s.claimPort("u1", 3000, "FRONTEND_PORT");

    wal.persist(s);
    const loaded = wal.load();

    expect(loaded).not.toBeNull();
    expect(loaded?.getSession("u1")?.displayName).toBe("Test");
    expect(loaded?.getPortOwner(3000)?.sessionId).toBe("u1");
    expect(loaded?.daemonPort).toBe(41573);
  });

  it("load returns null when no file", () => {
    const wal = new DaemonWAL(tmpDir);
    expect(wal.load()).toBeNull();
  });

  it("load throws on corrupt JSON", () => {
    const wal = new DaemonWAL(tmpDir);
    writeFileSync(wal.getPath(), "{ not json", "utf-8");
    expect(() => wal.load()).toThrow(/not valid JSON/);
  });
});

describe("DaemonWAL — v1 → v2 migration on load", () => {
  function writeV1Fixture(): void {
    const v1 = {
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
    writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(v1));
  }

  it("migrates real v1 file on load, returns valid v2 state", () => {
    writeV1Fixture();
    const wal = new DaemonWAL(tmpDir);
    const loaded = wal.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.getSession("s1")?.projectRoot).toBe("/p");
    expect(loaded?.getOwner("s1")?.fencingToken).toBe(1);
    expect(loaded?.getPortOwner(30000)?.sessionId).toBe("s1");
    expect(loaded?.getPortOwner(30001)?.name).toBe("BACKEND_PORT");
  });

  it("creates backup file on first upgrade (idempotent)", () => {
    writeV1Fixture();
    const wal = new DaemonWAL(tmpDir);
    expect(existsSync(path.join(tmpDir, "daemon-state.json.bak.v1"))).toBe(
      false,
    );
    wal.load();
    expect(existsSync(path.join(tmpDir, "daemon-state.json.bak.v1"))).toBe(
      true,
    );

    // Re-loading does NOT overwrite the backup
    const backupBefore = readFileSync(
      path.join(tmpDir, "daemon-state.json.bak.v1"),
      "utf-8",
    );
    wal.load();
    const backupAfter = readFileSync(
      path.join(tmpDir, "daemon-state.json.bak.v1"),
      "utf-8",
    );
    expect(backupBefore).toBe(backupAfter);
  });

  it("persists migrated state — second load takes fast path (no migration)", () => {
    writeV1Fixture();
    const wal = new DaemonWAL(tmpDir);
    wal.load();

    // After migration, file should be v2 (raw JSON on disk)
    const onDisk = JSON.parse(
      readFileSync(path.join(tmpDir, "daemon-state.json"), "utf-8"),
    );
    expect(onDisk.schemaVersion).toBe(2);
    expect(onDisk.ports[30000]?.sessionId).toBe("s1");
  });

  it("rejects v99 file (downgrade forbidden)", () => {
    writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({ schemaVersion: 99 }),
    );
    const wal = new DaemonWAL(tmpDir);
    expect(() => wal.load()).toThrow(/newer daemon/);
  });

  it("handles empty v1 (no sessions, no ports)", () => {
    writeFileSync(
      path.join(tmpDir, "daemon-state.json"),
      JSON.stringify({
        sessions: {},
        clients: {},
        allocatedPorts: [],
        worktreeIndex: {},
      }),
    );
    const wal = new DaemonWAL(tmpDir);
    const loaded = wal.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.ports.size).toBe(0);
    expect(loaded?.sessions.size).toBe(0);
  });

  it("preserves v1 daemonPort through migration", () => {
    const v1 = {
      sessions: {},
      clients: {},
      allocatedPorts: [],
      worktreeIndex: {},
      daemonPort: 12345,
    };
    writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(v1));
    const wal = new DaemonWAL(tmpDir);
    const loaded = wal.load();
    expect(loaded?.daemonPort).toBe(12345);
  });
});

describe("DaemonWAL — idempotency", () => {
  it("running load twice on a v1 file gives the same result", () => {
    const v1 = {
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
    writeFileSync(path.join(tmpDir, "daemon-state.json"), JSON.stringify(v1));
    const wal = new DaemonWAL(tmpDir);
    const a = wal.load();
    const b = wal.load();
    expect(a?.serialize()).toEqual(b?.serialize());
  });
});

describe("DaemonWAL — concurrent persists don't corrupt file", () => {
  it("two persist calls back-to-back both produce parseable file", () => {
    const wal = new DaemonWAL(tmpDir);
    const a = new DaemonStateV2();
    a.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "first",
      clientId: "c1",
      pid: 1,
      leaseExpiresAt: 0,
    });
    wal.persist(a);

    const b = new DaemonStateV2();
    b.createSession({
      sessionId: "u2",
      projectRoot: "/p",
      displayName: "second",
      clientId: "c2",
      pid: 2,
      leaseExpiresAt: 0,
    });
    wal.persist(b);

    const loaded = wal.load();
    expect(loaded?.sessions.size).toBe(1);
    expect(loaded?.sessions.get("u2")?.displayName).toBe("second");
  });

  it("v2 file copy survives rename-equivalent (tmp file absent on success)", () => {
    const wal = new DaemonWAL(tmpDir);
    const s = new DaemonStateV2();
    wal.persist(s);
    expect(existsSync(`${wal.getPath()}.tmp`)).toBe(false);
    expect(existsSync(wal.getPath())).toBe(true);
  });
});

// Avoid "unused import" — copyFileSync is reserved for future backup strategies
void copyFileSync;
