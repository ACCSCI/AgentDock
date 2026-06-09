import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { DaemonState, PORT_KEYS, type SessionPorts } from "../daemon-state.js";
import { AgentDockDaemon } from "../daemon.js";
import { DaemonClient } from "../daemon-client.js";
import http from "node:http";
import { createServer, type Server } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ============================================================
// Helpers
// ============================================================

let portCounter = 30000;
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

function makePorts(start: number): SessionPorts {
  return {
    FRONTEND_PORT: start,
    BACKEND_PORT: start + 1,
    WS_PORT: start + 2,
    DEBUG_PORT: start + 3,
    PREVIEW_PORT: start + 4,
  };
}

function resetPortCounter() {
  portCounter = 30000;
}

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `port-conflict-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function get(port: number, pathname: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    http.get({ hostname: "127.0.0.1", port, path: pathname }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode!, data }); }
      });
    }).on("error", reject);
  });
}

function post(port: number, pathname: string, body: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(body);
    const req = http.request({ hostname: "127.0.0.1", port, path: pathname, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) } }, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode!, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode!, data }); }
      });
    });
    req.on("error", reject);
    req.write(json);
    req.end();
  });
}

function listenOnPort(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(port, "127.0.0.1", () => resolve(server));
    server.on("error", reject);
  });
}

function addSession(state: DaemonState, id: string, portBase: number, wtPath?: string) {
  state.allocateSession({
    sessionId: id,
    worktreePath: wtPath ?? `/wt/${id}`,
    projectPath: "/project",
    ports: makePorts(portBase),
    ownerClientId: "c1",
    ownerPid: 1000,
  });
}

function checkInvariants(state: DaemonState) {
  const result = state.checkInvariants();
  for (const check of result.checks) {
    expect(check.passed).toBe(true);
  }
  expect(result.valid).toBe(true);
}

// ============================================================
// Layer 2: DaemonState.allocateSession port conflict rejection
// ============================================================

describe("Layer 2: allocateSession rejects port conflicts", () => {
  let state: DaemonState;

  beforeEach(() => {
    state = new DaemonState();
    resetPortCounter();
  });

  it("T1: throws when FRONTEND_PORT conflicts with existing session", () => {
    addSession(state, "s1", 20000);

    expect(() => {
      state.allocateSession({
        sessionId: "s2",
        worktreePath: "/wt/s2",
        projectPath: "/project",
        ports: makePorts(20000), // same ports as s1
        ownerClientId: "c1",
        ownerPid: 1000,
      });
    }).toThrow(/Port conflict.*FRONTEND_PORT.*20000/);

    // State unchanged: only s1 exists
    expect(state.listSessions()).toHaveLength(1);
    checkInvariants(state);
  });

  it("T2: succeeds when ports are unique", () => {
    addSession(state, "s1", 20000);
    addSession(state, "s2", 20010);

    expect(state.listSessions()).toHaveLength(2);
    expect(state.isPortAllocated(20000)).toBe(true);
    expect(state.isPortAllocated(20010)).toBe(true);
    checkInvariants(state);
  });

  it("T3: throws when any single port in the set conflicts", () => {
    addSession(state, "s1", 20000);

    // Overlap only on BACKEND_PORT (20001)
    expect(() => {
      state.allocateSession({
        sessionId: "s2",
        worktreePath: "/wt/s2",
        projectPath: "/project",
        ports: {
          FRONTEND_PORT: 20100,
          BACKEND_PORT: 20001, // conflicts with s1
          WS_PORT: 20102,
          DEBUG_PORT: 20103,
          PREVIEW_PORT: 20104,
        },
        ownerClientId: "c1",
        ownerPid: 1000,
      });
    }).toThrow(/Port conflict.*BACKEND_PORT.*20001/);

    expect(state.listSessions()).toHaveLength(1);
    checkInvariants(state);
  });

  it("T4: released ports can be reused without conflict", () => {
    addSession(state, "s1", 20000);
    state.releaseSession("s1");

    // Reuse same ports for new session — should succeed
    state.allocateSession({
      sessionId: "s2",
      worktreePath: "/wt/s2",
      projectPath: "/project",
      ports: makePorts(20000),
      ownerClientId: "c1",
      ownerPid: 1000,
    });

    expect(state.listSessions()).toHaveLength(1);
    expect(state.getSession("s2")!.ports).toEqual(makePorts(20000));
    checkInvariants(state);
  });

  it("T5: 100 random allocate/release with conflict checks", () => {
    const sessionIds: string[] = [];
    const usedPortBases = new Set<number>();

    for (let i = 0; i < 100; i++) {
      if (sessionIds.length > 0 && Math.random() < 0.4) {
        // Release a random session
        const idx = Math.floor(Math.random() * sessionIds.length);
        const sid = sessionIds[idx];
        const session = state.getSession(sid)!;
        const base = session.ports.FRONTEND_PORT;
        usedPortBases.delete(base);
        state.releaseSession(sid);
        sessionIds.splice(idx, 1);
      } else {
        // Allocate with unique ports
        const sid = `s${i}`;
        const base = 20000 + i * 10;
        usedPortBases.add(base);
        addSession(state, sid, base);
        sessionIds.push(sid);
      }
      checkInvariants(state);
    }

    expect(state.listSessions().length).toBe(sessionIds.length);
  });

  it("T5b: stress — attempt duplicate ports always rejected", () => {
    addSession(state, "s1", 20000);

    for (let i = 0; i < 20; i++) {
      expect(() => {
        state.allocateSession({
          sessionId: `dup${i}`,
          worktreePath: `/wt/dup${i}`,
          projectPath: "/project",
          ports: makePorts(20000), // always conflicts with s1
          ownerClientId: "c1",
          ownerPid: 1000,
        });
      }).toThrow(/Port conflict/);
    }

    // Only s1 survived
    expect(state.listSessions()).toHaveLength(1);
    checkInvariants(state);
  });
});

// ============================================================
// Layer 1: sync/declare port conflict detection + self-healing
// ============================================================

describe("Layer 1: sync/declare detects and heals port conflicts", () => {
  let dir: string;
  let daemon: AgentDockDaemon;
  let client: DaemonClient;

  beforeEach(async () => {
    dir = tmpDir();
    daemon = new AgentDockDaemon({ port: 0, baseDir: dir });
    await daemon.start();
    client = new DaemonClient(daemon.getPort());
  });

  afterEach(async () => {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("T6: no conflict — DB ports trusted directly", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    const result = await client.declareSessions("c1", [
      { sessionId: "s1", worktreePath: "/wt/s1", projectPath: "/project", ports: makePorts(20010) },
      { sessionId: "s2", worktreePath: "/wt/s2", projectPath: "/project", ports: makePorts(20020) },
    ]);

    expect(result.results[0].status).toBe("allocated");
    expect(result.results[0].ports.FRONTEND_PORT).toBe(20010);
    expect(result.results[1].status).toBe("allocated");
    expect(result.results[1].ports.FRONTEND_PORT).toBe(20020);

    const inv = await get(daemon.getPort(), "/debug/invariants");
    expect(inv.data.valid).toBe(true);
  });

  it("T6b: DB ports occupied by external listener → reallocates full set", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    const occupied = await listenOnPort(20030);
    try {
      const result = await client.declareSessions("c1", [
        { sessionId: "s1", worktreePath: "/wt/s1", projectPath: "/project", ports: makePorts(20030) },
      ]);

      expect(result.results[0].status).toBe("allocated");
      expect(result.results[0].ports.FRONTEND_PORT).not.toBe(20030);
      expect(Object.values(result.results[0].ports)).not.toContain(20030);
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((err) => err ? reject(err) : resolve()));
    }
  });

  it("T7: DB port conflicts with already-allocated → reallocates", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    // First session gets ports 20000-20004 via allocate
    await client.allocateSession({
      clientId: "c1", sessionId: "s1", projectPath: "/project", worktreePath: "/wt/s1",
    });

    // Declare second session with SAME ports (simulates dirty DB)
    const result = await client.declareSessions("c1", [
      { sessionId: "s2", worktreePath: "/wt/s2", projectPath: "/project", ports: makePorts(20000) },
    ]);

    expect(result.results[0].status).toBe("allocated");
    // Ports must differ from s1's ports
    expect(result.results[0].ports.FRONTEND_PORT).not.toBe(20000);

    const inv = await get(daemon.getPort(), "/debug/invariants");
    expect(inv.data.valid).toBe(true);

    const portsRes = await get(daemon.getPort(), "/debug/ports");
    expect(portsRes.data.totalAllocated).toBe(10); // 2 sessions × 5
  });

  it("T8: all DB ports identical — each session gets unique ports", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    const dirtyPorts = makePorts(20050); // all three sessions claim same ports
    const result = await client.declareSessions("c1", [
      { sessionId: "s1", worktreePath: "/wt/s1", projectPath: "/project", ports: dirtyPorts },
      { sessionId: "s2", worktreePath: "/wt/s2", projectPath: "/project", ports: dirtyPorts },
      { sessionId: "s3", worktreePath: "/wt/s3", projectPath: "/project", ports: dirtyPorts },
    ]);

    // All should be allocated
    expect(result.results).toHaveLength(3);
    for (const r of result.results) {
      expect(r.status).toBe("allocated");
    }

    // All ports must be unique
    const allPorts: number[] = [];
    for (const r of result.results) {
      for (const key of PORT_KEYS) {
        allPorts.push(r.ports[key]);
      }
    }
    expect(new Set(allPorts).size).toBe(15); // 3 sessions × 5 unique ports

    // Debug verification
    const inv = await get(daemon.getPort(), "/debug/invariants");
    expect(inv.data.valid).toBe(true);
    expect(inv.data.checks.find((c: any) => c.name === "no_duplicate_ports").passed).toBe(true);
    expect(inv.data.checks.find((c: any) => c.name === "port_count_matches").passed).toBe(true);

    const portsRes = await get(daemon.getPort(), "/debug/ports");
    expect(portsRes.data.totalAllocated).toBe(15);
  });

  it("T9: simulate real scenario — daemon restart with dirty DB self-heals", async () => {
    const daemonPort = daemon.getPort();
    await client.registerClient("c1", 100, ["/project"]);

    // Step 1: Allocate session A with real ports
    const portsA = await client.allocateSession({
      clientId: "c1", sessionId: "A", projectPath: "/project", worktreePath: "/wt/A",
    });
    expect(portsA.FRONTEND_PORT).toBeGreaterThanOrEqual(20000);

    // Step 2: Simulate dirty DB — declare B and C with A's ports
    const result = await client.declareSessions("c1", [
      { sessionId: "B", worktreePath: "/wt/B", projectPath: "/project", ports: portsA },
      { sessionId: "C", worktreePath: "/wt/C", projectPath: "/project", ports: portsA },
    ]);

    // B and C should get NEW ports (not A's)
    expect(result.results[0].status).toBe("allocated");
    expect(result.results[0].ports.FRONTEND_PORT).not.toBe(portsA.FRONTEND_PORT);
    expect(result.results[1].status).toBe("allocated");
    expect(result.results[1].ports.FRONTEND_PORT).not.toBe(portsA.FRONTEND_PORT);

    // B and C should also differ from each other
    expect(result.results[0].ports.FRONTEND_PORT).not.toBe(result.results[1].ports.FRONTEND_PORT);

    // Debug: full invariant check
    const inv = await get(daemonPort, "/debug/invariants");
    expect(inv.data.valid).toBe(true);

    // Debug: port uniqueness
    const portsRes = await get(daemonPort, "/debug/ports");
    expect(portsRes.data.totalAllocated).toBe(15); // 3 × 5
    const sessionIds = Object.keys(portsRes.data.bySession);
    expect(sessionIds).toHaveLength(3);

    // Debug: full state dump
    const stateRes = await get(daemonPort, "/debug/state");
    expect(stateRes.data.stats.sessionCount).toBe(3);
    expect(stateRes.data.stats.allocatedPortCount).toBe(15);
  });

  it("T10: /debug/invariants passes after conflict resolution", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    // Create a scenario with potential conflicts
    await client.allocateSession({
      clientId: "c1", sessionId: "s1", projectPath: "/project", worktreePath: "/wt/s1",
    });

    // Declare 5 more sessions all with s1's ports (worst case)
    const s1Ports = (await client.listSessions()).find((s) => s.sessionId === "s1")!.ports;
    const sessions = Array.from({ length: 5 }, (_, i) => ({
      sessionId: `conflict${i}`,
      worktreePath: `/wt/conflict${i}`,
      projectPath: "/project",
      ports: s1Ports,
    }));

    await client.declareSessions("c1", sessions);

    const res = await get(daemon.getPort(), "/debug/invariants");
    expect(res.data.valid).toBe(true);
    expect(res.data.checks).toHaveLength(5);
    for (const check of res.data.checks) {
      expect(check.passed).toBe(true);
    }
  });

  it("T11: /debug/ports shows all unique after conflict resolution", async () => {
    await client.registerClient("c1", 100, ["/project"]);

    const sharedPorts = makePorts(30000);
    await client.declareSessions("c1", [
      { sessionId: "a", worktreePath: "/wt/a", projectPath: "/project", ports: sharedPorts },
      { sessionId: "b", worktreePath: "/wt/b", projectPath: "/project", ports: sharedPorts },
      { sessionId: "c", worktreePath: "/wt/c", projectPath: "/project", ports: sharedPorts },
    ]);

    const res = await get(daemon.getPort(), "/debug/ports");
    expect(res.data.totalAllocated).toBe(15);

    // Collect all port numbers from debug output
    const allPorts: number[] = [];
    for (const session of Object.values(res.data.bySession) as any[]) {
      allPorts.push(...session.ports);
    }
    expect(new Set(allPorts).size).toBe(15); // all unique
  });
});
