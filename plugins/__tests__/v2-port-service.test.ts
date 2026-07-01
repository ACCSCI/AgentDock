// @ts-nocheck
/**
 * v2PortService — unit tests (P9 — 新架构 §4.2 + §4.4).
 *
 * Mocks `fetch` to exercise the orchestration logic without spinning up
 * a real daemon. Covers:
 *   1. allocateSession happy path (create → claim × N → activate)
 *   2. claim with `picked: true` refreshes the token from /debug/state
 *   3. allocateSession failure rolls back via delete + purge
 *   4. releaseSession (phase 1) + completeDeletion (phase 2)
 *   5. lease-renewal timer sends heartbeat only for creating/deleting
 *   6. heartbeat 409 STALE_OWNER refreshes the token from /debug/state
 *   7. heartbeat 3 consecutive failures removes the entry
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createV2PortService } from "../v2-port-service.js";
import { PORT_KEYS_DEFAULT } from "../config.js";

interface FetchCall {
  url: string;
  init: RequestInit;
}

interface MockResponseInit {
  status?: number;
  body?: unknown;
}

function buildMockFetch(responses: Map<string, (req: FetchCall) => MockResponseInit | Promise<MockResponseInit>>) {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const req: FetchCall = { url, init: init ?? {} };
    calls.push(req);
    const handler = responses.get(url.replace(/^http:\/\/[^/]+/, ""));
    if (!handler) {
      return new Response(JSON.stringify({ error: { code: "MOCK_MISS" } }), { status: 500 });
    }
    const res = await handler(req);
    return new Response(JSON.stringify(res.body ?? {}), {
      status: res.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { fetchImpl, calls };
}

function urlPath(url: string): string {
  return url.replace(/^http:\/\/[^/]+/, "");
}

const BASE = "http://127.0.0.1:12345";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("v2PortService.allocateSession", () => {
  it("runs create → claim × N → activate and returns the port map", async () => {
    const sessionId = "v2-sid-1";
    const token = 1;
    const portMap = PORT_KEYS_DEFAULT.reduce(
      (acc, k, i) => ({ ...acc, [k]: 30000 + i }),
      {} as Record<string, number>,
    );
    const { fetchImpl, calls } = buildMockFetch(
      new Map([
        [
          "/session/create",
          () => ({ body: { success: true, sessionId, fencingToken: token } }),
        ],
        ...PORT_KEYS_DEFAULT.map((name, i) => [
          `/claim`,
          (req: FetchCall) => {
            const body = JSON.parse(String(req.init.body)) as { name: string };
            return {
              body: {
                success: true,
                port: portMap[body.name] ?? 30000 + i,
                picked: false,
              },
            };
          },
        ]),
        [
          "/session/activate",
          () => ({ body: { success: true } }),
        ],
      ]),
    );
    const svc = createV2PortService({
      baseUrl: BASE,
      clientId: "c1",
      pid: 99,
      getProjectRoot: () => "/proj",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const ports = await svc.service.allocateSession({
      sessionId: "app1",
      projectPath: "/proj",
      worktreePath: "/wt",
    });
    expect(ports).toEqual(portMap);
    expect(svc.getToken("app1")).toBe(1);
    expect(svc.getStatus("app1")).toBe("active");
    // Verify call order: create, claim×N, activate
    const paths = calls.map((c) => urlPath(c.url));
    expect(paths[0]).toBe("/session/create");
    expect(paths.slice(1, 1 + PORT_KEYS_DEFAULT.length).every((p) => p === "/claim")).toBe(true);
    expect(paths.at(-1)).toBe("/session/activate");
    svc.dispose();
  });

  it("refreshes the token from /debug/state when claim returns picked:true", async () => {
    const token = 1;
    const refreshed = 2;
    const { fetchImpl, calls } = buildMockFetch(
      new Map([
        ["/session/create", () => ({ body: { success: true, sessionId: "app2", fencingToken: token } })],
        [
          "/claim",
          (req: FetchCall) => {
            const body = JSON.parse(String(req.init.body)) as { name: string };
            return { body: { success: true, port: 30001, picked: body.name === "BACKEND_PORT" } };
          },
        ],
        ["/debug/state", () => ({ body: { v2Owners: { "app2": { fencingToken: refreshed } } } })],
        ["/session/activate", () => ({ body: { success: true } })],
      ]),
    );
    const svc = createV2PortService({
      baseUrl: BASE,
      clientId: "c1",
      pid: 99,
      getProjectRoot: () => "/proj",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await svc.service.allocateSession({
      sessionId: "app2",
      projectPath: "/proj",
      worktreePath: "/wt",
    });
    // Token was bumped to 2 after the picked:true claim.
    expect(svc.getToken("app2")).toBe(refreshed);
    // /debug/state was called once (for the picked:true refresh).
    expect(calls.filter((c) => urlPath(c.url) === "/debug/state").length).toBe(1);
    svc.dispose();
  });

  it("rolls back via /session/delete + /session/purge when activate fails", async () => {
    const token = 1;
    const { fetchImpl, calls } = buildMockFetch(
      new Map([
        ["/session/create", () => ({ body: { success: true, sessionId: "v2-sid", fencingToken: token } })],
        [
          "/claim",
          () => ({ body: { success: true, port: 30001, picked: false } }),
        ],
        [
          "/session/activate",
          () => ({ status: 500, body: { error: { code: "INTERNAL" } } }),
        ],
        ["/session/delete", () => ({ body: { success: true } })],
        ["/session/purge", () => ({ body: { success: true } })],
      ]),
    );
    const svc = createV2PortService({
      baseUrl: BASE,
      clientId: "c1",
      pid: 99,
      getProjectRoot: () => "/proj",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      svc.service.allocateSession({ sessionId: "app3", projectPath: "/proj", worktreePath: "/wt" }),
    ).rejects.toThrow(/activate/);
    // delete + purge were called for rollback
    const paths = calls.map((c) => urlPath(c.url));
    expect(paths).toContain("/session/delete");
    expect(paths).toContain("/session/purge");
    expect(svc.getToken("app3")).toBeNull();
    expect(svc.getStatus("app3")).toBeNull();
    svc.dispose();
  });
});

describe("v2PortService.releaseSession + completeDeletion", () => {
  it("calls /session/delete for phase 1 and /session/purge for phase 2", async () => {
    const token = 1;
    const { fetchImpl, calls } = buildMockFetch(
      new Map([
        ["/session/create", () => ({ body: { success: true, sessionId: "v2-sid", fencingToken: token } })],
        ["/claim", () => ({ body: { success: true, port: 30001, picked: false } })],
        ["/session/activate", () => ({ body: { success: true } })],
        ["/session/delete", () => ({ body: { success: true } })],
        ["/session/purge", () => ({ body: { success: true } })],
      ]),
    );
    const svc = createV2PortService({
      baseUrl: BASE,
      clientId: "c1",
      pid: 99,
      getProjectRoot: () => "/proj",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await svc.service.allocateSession({ sessionId: "app4", projectPath: "/proj", worktreePath: "/wt" });
    await svc.service.releaseSession("app4");
    expect(svc.getStatus("app4")).toBe("deleting");
    await svc.completeDeletion!("app4");
    const paths = calls.map((c) => urlPath(c.url));
    expect(paths).toContain("/session/delete");
    expect(paths).toContain("/session/purge");
    expect(svc.getToken("app4")).toBeNull();
    expect(svc.getStatus("app4")).toBeNull();
    svc.dispose();
  });
});

describe("v2PortService lease-renewal timer", () => {
  it("sends /session/heartbeat every 5s for creating/deleting sessions", async () => {
    const token = 1;
    const { fetchImpl, calls } = buildMockFetch(
      new Map([
        ["/session/create", () => ({ body: { success: true, sessionId: "v2-sid", fencingToken: token } })],
        ["/claim", () => ({ body: { success: true, port: 30001, picked: false } })],
        ["/session/activate", () => ({ body: { success: true } })],
        ["/session/delete", () => ({ body: { success: true } })],
        ["/session/heartbeat", () => ({ body: { success: true } })],
      ]),
    );
    const svc = createV2PortService({
      baseUrl: BASE,
      clientId: "c1",
      pid: 99,
      getProjectRoot: () => "/proj",
      heartbeatIntervalMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await svc.service.allocateSession({ sessionId: "app5", projectPath: "/proj", worktreePath: "/wt" });
    // Active session — no heartbeat yet.
    let heartbeats = calls.filter((c) => urlPath(c.url) === "/session/heartbeat").length;
    expect(heartbeats).toBe(0);

    // Move to deleting phase.
    await svc.service.releaseSession("app5");
    // Advance fake timer past 1 heartbeat.
    await vi.advanceTimersByTimeAsync(1500);
    heartbeats = calls.filter((c) => urlPath(c.url) === "/session/heartbeat").length;
    expect(heartbeats).toBeGreaterThanOrEqual(1);

    // Advance more — multiple heartbeats should accumulate.
    await vi.advanceTimersByTimeAsync(3000);
    const more = calls.filter((c) => urlPath(c.url) === "/session/heartbeat").length;
    expect(more).toBeGreaterThanOrEqual(3);

    // Complete deletion stops the renewal.
    await svc.completeDeletion!("app5");
    const beforeCount = calls.filter((c) => urlPath(c.url) === "/session/heartbeat").length;
    await vi.advanceTimersByTimeAsync(3000);
    const afterCount = calls.filter((c) => urlPath(c.url) === "/session/heartbeat").length;
    expect(afterCount).toBe(beforeCount);
    svc.dispose();
  });

  it("refreshes token from /debug/state when heartbeat returns 409 STALE_OWNER", async () => {
    const initialToken = 1;
    const refreshedToken = 2;
    let hbCalls = 0;
    const { fetchImpl, calls } = buildMockFetch(
      new Map([
        ["/session/create", () => ({ body: { success: true, sessionId: "app6", fencingToken: initialToken } })],
        ["/claim", () => ({ body: { success: true, port: 30001, picked: false } })],
        ["/session/activate", () => ({ body: { success: true } })],
        ["/session/delete", () => ({ body: { success: true } })],
        [
          "/session/heartbeat",
          () => {
            hbCalls++;
            return hbCalls === 1
              ? { status: 409, body: { error: { code: "STALE_OWNER" } } }
              : { body: { success: true } };
          },
        ],
        ["/debug/state", () => ({ body: { v2Owners: { "app6": { fencingToken: refreshedToken } } } })],
      ]),
    );
    const svc = createV2PortService({
      baseUrl: BASE,
      clientId: "c1",
      pid: 99,
      getProjectRoot: () => "/proj",
      heartbeatIntervalMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await svc.service.allocateSession({ sessionId: "app6", projectPath: "/proj", worktreePath: "/wt" });
    await svc.service.releaseSession("app6");
    // First tick — 409 → refresh.
    await vi.advanceTimersByTimeAsync(1500);
    expect(svc.getToken("app6")).toBe(refreshedToken);
    expect(calls.filter((c) => urlPath(c.url) === "/debug/state").length).toBe(1);
    // Second tick — uses refreshed token, succeeds.
    await vi.advanceTimersByTimeAsync(1500);
    expect(calls.filter((c) => urlPath(c.url) === "/session/heartbeat").length).toBeGreaterThanOrEqual(2);
    svc.dispose();
  });

  it("removes the session from the renewal map after 3 consecutive failures", async () => {
    const token = 1;
    const { fetchImpl, calls } = buildMockFetch(
      new Map([
        ["/session/create", () => ({ body: { success: true, sessionId: "v2-sid", fencingToken: token } })],
        ["/claim", () => ({ body: { success: true, port: 30001, picked: false } })],
        ["/session/activate", () => ({ body: { success: true } })],
        ["/session/delete", () => ({ body: { success: true } })],
        ["/session/heartbeat", () => ({ status: 500, body: { error: { code: "INTERNAL" } } })],
      ]),
    );
    const svc = createV2PortService({
      baseUrl: BASE,
      clientId: "c1",
      pid: 99,
      getProjectRoot: () => "/proj",
      heartbeatIntervalMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await svc.service.allocateSession({ sessionId: "app7", projectPath: "/proj", worktreePath: "/wt" });
    await svc.service.releaseSession("app7");
    // Advance through 3+ heartbeat ticks.
    await vi.advanceTimersByTimeAsync(5000);
    const failedHb = calls.filter((c) => urlPath(c.url) === "/session/heartbeat").length;
    // After 3 failures, no more heartbeats.
    await vi.advanceTimersByTimeAsync(3000);
    const finalHb = calls.filter((c) => urlPath(c.url) === "/session/heartbeat").length;
    expect(finalHb).toBe(failedHb);
    expect(failedHb).toBeGreaterThanOrEqual(3);
    svc.dispose();
  });
});

/**
 * verifyCommitPoint — §4.2 提交点内联校验 (P1-3 修复).
 */
describe("verifyCommitPoint (新架构 §4.2)", () => {
  // 用临时目录模拟 worktree
  let tmpDir: string;
  beforeEach(async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "v2-cp-"));
  });

  it("passes when .env 端口键值与 claimed 一致", async () => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(`${tmpDir}/.env`, "FRONTEND_PORT=30001\nBACKEND_PORT=30002\n");
    const { verifyCommitPoint } = await import("../v2-port-service.js");
    expect(() =>
      verifyCommitPoint(tmpDir, { FRONTEND_PORT: 30001, BACKEND_PORT: 30002 }),
    ).not.toThrow();
  });

  it("throws on missing port key in .env (syncResources mergeEnvFileSync 漏洞)", async () => {
    const fs = await import("node:fs/promises");
    // .env 缺 BACKEND_PORT
    await fs.writeFile(`${tmpDir}/.env`, "FRONTEND_PORT=30001\n");
    const { verifyCommitPoint } = await import("../v2-port-service.js");
    expect(() =>
      verifyCommitPoint(tmpDir, { FRONTEND_PORT: 30001, BACKEND_PORT: 30002 }),
    ).toThrow(/missing port key BACKEND_PORT/);
  });

  it("throws on value mismatch (脏 .env 由 syncResources 合并进旧端口值)", async () => {
    const fs = await import("node:fs/promises");
    // .env FRONTEND_PORT=30000 是 syncResources merge 进来的旧值
    await fs.writeFile(`${tmpDir}/.env`, "FRONTEND_PORT=30000\nBACKEND_PORT=30002\n");
    const { verifyCommitPoint } = await import("../v2-port-service.js");
    expect(() =>
      verifyCommitPoint(tmpDir, { FRONTEND_PORT: 30001, BACKEND_PORT: 30002 }),
    ).toThrow(/FRONTEND_PORT=30000 != daemon port 30001/);
  });

  it("throws on missing .env file", async () => {
    const { verifyCommitPoint } = await import("../v2-port-service.js");
    expect(() => verifyCommitPoint(tmpDir, { FRONTEND_PORT: 30001 })).toThrow(
      /cannot read .*\.env/,
    );
  });

  it("throws on empty claimed ports (N=0)", async () => {
    const fs = await import("node:fs/promises");
    await fs.writeFile(`${tmpDir}/.env`, "OTHER=value\n");
    const { verifyCommitPoint } = await import("../v2-port-service.js");
    expect(() => verifyCommitPoint(tmpDir, {})).toThrow(/no claimed ports/);
  });
});