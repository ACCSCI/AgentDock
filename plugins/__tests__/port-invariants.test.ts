import { describe, expect, it, beforeEach } from "vitest";
import { DaemonState, PORT_KEYS, type SessionPorts } from "../daemon-state.js";

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

function expectPortConsistency(state: DaemonState) {
  const sessions = state.listSessions();
  const allPorts = state.getAllAllocatedPorts();

  // Build expected port set from sessions
  const expectedPorts = new Set<number>();
  for (const session of sessions) {
    for (const key of PORT_KEYS) {
      expectedPorts.add(session.ports[key]);
    }
  }

  expect(allPorts.size).toBe(expectedPorts.size);
  for (const port of allPorts) {
    expect(expectedPorts.has(port)).toBe(true);
  }
}

describe("Port invariants", () => {
  let state: DaemonState;

  beforeEach(() => {
    state = new DaemonState();
    portCounter = 20000;
  });

  it("10 sessions = 50 allocated ports", () => {
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

    expect(state.getAllAllocatedPorts().size).toBe(50);
    expectPortConsistency(state);
  });

  it("delete 5 of 10 sessions = 25 allocated ports", () => {
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

    for (let i = 0; i < 5; i++) {
      state.releaseSession(`s${i}`);
    }

    expect(state.getAllAllocatedPorts().size).toBe(25);
    expectPortConsistency(state);
  });

  it("reassign: old ports freed, new ports taken, total unchanged", () => {
    state.allocateSession({
      sessionId: "s1",
      worktreePath: "/wt/s1",
      projectPath: "/project",
      ports: nextPorts(),
      ownerClientId: "c1",
      ownerPid: 1000,
    });

    const oldPorts = state.getSession("s1")!.ports;
    const newPorts = nextPorts();

    state.reassignSession("s1", newPorts);

    // Old ports should not be allocated
    expect(state.isPortAllocated(oldPorts.FRONTEND_PORT)).toBe(false);
    expect(state.isPortAllocated(oldPorts.BACKEND_PORT)).toBe(false);

    // New ports should be allocated
    expect(state.isPortAllocated(newPorts.FRONTEND_PORT)).toBe(true);
    expect(state.isPortAllocated(newPorts.BACKEND_PORT)).toBe(true);

    // Total should still be 5
    expect(state.getAllAllocatedPorts().size).toBe(5);
    expectPortConsistency(state);
  });

  it("create → delete → create same worktreePath: worktreeIndex correct", () => {
    state.allocateSession({
      sessionId: "s1",
      worktreePath: "/wt/shared",
      projectPath: "/project",
      ports: nextPorts(),
      ownerClientId: "c1",
      ownerPid: 1000,
    });

    expect(state.findDuplicate("/wt/shared")).toBe("s1");

    state.releaseSession("s1");
    expect(state.findDuplicate("/wt/shared")).toBeNull();

    state.allocateSession({
      sessionId: "s2",
      worktreePath: "/wt/shared",
      projectPath: "/project",
      ports: nextPorts(),
      ownerClientId: "c1",
      ownerPid: 1000,
    });

    expect(state.findDuplicate("/wt/shared")).toBe("s2");
    expectPortConsistency(state);
  });

  it("serialize → deserialize: port counts match", () => {
    for (let i = 0; i < 20; i++) {
      state.allocateSession({
        sessionId: `s${i}`,
        worktreePath: `/wt/s${i}`,
        projectPath: "/project",
        ports: nextPorts(),
        ownerClientId: "c1",
        ownerPid: 1000,
      });
    }

    const json = state.serialize();
    const restored = DaemonState.deserialize(json);

    expect(restored.getAllAllocatedPorts().size).toBe(100);
    expect(restored.listSessions().length).toBe(20);
    expectPortConsistency(restored);
  });

  it("100 random create/release: allocatedPorts matches sessions", () => {
    const ids: string[] = [];

    for (let i = 0; i < 100; i++) {
      if (ids.length > 0 && Math.random() < 0.4) {
        const idx = Math.floor(Math.random() * ids.length);
        state.releaseSession(ids[idx]);
        ids.splice(idx, 1);
      } else {
        const sid = `s${i}`;
        state.allocateSession({
          sessionId: sid,
          worktreePath: `/wt/${sid}`,
          projectPath: "/project",
          ports: nextPorts(),
          ownerClientId: "c1",
          ownerPid: 1000,
        });
        ids.push(sid);
      }
      expectPortConsistency(state);
    }
  });
});
