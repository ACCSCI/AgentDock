/**
 * F6: v2PortService must propagate user-supplied displayName to
 * /session/create (新架构 §4.1).
 *
 * Bug A — v2PortService 丢用户命名:
 *   plugins/v2-port-service.ts:314 hardcodes `displayName: sessionId` when
 *   calling /session/create. The renderer passes params.name but the v2
 *   service discards it. The daemon falls back to the UUID's first 8 chars,
 *   which is not what the user typed.
 *
 * This test asserts the v2 service forwards the user-supplied displayName
 * to /session/create verbatim, falling back to sessionId only when omitted.
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

function buildMockFetch(
  responses: Map<
    string,
    (req: FetchCall) => MockResponseInit | Promise<MockResponseInit>
  >,
) {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const req: FetchCall = { url, init: init ?? {} };
      calls.push(req);
      const handler = responses.get(url.replace(/^http:\/\/[^/]+/, ""));
      if (!handler) {
        return new Response(
          JSON.stringify({ error: { code: "MOCK_MISS" } }),
          { status: 500 },
        );
      }
      const res = await handler(req);
      return new Response(JSON.stringify(res.body ?? {}), {
        status: res.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  );
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

describe("v2PortService.allocateSession — displayName pass-through (F6)", () => {
  it("forwards user-supplied displayName to /session/create verbatim", async () => {
    const userDisplayName = "我的中文名";
    const { fetchImpl, calls } = buildMockFetch(
      new Map([
        [
          "/session/create",
          () => ({
            body: { success: true, sessionId: "v2-sid", fencingToken: 1 },
          }),
        ],
        [
          "/claim",
          (req: FetchCall) => {
            const body = JSON.parse(String(req.init.body)) as {
              name: string;
            };
            return {
              body: { success: true, port: 30001, picked: false, name: body.name },
            };
          },
        ],
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
      sessionId: "abc123",
      projectPath: "/proj",
      worktreePath: "/wt",
      displayName: userDisplayName,
    });
    // First call must be /session/create with displayName == user's input.
    const createCall = calls.find((c) => urlPath(c.url) === "/session/create");
    expect(createCall).toBeDefined();
    const sentBody = JSON.parse(String(createCall!.init.body)) as {
      displayName: string;
    };
    expect(sentBody.displayName).toBe(userDisplayName);
    // And it must NOT silently fall back to sessionId.
    expect(sentBody.displayName).not.toBe("abc123");
    svc.dispose();
  });

  it("falls back to sessionId when displayName is omitted (defensive default)", async () => {
    const { fetchImpl, calls } = buildMockFetch(
      new Map([
        [
          "/session/create",
          () => ({
            body: { success: true, sessionId: "v2-sid", fencingToken: 1 },
          }),
        ],
        ["/claim", () => ({ body: { success: true, port: 30001, picked: false } })],
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
      sessionId: "fallback-id",
      projectPath: "/proj",
      worktreePath: "/wt",
      // no displayName
    });
    const createCall = calls.find((c) => urlPath(c.url) === "/session/create");
    expect(createCall).toBeDefined();
    const sentBody = JSON.parse(String(createCall!.init.body)) as {
      displayName: string;
    };
    expect(sentBody.displayName).toBe("fallback-id");
    svc.dispose();
  });

  it("accepts unicode/emoji/space displayName (新架构 §4.1 — 自由文本)", async () => {
    const evilDisplay = "我的中文 🚀  with space";
    const { fetchImpl, calls } = buildMockFetch(
      new Map([
        [
          "/session/create",
          () => ({
            body: { success: true, sessionId: "v2-sid", fencingToken: 1 },
          }),
        ],
        ["/claim", () => ({ body: { success: true, port: 30001, picked: false } })],
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
      sessionId: "uni1",
      projectPath: "/proj",
      worktreePath: "/wt",
      displayName: evilDisplay,
    });
    const createCall = calls.find((c) => urlPath(c.url) === "/session/create");
    const sentBody = JSON.parse(String(createCall!.init.body)) as {
      displayName: string;
    };
    expect(sentBody.displayName).toBe(evilDisplay);
    svc.dispose();
  });

  it("does not leak displayName into branch / worktreePath (硬契约)", async () => {
    // §4.1 — branch/worktreePath only derived from sessionId, never displayName.
    // We just check that the /session/create body only carries displayName
    // (not branch / worktreePath), and the daemon is free to derive those
    // itself from sessionId.
    const { fetchImpl, calls } = buildMockFetch(
      new Map([
        [
          "/session/create",
          () => ({
            body: { success: true, sessionId: "v2-sid", fencingToken: 1 },
          }),
        ],
        ["/claim", () => ({ body: { success: true, port: 30001, picked: false } })],
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
      sessionId: "iso1",
      projectPath: "/proj",
      worktreePath: "/wt",
      displayName: "我的中文名/with/slashes",
    });
    const createCall = calls.find((c) => urlPath(c.url) === "/session/create");
    const sentBody = JSON.parse(String(createCall!.init.body)) as Record<string, unknown>;
    // body must NOT contain branch or worktreePath fields.
    expect(sentBody).not.toHaveProperty("branch");
    expect(sentBody).not.toHaveProperty("worktreePath");
    svc.dispose();
  });
});

// Reuse PORT_KEYS_DEFAULT just to confirm test plumbing is wired.
describe("smoke — v2 test infra", () => {
  it("PORT_KEYS_DEFAULT is non-empty", () => {
    expect(PORT_KEYS_DEFAULT.length).toBeGreaterThan(0);
  });
});
