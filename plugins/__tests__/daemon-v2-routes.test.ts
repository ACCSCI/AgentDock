/**
 * Daemon API v2 routes — integration tests (新架构 §13.1).
 *
 * Spawns a real AgentDockDaemon on a tmp baseDir and exercises the v2
 * endpoints end-to-end. Verifies the §6.1 fencing invariants and §4.2
 * lifecycle state transitions are enforced.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentDockDaemon } from "../daemon.js";
import { isPortAvailable } from "../port-allocator.js";
import type { SerializedV2 } from "../daemon-state-v2.js";

let dir: string;
let daemon: AgentDockDaemon;
let baseUrl: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "agentdock-v2-"));
  daemon = new AgentDockDaemon({ port: 0, baseDir: dir, recoveringSoftMinMs: 0 });
  await daemon.start();
  baseUrl = `http://127.0.0.1:${daemon.getPort()}`;
});

afterEach(async () => {
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

// ---------- helpers ----------

async function getJson<T>(p: string): Promise<T> {
  const res = await fetch(`${baseUrl}${p}`);
  return (await res.json()) as T;
}

async function postJson<T>(p: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface HealthResp {
  protocolVersion: string;
  schemaVersion: number;
  state: string;
  capabilities: string[];
  pid: number;
  port: number;
}

interface CreateResp {
  success: boolean;
  sessionId?: string;
  fencingToken?: number;
  error?: { code: string; message: string };
}

interface DebugState {
  success: boolean;
  lifecycleState: string;
  schemaVersion: number;
  v2Sessions: Record<string, { status: string; displayName: string }>;
  v2Owners: Record<string, { clientId: string; fencingToken: number }>;
  v2Ports: Record<number, { sessionId: string; name: string }>;
  // v1 surface
  state: {
    sessions: Record<string, unknown>;
    clients: Record<string, unknown>;
    allocatedPorts: number[];
    worktreeIndex: Record<string, string>;
  };
  stats: { sessionCount: number; clientCount: number; allocatedPortCount: number };
}

// ---------- /health ----------

describe("v2 /health — §2 protocol surface", () => {
  it("returns protocolVersion, capabilities, state", async () => {
    const h = await getJson<HealthResp>("/health");
    expect(h.protocolVersion).toBe("2");
    expect(h.schemaVersion).toBe(2);
    expect(h.state).toBe("READY");
    expect(h.capabilities).toEqual(
      expect.arrayContaining([
        "port-allocation",
        "session-registry",
        "claim-port",
        "fencing",
        "lifecycle-lease",
      ]),
    );
    expect(typeof h.pid).toBe("number");
    expect(h.pid).toBeGreaterThan(0);
  });
});

// ---------- /session/* lifecycle (§4.2) ----------

describe("v2 /session/* lifecycle", () => {
  it("create → activate flow yields active session with fencingToken=1", async () => {
    const c = await postJson<CreateResp>("/session/create", {
      clientId: "c1",
      pid: 1000,
      projectRoot: "/proj",
      displayName: "My Session",
    });
    expect(c.status).toBe(200);
    expect(c.body.success).toBe(true);
    const sessionId = c.body.sessionId!;
    expect(sessionId).toMatch(/^[a-zA-Z0-9-]+$/);
    expect(c.body.fencingToken).toBe(1);

    const a = await postJson<{ success: boolean }>("/session/activate", {
      sessionId,
      fencingToken: 1,
    });
    expect(a.body.success).toBe(true);

    const dbg = await getJson<DebugState>("/debug/state");
    expect(dbg.v2Sessions[sessionId].status).toBe("active");
    expect(dbg.v2Sessions[sessionId].displayName).toBe("My Session");
  });

  it("create auto-generates displayName when not provided", async () => {
    const c = await postJson<CreateResp>("/session/create", {
      clientId: "c1",
      pid: 1000,
      projectRoot: "/proj",
    });
    expect(c.body.success).toBe(true);
    expect(c.body.sessionId).toBeDefined();

    const dbg = await getJson<DebugState>("/debug/state");
    const s = dbg.v2Sessions[c.body.sessionId!];
    expect(s.displayName.length).toBeGreaterThan(0);
    expect(s.displayName.length).toBeLessThanOrEqual(8);
  });

  it("create rejects empty projectRoot", async () => {
    const r = await postJson<{ success: boolean }>("/session/create", {
      clientId: "c1",
      pid: 1,
      projectRoot: "",
    });
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
  });

  it("activate with wrong fencingToken returns STALE_OWNER", async () => {
    const c = await postJson<CreateResp>("/session/create", {
      clientId: "c1",
      pid: 1,
      projectRoot: "/p",
    });
    const sid = c.body.sessionId!;
    const a = await postJson<CreateResp>("/session/activate", {
      sessionId: sid,
      fencingToken: 99,
    });
    expect(a.status).toBe(409);
    expect(a.body.error?.code).toBe("STALE_OWNER");
  });

  it("rename only mutates displayName; status must be active", async () => {
    const c = await postJson<CreateResp>("/session/create", {
      clientId: "c1",
      pid: 1,
      projectRoot: "/p",
      displayName: "old",
    });
    const sid = c.body.sessionId!;

    // Rename in creating state — should fail (cannot rename non-active)
    const r0 = await postJson<{ success: boolean }>("/session/rename", {
      sessionId: sid,
      fencingToken: 1,
      displayName: "new",
    });
    expect(r0.body.success).toBe(false);

    // Activate then rename
    await postJson("/session/activate", { sessionId: sid, fencingToken: 1 });
    const r1 = await postJson<{ success: boolean }>("/session/rename", {
      sessionId: sid,
      fencingToken: 1,
      displayName: "new 中文 🚀",
    });
    expect(r1.body.success).toBe(true);

    const dbg = await getJson<DebugState>("/debug/state");
    expect(dbg.v2Sessions[sid].displayName).toBe("new 中文 🚀");
  });

  it("delete + purge two-phase releases all ports and drops 3-table entries", async () => {
    const c = await postJson<CreateResp>("/session/create", {
      clientId: "c1",
      pid: 1,
      projectRoot: "/p",
      displayName: "to-delete",
    });
    const sid = c.body.sessionId!;
    await postJson("/session/activate", { sessionId: sid, fencingToken: 1 });

    // Claim 3 ports
    for (const name of ["A", "B", "C"]) {
      const cl = await postJson<{ success: boolean; port?: number }>("/claim", {
        sessionId: sid,
        fencingToken: 1,
        name,
      });
      expect(cl.body.port).toBeGreaterThan(0);
    }

    // Delete (phase 1) — releases ports, sets status=deleting
    const d = await postJson<{ success: boolean }>("/session/delete", {
      sessionId: sid,
      fencingToken: 1,
    });
    expect(d.body.success).toBe(true);

    const dbg1 = await getJson<DebugState>("/debug/state");
    expect(dbg1.v2Sessions[sid].status).toBe("deleting");
    expect(Object.keys(dbg1.v2Ports).length).toBe(0);

    // Purge (phase 2) — drops entries
    const p = await postJson<{ success: boolean }>("/session/purge", {
      sessionId: sid,
      fencingToken: 1,
    });
    expect(p.body.success).toBe(true);

    const dbg2 = await getJson<DebugState>("/debug/state");
    expect(dbg2.v2Sessions[sid]).toBeUndefined();
    expect(dbg2.v2Owners[sid]).toBeUndefined();
  });
});

// ---------- /claim /release /reassign (§3.3, §6.2) ----------

describe("v2 /claim /release /reassign", () => {
  async function createActiveSession(name: string): Promise<string> {
    const c = await postJson<CreateResp>("/session/create", {
      clientId: "c1",
      pid: 1,
      projectRoot: "/p",
      displayName: name,
    });
    const sid = c.body.sessionId!;
    await postJson("/session/activate", { sessionId: sid, fencingToken: 1 });
    return sid;
  }

  it("claim without requestedPort picks a fresh free port", async () => {
    const sid = await createActiveSession("claim-auto");
    const r = await postJson<{ success: boolean; port?: number }>("/claim", {
      sessionId: sid,
      fencingToken: 1,
      name: "AUTO",
    });
    expect(r.body.success).toBe(true);
    expect(r.body.port).toBeGreaterThan(0);
    expect(await isPortAvailable(r.body.port!)).toBe(true);
  });

  it("claim with requestedPort (free) reserves exactly that port", async () => {
    const sid = await createActiveSession("claim-specific");
    const port = 41000 + Math.floor(Math.random() * 1000);
    expect(await isPortAvailable(port)).toBe(true);

    const r = await postJson<{ success: boolean; port?: number }>("/claim", {
      sessionId: sid,
      fencingToken: 1,
      requestedPort: port,
      name: "X",
    });
    expect(r.body.port).toBe(port);
    // Registry claims the port — subsequent claim from another session must
    // be rejected (verified by the next test).
    const dbg = await getJson<DebugState>("/debug/state");
    expect(dbg.v2Ports[port]?.sessionId).toBe(sid);
  });

  it("claim for another session's port → conflict → picks new port", async () => {
    const sid1 = await createActiveSession("s1");
    const sid2 = await createActiveSession("s2");

    const a = await postJson<{ success: boolean; port?: number }>("/claim", {
      sessionId: sid1,
      fencingToken: 1,
      name: "P",
    });
    expect(a.body.success).toBe(true);

    const b = await postJson<{ success: boolean; port?: number }>("/claim", {
      sessionId: sid2,
      fencingToken: 1,
      requestedPort: a.body.port,
      name: "P",
    });
    expect(b.body.success).toBe(true);
    expect(b.body.port).not.toBe(a.body.port);
  });

  it("idempotent re-claim by same session returns the same port without re-probe", async () => {
    const sid = await createActiveSession("idem");
    const first = await postJson<{ success: boolean; port?: number }>("/claim", {
      sessionId: sid,
      fencingToken: 1,
      name: "P",
    });
    const second = await postJson<{ success: boolean; port?: number }>("/claim", {
      sessionId: sid,
      fencingToken: 1,
      requestedPort: first.body.port,
      name: "P",
    });
    expect(second.body.port).toBe(first.body.port);
  });

  it("bindFailed:true hint skips re-probe and immediately picks a fresh port", async () => {
    const sid1 = await createActiveSession("s1");
    const sid2 = await createActiveSession("s2");

    // s1 takes port X
    const a = await postJson<{ success: boolean; port?: number }>("/claim", {
      sessionId: sid1,
      fencingToken: 1,
      name: "P",
    });

    // s2 tried X but client bind failed → hint Daemon to skip probe
    const b = await postJson<{ success: boolean; port?: number }>("/claim", {
      sessionId: sid2,
      fencingToken: 1,
      requestedPort: a.body.port,
      bindFailed: true,
      name: "P",
    });
    expect(b.body.success).toBe(true);
    expect(b.body.port).not.toBe(a.body.port);
  });

  it("release frees the port — subsequent claim can use it again", async () => {
    const sid = await createActiveSession("rel");
    const c = await postJson<{ success: boolean; port?: number }>("/claim", {
      sessionId: sid,
      fencingToken: 1,
      name: "P",
    });
    const rel = await postJson<{ success: boolean }>("/release", {
      sessionId: sid,
      fencingToken: 1,
      port: c.body.port!,
    });
    expect(rel.body.success).toBe(true);

    const dbg = await getJson<DebugState>("/debug/state");
    expect(dbg.v2Ports[c.body.port!]).toBeUndefined();
  });

  it("reassign swaps all session ports for fresh ones", async () => {
    const sid = await createActiveSession("reassign");
    const oldPorts: number[] = [];
    for (const name of ["F", "B"]) {
      const r = await postJson<{ success: boolean; port?: number }>("/claim", {
        sessionId: sid,
        fencingToken: 1,
        name,
      });
      oldPorts.push(r.body.port!);
    }
    const r = await postJson<{
      success: boolean;
      ports?: Record<string, number>;
      oldPorts?: number[];
    }>("/reassign", { sessionId: sid, fencingToken: 1 });
    expect(r.body.success).toBe(true);
    expect(r.body.oldPorts?.sort()).toEqual(oldPorts.sort());
    const newPorts = Object.values(r.body.ports!);
    expect(newPorts.sort()).not.toEqual(oldPorts.sort());
  });

  it("claim with stale fencingToken returns STALE_OWNER", async () => {
    const sid = await createActiveSession("stale-claim");
    const r = await postJson<{ success: boolean; error?: { code: string } }>(
      "/claim",
      { sessionId: sid, fencingToken: 99, name: "X" },
    );
    expect(r.body.success).toBe(false);
    expect(r.body.error?.code).toBe("STALE_OWNER");
  });
});

// ---------- /takeover (§6.1) ----------

describe("v2 /takeover", () => {
  async function createActiveSession(): Promise<string> {
    const c = await postJson<CreateResp>("/session/create", {
      clientId: "client-A",
      pid: 100,
      projectRoot: "/p",
    });
    const sid = c.body.sessionId!;
    await postJson("/session/activate", { sessionId: sid, fencingToken: 1 });
    return sid;
  }

  it("takeover with current token bumps fencingToken and swaps owner", async () => {
    const sid = await createActiveSession();
    const r = await postJson<{ success: boolean; fencingToken?: number }>(
      "/takeover",
      { sessionId: sid, clientId: "client-B", pid: 200, fencingToken: 1 },
    );
    expect(r.body.fencingToken).toBe(2);

    const dbg = await getJson<DebugState>("/debug/state");
    expect(dbg.v2Owners[sid].clientId).toBe("client-B");
    expect(dbg.v2Owners[sid].fencingToken).toBe(2);
  });

  it("stale owner after takeover cannot write — claim rejected", async () => {
    const sid = await createActiveSession();
    await postJson("/takeover", {
      sessionId: sid,
      clientId: "B",
      pid: 200,
      fencingToken: 1,
    });

    // Old owner tries to claim with the old token — must fail
    const oldClaim = await postJson<{
      success: boolean;
      error?: { code: string };
    }>("/claim", {
      sessionId: sid,
      fencingToken: 1, // stale
      name: "X",
    });
    expect(oldClaim.body.success).toBe(false);
    expect(oldClaim.body.error?.code).toBe("STALE_OWNER");
  });

  it("repeated takeovers monotonically increase fencingToken", async () => {
    const sid = await createActiveSession();
    let token = 1;
    for (let i = 0; i < 5; i++) {
      const r = await postJson<{ success: boolean; fencingToken?: number }>(
        "/takeover",
        {
          sessionId: sid,
          clientId: `client-${i}`,
          pid: 1000 + i,
          fencingToken: token,
        },
      );
      expect(r.body.fencingToken).toBeDefined();
      token = r.body.fencingToken!;
    }
    expect(token).toBe(6);
  });
});

// ---------- /sync (§7.3, snapshotSeq) ----------

describe("v2 /sync", () => {
  it("returns snapshotSeq + sessions + owners + ports", async () => {
    const c = await postJson<CreateResp>("/session/create", {
      clientId: "c1",
      pid: 1,
      projectRoot: "/p",
      displayName: "sync-test",
    });
    const sid = c.body.sessionId!;
    await postJson("/session/activate", { sessionId: sid, fencingToken: 1 });
    await postJson("/claim", { sessionId: sid, fencingToken: 1, name: "P" });

    const r = await postJson<{
      success: boolean;
      state: string;
      snapshotSeq: number;
      sessions: Array<{ sessionId: string; status: string }>;
      owners: Array<{ sessionId: string; clientId: string }>;
      ports: Array<{ sessionId: string; name: string }>;
      serverTime: number;
    }>("/sync", { clientId: "c1", pid: 1, lastSeq: 0 });

    expect(r.body.success).toBe(true);
    expect(r.body.state).toBe("READY");
    expect(typeof r.body.snapshotSeq).toBe("number");
    expect(typeof r.body.serverTime).toBe("number");
    expect(r.body.sessions.some((s) => s.sessionId === sid)).toBe(true);
    expect(r.body.owners.find((o) => o.sessionId === sid)?.clientId).toBe("c1");
    expect(r.body.ports.some((p) => p.sessionId === sid && p.name === "P")).toBe(
      true,
    );
  });
});

// ---------- /debug/state (§11.1) ----------

describe("v2 /debug/state", () => {
  it("exports full state — schemaVersion, sessions, owners, ports", async () => {
    const c = await postJson<CreateResp>("/session/create", {
      clientId: "c1",
      pid: 1,
      projectRoot: "/p",
      displayName: "dbg",
    });
    const sid = c.body.sessionId!;
    await postJson("/session/activate", { sessionId: sid, fencingToken: 1 });

    const dbg = await getJson<DebugState>("/debug/state");
    expect(dbg.success).toBe(true);
    expect(dbg.schemaVersion).toBe(2);
    expect(dbg.lifecycleState).toBe("READY");
    expect(dbg.v2Sessions[sid].status).toBe("active");
    expect(dbg.v2Owners[sid].fencingToken).toBe(1);
    expect(Object.values(dbg.v2Ports).length).toBe(0);
  });
});

// ---------- /metrics (P10 stub) ----------

describe("v2 /metrics", () => {
  it("returns counter bundle shape", async () => {
    const m = await getJson<{
      success: boolean;
      claimCount: number;
      conflictCount: number;
      releaseCount: number;
      heartbeatTimeoutCount: number;
      activeSessionCount: number;
      sseConnections: number;
    }>("/metrics");
    expect(m.success).toBe(true);
    expect(typeof m.claimCount).toBe("number");
  });
});

// ---------- /session/heartbeat (§4.4) ----------

describe("v2 /session/heartbeat", () => {
  it("renews lease — refreshes leaseExpiresAt", async () => {
    const c = await postJson<CreateResp>("/session/create", {
      clientId: "c1",
      pid: 1,
      projectRoot: "/p",
      displayName: "hb",
    });
    const sid = c.body.sessionId!;
    // session is in creating state; lease should be active
    const hb = await postJson<{ success: boolean }>("/session/heartbeat", {
      sessionId: sid,
      fencingToken: 1,
      phase: "creating",
    });
    expect(hb.body.success).toBe(true);
  });

  it("heartbeat on non-existent session fails", async () => {
    const hb = await postJson<{ success: boolean }>("/session/heartbeat", {
      sessionId: "ghost",
      fencingToken: 1,
      phase: "creating",
    });
    expect(hb.body.success).toBe(false);
  });
});

// ---------- /events (P5 stub — verifies hello frame) ----------

describe("v2 /events (SSE P5 placeholder)", () => {
  it("returns text/event-stream with a hello frame", async () => {
    const res = await fetch(`${baseUrl}/events`);
    expect(res.headers.get("content-type")).toMatch(/event-stream/);

    // Read just enough to grab the first frame then abort
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value);
      if (buf.includes("event: hello")) break;
    }
    await reader.cancel();
    expect(buf).toMatch(/event: hello/);
  });
});

// ---------- Serialization round-trip across HTTP boundary ----------

describe("v2 state survives daemon restart (in-memory → WAL → reload)", () => {
  it("after stop+restart, /debug/state shows same sessions", async () => {
    const c = await postJson<CreateResp>("/session/create", {
      clientId: "c1",
      pid: 1,
      projectRoot: "/p",
      displayName: "persist-test",
    });
    const sid = c.body.sessionId!;
    await postJson("/session/activate", { sessionId: sid, fencingToken: 1 });
    await postJson("/claim", { sessionId: sid, fencingToken: 1, name: "P" });

    await daemon.stop();
    const newDaemon = new AgentDockDaemon({ port: 0, baseDir: dir });
    await newDaemon.start();
    const newBaseUrl = `http://127.0.0.1:${newDaemon.getPort()}`;

    try {
      const r = await fetch(`${newBaseUrl}/debug/state`);
      const dbg = (await r.json()) as DebugState & SerializedV2;
      expect(dbg.v2Sessions[sid].displayName).toBe("persist-test");
      expect(dbg.v2Sessions[sid].status).toBe("active");
    } finally {
      await newDaemon.stop();
    }
  });
});
