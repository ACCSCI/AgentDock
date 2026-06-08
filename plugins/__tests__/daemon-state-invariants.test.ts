import { describe, expect, it, beforeEach } from "vitest";
import { DaemonState, type SessionPorts } from "../daemon-state.js";

// ============================================================
// Helpers
// ============================================================

let portCounter = 20000;
function nextPorts(): SessionPorts {
  const base = portCounter;
  portCounter += 5;
  return {
    FRONTEND_PORT: base,
    BACKEND_PORT: base + 1,
    WS_PORT: base + 2,
    DEBUG_PORT: base + 3,
    PREVIEW_PORT: base + 4,
  };
}

function resetPortCounter() {
  portCounter = 20000;
}

function checkInvariants(state: DaemonState) {
  const sessions = state.listSessions();
  const allPorts = state.getAllAllocatedPorts();

  // Invariant 1: allocatedPorts.size === sum of ports per session (5 each)
  const expectedPortCount = sessions.length * 5;
  expect(allPorts.size).toBe(expectedPortCount);

  // Invariant 2: every sessionId in worktreeIndex exists in sessions
  for (const session of sessions) {
    const foundByWt = state.findSessionByWorktree(session.worktreePath);
    expect(foundByWt).toBe(session.sessionId);
  }

  // Invariant 3: no two sessions share the same worktreePath
  const worktreePaths = sessions.map((s) => s.worktreePath);
  expect(new Set(worktreePaths).size).toBe(worktreePaths.length);

  // Invariant 4: no two sessions share the same port
  const allPortList: number[] = [];
  for (const session of sessions) {
    for (const key of ["FRONTEND_PORT", "BACKEND_PORT", "WS_PORT", "DEBUG_PORT", "PREVIEW_PORT"] as const) {
      allPortList.push(session.ports[key]);
    }
  }
  expect(new Set(allPortList).size).toBe(allPortList.length);

  // Invariant 5: every port in allocatedPorts belongs to some session
  for (const port of allPorts) {
    const belongsToSession = allPortList.includes(port);
    expect(belongsToSession).toBe(true);
  }
}

// ============================================================
// Tests
// ============================================================

describe("DaemonState invariants", () => {
  let state: DaemonState;

  beforeEach(() => {
    state = new DaemonState();
    resetPortCounter();
  });

  it("invariants hold after random allocate/release 100 operations", () => {
    const sessionIds: string[] = [];

    for (let i = 0; i < 100; i++) {
      if (sessionIds.length > 0 && Math.random() < 0.4) {
        // Release a random session
        const idx = Math.floor(Math.random() * sessionIds.length);
        state.releaseSession(sessionIds[idx]);
        sessionIds.splice(idx, 1);
      } else {
        // Allocate a new session
        const sid = `s${i}`;
        const wtPath = `/wt/${sid}`;
        state.allocateSession({
          sessionId: sid,
          worktreePath: wtPath,
          projectPath: "/project",
          ports: nextPorts(),
          ownerClientId: "c1",
          ownerPid: 1000,
        });
        sessionIds.push(sid);
      }
      checkInvariants(state);
    }
  });

  it("invariants hold after random allocate/reassign 50 operations", () => {
    const sessionIds: string[] = [];

    for (let i = 0; i < 50; i++) {
      if (sessionIds.length > 0 && Math.random() < 0.3) {
        // Reassign a random session
        const idx = Math.floor(Math.random() * sessionIds.length);
        const newPorts = nextPorts();
        state.reassignSession(sessionIds[idx], newPorts);
      } else {
        // Allocate a new session
        const sid = `s${i}`;
        state.allocateSession({
          sessionId: sid,
          worktreePath: `/wt/${sid}`,
          projectPath: "/project",
          ports: nextPorts(),
          ownerClientId: "c1",
          ownerPid: 1000,
        });
        sessionIds.push(sid);
      }
      checkInvariants(state);
    }
  });

  it("invariants hold after serialize/deserialize roundtrip", () => {
    // Create some sessions
    for (let i = 0; i < 10; i++) {
      state.allocateSession({
        sessionId: `s${i}`,
        worktreePath: `/wt/s${i}`,
        projectPath: "/project",
        ports: nextPorts(),
        ownerClientId: "c1",
        ownerPid: 1000,
      });
    }

    checkInvariants(state);

    // Serialize and deserialize
    const json = state.serialize();
    const restored = DaemonState.deserialize(json);

    checkInvariants(restored);

    // Verify exact match
    expect(restored.listSessions().length).toBe(state.listSessions().length);
    expect(restored.getAllAllocatedPorts().size).toBe(state.getAllAllocatedPorts().size);
  });

  it("invariants hold after register/unregister client 50 operations", () => {
    const clientIds: string[] = [];

    for (let i = 0; i < 50; i++) {
      if (clientIds.length > 0 && Math.random() < 0.4) {
        const idx = Math.floor(Math.random() * clientIds.length);
        state.unregisterClient(clientIds[idx]);
        clientIds.splice(idx, 1);
      } else {
        const cid = `c${i}`;
        state.registerClient(cid, 1000 + i, ["/project"]);
        clientIds.push(cid);
      }
    }

    expect(state.listClients().length).toBe(clientIds.length);
  });

  it("release non-existent session is no-op", () => {
    state.allocateSession({
      sessionId: "s1",
      worktreePath: "/wt/s1",
      projectPath: "/project",
      ports: nextPorts(),
      ownerClientId: "c1",
      ownerPid: 1000,
    });

    const before = state.serialize();
    state.releaseSession("nonexistent");
    const after = state.serialize();

    expect(before).toBe(after);
    checkInvariants(state);
  });

  it("allocate duplicate sessionId throws", () => {
    state.allocateSession({
      sessionId: "s1",
      worktreePath: "/wt/s1",
      projectPath: "/project",
      ports: nextPorts(),
      ownerClientId: "c1",
      ownerPid: 1000,
    });

    expect(() => {
      state.allocateSession({
        sessionId: "s1",
        worktreePath: "/wt/s1-other",
        projectPath: "/project",
        ports: nextPorts(),
        ownerClientId: "c1",
        ownerPid: 1000,
      });
    }).toThrow("already exists");

    checkInvariants(state);
  });

  it("reassign non-existent session throws", () => {
    expect(() => {
      state.reassignSession("nonexistent", nextPorts());
    }).toThrow("not found");
  });

  it("worktree index stays consistent after release and re-allocate same worktreePath", () => {
    state.allocateSession({
      sessionId: "s1",
      worktreePath: "/wt/shared",
      projectPath: "/project",
      ports: nextPorts(),
      ownerClientId: "c1",
      ownerPid: 1000,
    });

    state.releaseSession("s1");

    // Re-allocate with same worktreePath but different sessionId
    state.allocateSession({
      sessionId: "s2",
      worktreePath: "/wt/shared",
      projectPath: "/project",
      ports: nextPorts(),
      ownerClientId: "c1",
      ownerPid: 1000,
    });

    expect(state.findSessionByWorktree("/wt/shared")).toBe("s2");
    checkInvariants(state);
  });

  it("heartbeat on non-existent client is no-op", () => {
    expect(() => state.heartbeat("nonexistent")).not.toThrow();
  });

  it("findDuplicate returns null for unknown worktreePath", () => {
    expect(state.findDuplicate("/unknown")).toBeNull();
  });
});
