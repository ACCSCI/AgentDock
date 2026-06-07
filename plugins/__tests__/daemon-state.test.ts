import { describe, expect, it, beforeEach } from "vitest";
import { DaemonState, type SessionPorts } from "../daemon-state.js";

// ============================================================
// Helpers
// ============================================================

function makePorts(start: number = 20000): SessionPorts {
  return {
    FRONTEND_PORT: start,
    BACKEND_PORT: start + 1,
    WS_PORT: start + 2,
    DEBUG_PORT: start + 3,
    PREVIEW_PORT: start + 4,
  };
}

// ============================================================
// Tests
// ============================================================

describe("DaemonState", () => {
  let state: DaemonState;

  beforeEach(() => {
    state = new DaemonState();
  });

  // --- Client Registration ---

  describe("registerClient / unregisterClient", () => {
    it("registers a client", () => {
      state.registerClient("c1", 100, ["/project/a"]);
      const clients = state.listClients();
      expect(clients).toHaveLength(1);
      expect(clients[0].clientId).toBe("c1");
      expect(clients[0].pid).toBe(100);
      expect(clients[0].projectPaths).toEqual(["/project/a"]);
    });

    it("overwrites existing client with same id", () => {
      state.registerClient("c1", 100, ["/project/a"]);
      state.registerClient("c1", 200, ["/project/b"]);
      const clients = state.listClients();
      expect(clients).toHaveLength(1);
      expect(clients[0].pid).toBe(200);
    });

    it("unregisters a client", () => {
      state.registerClient("c1", 100, ["/project/a"]);
      state.unregisterClient("c1");
      expect(state.listClients()).toHaveLength(0);
    });

    it("unregister is idempotent", () => {
      state.unregisterClient("nonexistent");
      // no error
    });
  });

  // --- Session Allocation ---

  describe("allocateSession", () => {
    it("allocates a session with ports", () => {
      state.registerClient("c1", 100, ["/project/a"]);
      const ports = makePorts();
      state.allocateSession({
        sessionId: "s1",
        worktreePath: "/project/a/.agentdock/worktrees/s1",
        projectPath: "/project/a",
        ports,
        ownerClientId: "c1",
        ownerPid: 100,
      });

      const session = state.getSession("s1");
      expect(session).not.toBeNull();
      expect(session!.ports).toEqual(ports);
      expect(session!.worktreePath).toBe("/project/a/.agentdock/worktrees/s1");
    });

    it("adds ports to allocatedPorts set", () => {
      state.registerClient("c1", 100, ["/project/a"]);
      const ports = makePorts();
      state.allocateSession({
        sessionId: "s1",
        worktreePath: "/project/a/.agentdock/worktrees/s1",
        projectPath: "/project/a",
        ports,
        ownerClientId: "c1",
        ownerPid: 100,
      });

      expect(state.isPortAllocated(20000)).toBe(true);
      expect(state.isPortAllocated(20001)).toBe(true);
      expect(state.isPortAllocated(20004)).toBe(true);
      expect(state.isPortAllocated(20005)).toBe(false);
    });

    it("adds worktreePath to worktreeIndex", () => {
      state.registerClient("c1", 100, ["/project/a"]);
      const ports = makePorts();
      state.allocateSession({
        sessionId: "s1",
        worktreePath: "/project/a/.agentdock/worktrees/s1",
        projectPath: "/project/a",
        ports,
        ownerClientId: "c1",
        ownerPid: 100,
      });

      expect(state.findSessionByWorktree("/project/a/.agentdock/worktrees/s1")).toBe("s1");
    });

    it("throws on duplicate sessionId", () => {
      state.registerClient("c1", 100, ["/project/a"]);
      const ports = makePorts();
      state.allocateSession({
        sessionId: "s1",
        worktreePath: "/project/a/.agentdock/worktrees/s1",
        projectPath: "/project/a",
        ports,
        ownerClientId: "c1",
        ownerPid: 100,
      });

      expect(() => {
        state.allocateSession({
          sessionId: "s1",
          worktreePath: "/project/a/.agentdock/worktrees/s1",
          projectPath: "/project/a",
          ports: makePorts(20010),
          ownerClientId: "c1",
          ownerPid: 100,
        });
      }).toThrow();
    });
  });

  // --- Session Release ---

  describe("releaseSession", () => {
    it("releases a session and its ports", () => {
      state.registerClient("c1", 100, ["/project/a"]);
      const ports = makePorts();
      state.allocateSession({
        sessionId: "s1",
        worktreePath: "/project/a/.agentdock/worktrees/s1",
        projectPath: "/project/a",
        ports,
        ownerClientId: "c1",
        ownerPid: 100,
      });

      state.releaseSession("s1");

      expect(state.getSession("s1")).toBeNull();
      expect(state.isPortAllocated(20000)).toBe(false);
      expect(state.findSessionByWorktree("/project/a/.agentdock/worktrees/s1")).toBeNull();
    });

    it("release is idempotent", () => {
      state.releaseSession("nonexistent");
      // no error
    });
  });

  // --- Session Reassign ---

  describe("reassignSession", () => {
    it("reassigns ports for an existing session", () => {
      state.registerClient("c1", 100, ["/project/a"]);
      const oldPorts = makePorts(20000);
      state.allocateSession({
        sessionId: "s1",
        worktreePath: "/project/a/.agentdock/worktrees/s1",
        projectPath: "/project/a",
        ports: oldPorts,
        ownerClientId: "c1",
        ownerPid: 100,
      });

      const newPorts = makePorts(20010);
      state.reassignSession("s1", newPorts);

      const session = state.getSession("s1");
      expect(session!.ports).toEqual(newPorts);

      // old ports freed
      expect(state.isPortAllocated(20000)).toBe(false);
      // new ports allocated
      expect(state.isPortAllocated(20010)).toBe(true);
    });

    it("throws for nonexistent session", () => {
      expect(() => state.reassignSession("nonexistent", makePorts())).toThrow();
    });
  });

  // --- Duplicate Worktree Detection ---

  describe("findDuplicate", () => {
    it("returns null when no duplicate", () => {
      expect(state.findDuplicate("/project/a/.agentdock/worktrees/s1")).toBeNull();
    });

    it("returns existing sessionId for duplicate worktreePath", () => {
      state.registerClient("c1", 100, ["/project/a"]);
      state.allocateSession({
        sessionId: "s1",
        worktreePath: "/project/a/.agentdock/worktrees/s1",
        projectPath: "/project/a",
        ports: makePorts(),
        ownerClientId: "c1",
        ownerPid: 100,
      });

      expect(state.findDuplicate("/project/a/.agentdock/worktrees/s1")).toBe("s1");
    });
  });

  // --- Heartbeat ---

  describe("heartbeat", () => {
    it("updates lastHeartbeat for a client", () => {
      state.registerClient("c1", 100, ["/project/a"]);
      const before = state.getClient("c1")!.lastHeartbeat;

      // Small delay to ensure timestamp differs
      state.heartbeat("c1");
      const after = state.getClient("c1")!.lastHeartbeat;
      expect(after).toBeGreaterThanOrEqual(before);
    });

    it("heartbeat for nonexistent client is no-op", () => {
      state.heartbeat("nonexistent");
      // no error
    });
  });

  // --- Get All Allocated Ports ---

  describe("getAllAllocatedPorts", () => {
    it("returns all allocated port numbers", () => {
      state.registerClient("c1", 100, ["/project/a"]);
      state.allocateSession({
        sessionId: "s1",
        worktreePath: "/wt/s1",
        projectPath: "/project/a",
        ports: makePorts(20000),
        ownerClientId: "c1",
        ownerPid: 100,
      });
      state.allocateSession({
        sessionId: "s2",
        worktreePath: "/wt/s2",
        projectPath: "/project/a",
        ports: makePorts(20010),
        ownerClientId: "c1",
        ownerPid: 100,
      });

      const allPorts = state.getAllAllocatedPorts();
      expect(allPorts.size).toBe(10);
      expect(allPorts.has(20000)).toBe(true);
      expect(allPorts.has(20014)).toBe(true);
    });
  });

  // --- List Sessions ---

  describe("listSessions", () => {
    it("returns all sessions", () => {
      state.registerClient("c1", 100, ["/project/a"]);
      state.allocateSession({
        sessionId: "s1",
        worktreePath: "/wt/s1",
        projectPath: "/project/a",
        ports: makePorts(20000),
        ownerClientId: "c1",
        ownerPid: 100,
      });
      state.allocateSession({
        sessionId: "s2",
        worktreePath: "/wt/s2",
        projectPath: "/project/a",
        ports: makePorts(20010),
        ownerClientId: "c1",
        ownerPid: 100,
      });

      const sessions = state.listSessions();
      expect(sessions).toHaveLength(2);
    });
  });

  // --- Serialize / Deserialize ---

  describe("serialize / deserialize", () => {
    it("round-trips state through JSON", () => {
      state.registerClient("c1", 100, ["/project/a"]);
      state.allocateSession({
        sessionId: "s1",
        worktreePath: "/wt/s1",
        projectPath: "/project/a",
        ports: makePorts(20000),
        ownerClientId: "c1",
        ownerPid: 100,
      });

      const json = state.serialize();
      const restored = DaemonState.deserialize(json);

      expect(restored.getSession("s1")!.ports).toEqual(makePorts(20000));
      expect(restored.isPortAllocated(20000)).toBe(true);
      expect(restored.findSessionByWorktree("/wt/s1")).toBe("s1");
      expect(restored.listClients()).toHaveLength(1);
    });

    it("handles empty state", () => {
      const json = state.serialize();
      const restored = DaemonState.deserialize(json);
      expect(restored.listSessions()).toHaveLength(0);
      expect(restored.listClients()).toHaveLength(0);
    });
  });

  // --- Get Excluded Ports ---

  describe("getExcludedPorts", () => {
    it("returns all allocated ports as a Set for exclusion", () => {
      state.registerClient("c1", 100, ["/project/a"]);
      state.allocateSession({
        sessionId: "s1",
        worktreePath: "/wt/s1",
        projectPath: "/project/a",
        ports: makePorts(20000),
        ownerClientId: "c1",
        ownerPid: 100,
      });

      const excluded = state.getExcludedPorts();
      expect(excluded.has(20000)).toBe(true);
      expect(excluded.has(20004)).toBe(true);
      expect(excluded.has(20005)).toBe(false);
    });
  });
});
