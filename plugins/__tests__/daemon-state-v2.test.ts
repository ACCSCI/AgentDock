/**
 * DaemonStateV2 unit tests — 新架构 §4.1, §3.5, §6.1, §4.4 invariants.
 */
import { describe, expect, it } from "vitest";
import {
  CURRENT_SCHEMA_VERSION,
  DaemonStateV2,
  PortConflictError,
  StaleOwnerError,
} from "../daemon-state-v2.js";

describe("DaemonStateV2 — schema", () => {
  it("CURRENT_SCHEMA_VERSION is 2", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
  });

  it("fresh state has empty ports / owners / sessions and is READY", () => {
    const s = new DaemonStateV2();
    expect(s.ports.size).toBe(0);
    expect(s.owners.size).toBe(0);
    expect(s.sessions.size).toBe(0);
    expect(s.state).toBe("READY");
    expect(s.isReady()).toBe(true);
    expect(s.isRecovering()).toBe(false);
  });

  it("state transitions RECOVERING → READY", () => {
    const s = new DaemonStateV2();
    s.setState("RECOVERING");
    expect(s.isRecovering()).toBe(true);
    s.setState("READY");
    expect(s.isReady()).toBe(true);
  });
});

describe("DaemonStateV2 — createSession / activate / rename / delete", () => {
  it("createSession inserts in all three tables with fencingToken=1", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/proj",
      displayName: "First",
      clientId: "client-A",
      pid: 1234,
      leaseExpiresAt: Date.now() + 15_000,
    });
    expect(s.sessions.get("u1")?.status).toBe("creating");
    expect(s.owners.get("u1")?.fencingToken).toBe(1);
    expect(s.owners.get("u1")?.clientId).toBe("client-A");
    expect(s.sessionPorts.get("u1")?.size).toBe(0);
  });

  it("createSession rejects duplicate sessionId", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/proj",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: Date.now() + 1000,
    });
    expect(() =>
      s.createSession({
        sessionId: "u1",
        projectRoot: "/proj",
        displayName: "x",
        clientId: "B",
        pid: 2,
        leaseExpiresAt: Date.now() + 1000,
      }),
    ).toThrow(/already exists/);
  });

  it("activateSession flips creating → active and clears lease", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/proj",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: Date.now() + 1000,
    });
    s.activateSession("u1");
    expect(s.sessions.get("u1")?.status).toBe("active");
    expect(s.sessions.get("u1")?.leaseExpiresAt).toBeNull();
  });

  it("renameSession only mutates displayName (no branch/path touched)", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/proj",
      displayName: "old",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: 0,
    });
    s.activateSession("u1");
    s.renameSession("u1", "new name 中文 🚀");
    expect(s.sessions.get("u1")?.displayName).toBe("new name 中文 🚀");
    // displayName must NOT leak into sessionPorts / sessionNames — those are
    // keyed off sessionId only (the §11.3 displayName isolation invariant).
    expect([...s.sessionPorts.keys()]).toEqual(["u1"]);
    expect([...s.sessionNames.values()][0]?.has("new name 中文 🚀")).toBe(
      false,
    );
  });

  it("rename refuses on non-active session", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: 0,
    });
    expect(() => s.renameSession("u1", "y")).toThrow(/Cannot rename/);
  });

  it("delete is two-phase — beginDelete then purgeSession", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: 0,
    });
    s.claimPort("u1", 3000, "FRONTEND_PORT");
    s.claimPort("u1", 3001, "BACKEND_PORT");
    s.beginDelete("u1", Date.now() + 1000);
    expect(s.sessions.get("u1")?.status).toBe("deleting");
    // All ports released back to FREE in one shot (整批语义)
    expect(s.ports.size).toBe(0);
    expect(s.getPortOwner(3000)).toBeNull();

    // Idempotent — calling beginDelete again does not error
    s.beginDelete("u1", Date.now() + 1000);
    expect(s.sessions.get("u1")?.status).toBe("deleting");

    s.purgeSession("u1");
    expect(s.sessions.has("u1")).toBe(false);
    expect(s.owners.has("u1")).toBe(false);
    expect(s.sessionPorts.has("u1")).toBe(false);
  });
});

describe("DaemonStateV2 — claim / release / 整批语义", () => {
  it("claimPort is idempotent for same (sessionId, port)", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: 0,
    });
    s.claimPort("u1", 3000, "FRONTEND_PORT");
    s.claimPort("u1", 3000, "FRONTEND_PORT");
    expect(s.ports.size).toBe(1);
  });

  it("claimPort throws PortConflictError if port reserved by another session", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: 0,
    });
    s.createSession({
      sessionId: "u2",
      projectRoot: "/p",
      displayName: "y",
      clientId: "B",
      pid: 2,
      leaseExpiresAt: 0,
    });
    s.claimPort("u1", 3000, "FRONTEND_PORT");
    expect(() => s.claimPort("u2", 3000, "FRONTEND_PORT")).toThrow(
      PortConflictError,
    );
  });

  it("releasePort is idempotent — releasing a free port returns false", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: 0,
    });
    expect(s.releasePort("u1", 3000)).toBe(false);
    s.claimPort("u1", 3000, "FRONTEND_PORT");
    expect(s.releasePort("u1", 3000)).toBe(true);
    expect(s.releasePort("u1", 3000)).toBe(false);
  });

  it("releasePort refuses to release another session's port", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: 0,
    });
    s.createSession({
      sessionId: "u2",
      projectRoot: "/p",
      displayName: "y",
      clientId: "B",
      pid: 2,
      leaseExpiresAt: 0,
    });
    s.claimPort("u1", 3000, "FRONTEND_PORT");
    expect(s.releasePort("u2", 3000)).toBe(false);
    expect(s.getPortOwner(3000)?.sessionId).toBe("u1");
  });

  it("整批语义 — releaseAllPorts releases N ports together", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: 0,
    });
    [3000, 3001, 3002, 3003, 3004].forEach((p, i) =>
      s.claimPort("u1", p, ["F", "B", "W", "D", "P"][i]!),
    );
    expect(s.ports.size).toBe(5);
    s.releaseAllPorts("u1");
    expect(s.ports.size).toBe(0);
  });

  it("getSessionPortNames reflects all names reserved for a session", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: 0,
    });
    s.claimPort("u1", 3000, "FRONTEND_PORT");
    s.claimPort("u1", 3001, "BACKEND_PORT");
    expect(s.getSessionPortNames("u1").sort()).toEqual([
      "BACKEND_PORT",
      "FRONTEND_PORT",
    ]);
  });
});

describe("DaemonStateV2 — fencing / takeover (§6.1)", () => {
  function newStateWithSession(): {
    s: DaemonStateV2;
    sessionId: string;
    clientId: string;
    pid: number;
  } {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "client-A",
      pid: 1234,
      leaseExpiresAt: 0,
    });
    return { s, sessionId: "u1", clientId: "client-A", pid: 1234 };
  }

  it("takeover with current token bumps fencingToken and returns new value", () => {
    const { s, sessionId } = newStateWithSession();
    const before = s.getOwner(sessionId)?.fencingToken;
    const r = s.takeover(sessionId, "client-B", 5678, before);
    expect(r.fencingToken).toBe((before ?? 0) + 1);
    expect(s.getOwner(sessionId)?.clientId).toBe("client-B");
    expect(s.getOwner(sessionId)?.pid).toBe(5678);
  });

  it("takeover with stale token throws StaleOwnerError", () => {
    const { s, sessionId } = newStateWithSession();
    expect(() => s.takeover(sessionId, "client-B", 5678, 99)).toThrow(
      StaleOwnerError,
    );
  });

  it("takeover with null token throws StaleOwnerError", () => {
    const { s, sessionId } = newStateWithSession();
    expect(() => s.takeover(sessionId, "client-B", 5678, null)).toThrow(
      StaleOwnerError,
    );
  });

  it("takeover monotonic — repeated takeovers strictly increase token", () => {
    const { s, sessionId } = newStateWithSession();
    let token = s.getOwner(sessionId)?.fencingToken ?? 0;
    for (let i = 0; i < 5; i++) {
      const r = s.takeover(sessionId, `B${i}`, 1000 + i, token);
      token = r.fencingToken;
    }
    expect(token).toBe(6); // started at 1, bumped 5 times
  });

  it("assertFencingToken gates writes — stale writes throw StaleOwnerError", () => {
    const { s, sessionId } = newStateWithSession();
    expect(() => s.assertFencingToken(sessionId, 1)).not.toThrow();
    expect(() => s.assertFencingToken(sessionId, 2)).toThrow(StaleOwnerError);
    expect(() => s.assertFencingToken(sessionId, null)).toThrow(StaleOwnerError);
  });
});

describe("DaemonStateV2 — lease (§4.4)", () => {
  it("renewLease refreshes leaseExpiresAt", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: 0,
    });
    const now = 1_000_000;
    s.renewLease("u1", 15_000);
    expect((s.sessions.get("u1")?.leaseExpiresAt ?? 0) > now).toBe(true);
  });

  it("clearLease nulls leaseExpiresAt", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: Date.now() + 1000,
    });
    s.clearLease("u1");
    expect(s.sessions.get("u1")?.leaseExpiresAt).toBeNull();
  });

  it("isSessionAbandoned requires BOTH lease expired AND heartbeat timed out", () => {
    const s = new DaemonStateV2();
    const now = 1_000_000;
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: now - 1000, // already expired
    });
    // Heartbeat still fresh → not abandoned
    expect(
      s.isSessionAbandoned("u1", now, 90_000, now - 5_000),
    ).toBe(false);
    // Heartbeat also timed out → abandoned
    expect(
      s.isSessionAbandoned("u1", now, 90_000, now - 100_000),
    ).toBe(true);
    // Heartbeat null (owner missing) AND lease expired → abandoned
    expect(s.isSessionAbandoned("u1", now, 90_000, null)).toBe(true);
  });

  it("active sessions never abandoned by lease predicate", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: Date.now() + 1000,
    });
    s.activateSession("u1");
    expect(
      s.isSessionAbandoned("u1", Date.now(), 90_000, null),
    ).toBe(false);
  });
});

describe("DaemonStateV2 — serialization round-trip", () => {
  it("serialize → deserialize preserves all three tables + lifecycle state", () => {
    const s = new DaemonStateV2();
    s.setDaemonPort(41573);
    s.setState("RECOVERING");
    s.createSession({
      sessionId: "u1",
      projectRoot: "/proj",
      displayName: "中文 🚀 name",
      clientId: "client-A",
      pid: 1234,
      leaseExpiresAt: Date.now() + 15_000,
    });
    s.claimPort("u1", 3000, "FRONTEND_PORT");
    s.claimPort("u1", 3001, "BACKEND_PORT");

    const json = JSON.stringify(s.serialize());
    const restored = DaemonStateV2.deserialize(json);

    expect(restored.sessions.get("u1")?.displayName).toBe("中文 🚀 name");
    expect(restored.owners.get("u1")?.fencingToken).toBe(1);
    expect(restored.ports.get(3000)?.sessionId).toBe("u1");
    expect(restored.ports.get(3000)?.name).toBe("FRONTEND_PORT");
    expect(restored.getSessionPortNames("u1").sort()).toEqual([
      "BACKEND_PORT",
      "FRONTEND_PORT",
    ]);
    expect(restored.daemonPort).toBe(41573);
    expect(restored.state).toBe("RECOVERING");
  });

  it("deserialize refuses wrong schemaVersion", () => {
    expect(() =>
      DaemonStateV2.deserialize(
        JSON.stringify({
          schemaVersion: 1,
          ports: {},
          owners: {},
          sessions: {},
        }),
      ),
    ).toThrow(/schemaVersion/);
  });

  it("deserialize from missing fields yields empty state", () => {
    const restored = DaemonStateV2.deserialize(
      JSON.stringify({ schemaVersion: 2 }),
    );
    expect(restored.ports.size).toBe(0);
    expect(restored.owners.size).toBe(0);
    expect(restored.sessions.size).toBe(0);
  });
});

describe("DaemonStateV2 — derived sessionPorts / sessionNames cache invariants", () => {
  it("sessionPorts cache stays in sync with ports map across claim/release/purge", () => {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt: 0,
    });
    s.claimPort("u1", 3000, "FRONTEND_PORT");
    expect(s.sessionPorts.get("u1")?.has(3000)).toBe(true);
    s.releasePort("u1", 3000);
    expect(s.sessionPorts.get("u1")?.has(3000)).toBe(false);
    s.claimPort("u1", 3001, "BACKEND_PORT");
    expect(s.sessionPorts.get("u1")?.size).toBe(1);

    s.beginDelete("u1", Date.now() + 1000);
    expect(s.sessionPorts.get("u1")?.size).toBe(0);
    s.purgeSession("u1");
    expect(s.sessionPorts.has("u1")).toBe(false);
  });
});
