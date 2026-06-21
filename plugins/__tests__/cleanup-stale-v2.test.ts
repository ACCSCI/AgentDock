/**
 * F4: v2 owner/session zombie cleanup.
 *
 * When a v2 client crashes, its v1 heartbeat stops. The existing
 * cleanupStaleClients removes the v1 client entry but leaves v2 owners
 * orphaned forever. This test verifies the fix: v2 owners whose v1
 * client is gone get cleaned up (owner removed, ports freed).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { DaemonState } from "../daemon-state.js";
import { DaemonStateV2 } from "../daemon-state-v2.js";
import { Mutex } from "../mutex.js";
import { cleanupStaleClients, resetSuspendDetector } from "../daemon/context.js";
import { HEARTBEAT_TIMEOUT_MS } from "../constants.js";
import type { DaemonContext } from "../daemon/context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides?: Partial<DaemonContext>): DaemonContext {
  return {
    baseDir: "/tmp/test-daemon",
    registryPath: "/tmp/test-daemon/registry.json",
    registry: new Map(),
    state: new DaemonState(),
    wal: { persist: vi.fn() } as any,
    stateV2: new DaemonStateV2(),
    walV2: { persist: vi.fn() } as any,
    sseBus: { emit: vi.fn() } as any,
    faults: { inject: null } as any,
    allocator: {} as any,
    mutex: new Mutex(),
    lastPersistedHeartbeatAt: new Map(),
    port: 0,
    actualPort: 3001,
    startedAt: Date.now(),
    lastSeq: 0,
    metrics: { sessions: 0, clients: 0, ports: 0, sseConnections: 0 },
    loadRegistry: vi.fn(),
    saveRegistry: vi.fn(),
    isProcessAlive: vi.fn(() => false),
    ...overrides,
  } as DaemonContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("F4: v2 owner zombie cleanup", () => {
  let ctx: DaemonContext;

  beforeEach(() => {
    resetSuspendDetector();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    resetSuspendDetector();
  });

  it("removes v1 client AND v2 owner + frees v2 ports when v1 heartbeat expires", async () => {
    ctx = makeCtx();
    const now = Date.now();

    // --- Arrange: register v1 client "c1" with a stale heartbeat ---
    ctx.state.registerClient("c1", 100, ["/project/a"]);
    // Manually set lastHeartbeat to the past so it's stale
    const client = ctx.state.getClient("c1");
    expect(client).not.toBeNull();
    client!.lastHeartbeat = now - HEARTBEAT_TIMEOUT_MS - 1000;

    // --- Arrange: v2 session "s1" owned by "c1" with reserved ports ---
    ctx.stateV2.createSession({
      sessionId: "s1",
      projectRoot: "/project/a",
      displayName: "test-session",
      clientId: "c1",
      pid: 100,
      leaseExpiresAt: now + 60_000,
    });
    ctx.stateV2.activateSession("s1");
    ctx.stateV2.claimPort("s1", 30000, "FRONTEND_PORT");
    ctx.stateV2.claimPort("s1", 30001, "BACKEND_PORT");

    // Verify pre-conditions
    expect(ctx.state.getClient("c1")).not.toBeNull();
    expect(ctx.stateV2.getOwner("s1")).not.toBeNull();
    expect(ctx.stateV2.getSessionPorts("s1")).toEqual([30000, 30001]);
    expect(ctx.stateV2.ports.size).toBe(2);

    // --- Act: run cleanup ---
    await cleanupStaleClients(ctx);

    // --- Assert: v1 client removed ---
    expect(ctx.state.getClient("c1")).toBeNull();

    // --- Assert: v2 owner released (zombie cleaned up) ---
    expect(ctx.stateV2.getOwner("s1")).toBeNull();

    // --- Assert: v2 ports freed ---
    expect(ctx.stateV2.ports.size).toBe(0);
    expect(ctx.stateV2.getSessionPorts("s1")).toEqual([]);
  });

  it("does NOT clean up v2 owner when v1 client is still alive", async () => {
    ctx = makeCtx();
    const now = Date.now();

    // --- Arrange: register v1 client "c1" with a fresh heartbeat ---
    ctx.state.registerClient("c1", 100, ["/project/a"]);
    // lastHeartbeat is set to now by registerClient, so it's fresh

    // --- Arrange: v2 session "s1" owned by "c1" ---
    ctx.stateV2.createSession({
      sessionId: "s1",
      projectRoot: "/project/a",
      displayName: "test-session",
      clientId: "c1",
      pid: 100,
      leaseExpiresAt: now + 60_000,
    });
    ctx.stateV2.activateSession("s1");
    ctx.stateV2.claimPort("s1", 30000, "FRONTEND_PORT");

    // --- Act ---
    await cleanupStaleClients(ctx);

    // --- Assert: v1 client still present ---
    expect(ctx.state.getClient("c1")).not.toBeNull();

    // --- Assert: v2 owner still present (not zombie) ---
    expect(ctx.stateV2.getOwner("s1")).not.toBeNull();
    expect(ctx.stateV2.ports.size).toBe(1);
  });

  it("cleans up multiple v2 owners when their v1 clients are all stale", async () => {
    ctx = makeCtx();
    const now = Date.now();

    // Client c1 — stale
    ctx.state.registerClient("c1", 100, ["/project/a"]);
    ctx.state.getClient("c1")!.lastHeartbeat = now - HEARTBEAT_TIMEOUT_MS - 1000;

    // Client c2 — fresh
    ctx.state.registerClient("c2", 200, ["/project/b"]);

    // v2 session s1 owned by c1 (stale)
    ctx.stateV2.createSession({
      sessionId: "s1",
      projectRoot: "/project/a",
      displayName: "session-1",
      clientId: "c1",
      pid: 100,
      leaseExpiresAt: now + 60_000,
    });
    ctx.stateV2.activateSession("s1");
    ctx.stateV2.claimPort("s1", 30000, "FRONTEND_PORT");

    // v2 session s2 owned by c2 (fresh)
    ctx.stateV2.createSession({
      sessionId: "s2",
      projectRoot: "/project/b",
      displayName: "session-2",
      clientId: "c2",
      pid: 200,
      leaseExpiresAt: now + 60_000,
    });
    ctx.stateV2.activateSession("s2");
    ctx.stateV2.claimPort("s2", 30001, "BACKEND_PORT");

    // --- Act ---
    await cleanupStaleClients(ctx);

    // --- Assert: c1 removed, s1 zombie cleaned ---
    expect(ctx.state.getClient("c1")).toBeNull();
    expect(ctx.stateV2.getOwner("s1")).toBeNull();
    expect(ctx.stateV2.ports.get(30000)).toBeUndefined();

    // --- Assert: c2 and s2 untouched ---
    expect(ctx.state.getClient("c2")).not.toBeNull();
    expect(ctx.stateV2.getOwner("s2")).not.toBeNull();
    expect(ctx.stateV2.ports.get(30001)).toBeDefined();
  });
});
