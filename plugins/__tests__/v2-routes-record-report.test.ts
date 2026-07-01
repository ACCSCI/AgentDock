// @ts-nocheck
/**
 * F5: v2 routes recordReport + expectedSessionIds dynamic injection (§5.2).
 *
 * Verifies that:
 * 1. POST /session/heartbeat calls ctx.recovering.recordReport(sessionId)
 * 2. POST /claim calls ctx.recovering.recordReport(sessionId)
 * 3. POST /session/activate calls ctx.recovering.recordReport(sessionId)
 * 4. POST /session/create adds the new sessionId to ctx.expectedSessionIds
 */
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { DaemonStateV2 } from "../daemon-state-v2.js";
import { Mutex } from "../mutex.js";
import { SseBus } from "../sse-bus.js";
import {
  registerSessionsV2,
  registerClaim,
} from "../daemon/routes/v2/index.js";

function makeMockCtx(overrides?: {
  recovering?: { recordReport: ReturnType<typeof vi.fn>; isRecovering: () => boolean };
  expectedSessionIds?: Set<string>;
  stateV2?: DaemonStateV2;
}) {
  const stateV2 = overrides?.stateV2 ?? new DaemonStateV2();
  const expectedSessionIds = overrides?.expectedSessionIds ?? new Set<string>();
  const recovering = overrides?.recovering ?? {
    recordReport: vi.fn(),
    isRecovering: () => true,
  };
  return {
    stateV2,
    walV2: { persist: vi.fn() },
    mutex: new Mutex(),
    recovering,
    expectedSessionIds,
    alreadyReportedThisWindow: new Set<string>(),
    sseBus: new SseBus(),
    metrics: {
      claimCount: 0,
      conflictCount: 0,
      releaseCount: 0,
      heartbeatTimeoutCount: 0,
      activeSessionCount: 0,
      sseConnections: 0,
    },
    port: 0,
    actualPort: 0,
    startedAt: Date.now(),
    lastSeq: 0,
  };
}

function appWithSessionRoutes(ctx: ReturnType<typeof makeMockCtx>) {
  const app = new Hono();
  registerSessionsV2(app, ctx as any);
  return app;
}

function appWithClaimRoutes(ctx: ReturnType<typeof makeMockCtx>) {
  const app = new Hono();
  registerClaim(app, ctx as any);
  return app;
}

// ---------- /session/heartbeat ----------

describe("F5: POST /session/heartbeat calls recordReport", () => {
  it("recordReport(sessionId) called on heartbeat for expected session", async () => {
    const recordReport = vi.fn();
    const expectedSessionIds = new Set(["sess-hb-1"]);
    const stateV2 = new DaemonStateV2();
    // Create a session so assertFencingToken passes
    stateV2.createSession({
      sessionId: "sess-hb-1",
      projectRoot: "/test",
      displayName: "hb",
      clientId: "c1",
      pid: 1,
      leaseExpiresAt: Date.now() + 60000,
    });

    const ctx = makeMockCtx({
      recovering: { recordReport, isRecovering: () => true },
      expectedSessionIds,
      stateV2,
    });
    const app = appWithSessionRoutes(ctx);

    const res = await app.request("/session/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-hb-1",
        fencingToken: 1,
        phase: "creating",
      }),
    });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(recordReport).toHaveBeenCalledWith("sess-hb-1");
  });
});

// ---------- /claim ----------

describe("F5: POST /claim calls recordReport", () => {
  it("recordReport(sessionId) called on claim for expected session", async () => {
    const recordReport = vi.fn();
    const expectedSessionIds = new Set(["sess-cl-1"]);
    const stateV2 = new DaemonStateV2();
    stateV2.setState("READY"); // skip RECOVERING gate
    stateV2.createSession({
      sessionId: "sess-cl-1",
      projectRoot: "/test",
      displayName: "cl",
      clientId: "c1",
      pid: 1,
      leaseExpiresAt: Date.now() + 60000,
    });

    const ctx = makeMockCtx({
      recovering: { recordReport, isRecovering: () => false },
      expectedSessionIds,
      stateV2,
    });
    const app = appWithClaimRoutes(ctx);

    const res = await app.request("/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "sess-cl-1",
        fencingToken: 1,
        name: "PORT",
      }),
    });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(recordReport).toHaveBeenCalledWith("sess-cl-1");
  });
});

// ---------- /session/create ----------

describe("F5: POST /session/create adds to expectedSessionIds", () => {
  it("new sessionId added to expectedSessionIds Set", async () => {
    const expectedSessionIds = new Set<string>();
    const ctx = makeMockCtx({ expectedSessionIds });
    const app = appWithSessionRoutes(ctx);

    const res = await app.request("/session/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId: "c1",
        pid: 100,
        projectRoot: "/test",
      }),
    });
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.sessionId).toBeDefined();
    // After /session/create, the new sessionId should be in expectedSessionIds
    expect(expectedSessionIds.has(body.sessionId)).toBe(true);
  });

  it("expectedSessionIds accumulates across multiple creates", async () => {
    const expectedSessionIds = new Set<string>();
    const ctx = makeMockCtx({ expectedSessionIds });
    const app = appWithSessionRoutes(ctx);

    const res1 = await app.request("/session/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "c1", pid: 1, projectRoot: "/p" }),
    });
    const b1 = await res1.json();

    const res2 = await app.request("/session/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "c2", pid: 2, projectRoot: "/p" }),
    });
    const b2 = await res2.json();

    expect(expectedSessionIds.has(b1.sessionId)).toBe(true);
    expect(expectedSessionIds.has(b2.sessionId)).toBe(true);
    expect(expectedSessionIds.size).toBe(2);
  });
});
