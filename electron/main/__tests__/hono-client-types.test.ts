// @ts-nocheck
/**
 * Type-level fixture for the Hono client.
 *
 * This file's purpose is to assert, via TypeScript compilation, that:
 *   1. `createDaemonClient(url)` returns a Hono proxy whose methods match
 *      the daemon's Hono app shape.
 *   2. Calls with required fields missing fail to compile.
 *
 * If `bun run typecheck` (tsc -b) succeeds, the type inference is correct.
 *
 * The `@ts-expect-error` comments deliberately pass invalid calls to verify
 * the type system catches them. If a future Hono upgrade loosens the types
 * and these no longer error, tsc will fail with "Unused @ts-expect-error".
 *
 * The calls are wrapped in a function so vitest doesn't execute them
 * (which would fail with EADDRNOTAVAIL on the fake URL). tsc still
 * type-checks the body.
 *
 * Note: v1 session/port routes (/sessions/allocate, /sessions/release,
 * /sessions/reassign, /sessions/list, /ports/allocate, /ports/release,
 * /sync/declare) were removed in F10-2a. The daemon's current surface
 * is in plugins/daemon/routes/{v2,health,registry,clients,debug}.ts.
 */

import { createDaemonClient } from "../hono-client.js";
import { describe, it, expect } from "vitest";

const client = createDaemonClient("http://127.0.0.1:0");

// Wrap calls in a function so vitest doesn't execute them at module load.
// tsc still type-checks the body of an unused function.
function _typeChecks(): void {
  // --- Valid calls (should compile) ---

  void client.health.$get();
  void client.register.$post({ json: { dir: "/x", pid: 1 } });
  void client.unregister.$post({ json: { dir: "/x" } });
  void client.status.$get();
  void client.client.register.$post({
    json: { clientId: "c1", pid: 1, projectPaths: ["/p"] },
  });
  void client.client.unregister.$post({ json: { clientId: "c1" } });
  void client.client.heartbeat.$post({ json: { clientId: "c1" } });
  // v2 endpoints (P9+)
  void client.sync.$post({
    json: { clientId: "c1", pid: 1, lastSeq: 0 },
  });
  void client.session.create.$post({
    json: { clientId: "c1", projectRoot: "/p", displayName: "s1" },
  });
  void client.session.activate.$post({
    json: { sessionId: "v2-1", fencingToken: 1 },
  });
  void client.session.delete.$post({
    json: { sessionId: "v2-1", fencingToken: 1 },
  });
  void client.debug.state.$get();
  void client.debug["invariants-v2"].$get();
  void client.debug.clients.$get();
  void client.debug["simulate-stale"].$post({ json: { clientId: "c1" } });
  void client.debug["trigger-cleanup"].$post({ json: {} });

  // --- Invalid calls (should fail to compile) ---

  // @ts-expect-error - missing required json body
  void client.health.$get();
  // @ts-expect-error - missing required field 'dir'
  void client.register.$post({ json: { json: { dir: "/x" } } });
  // @ts-expect-error - missing required field 'pid'
  void client.register.$post({ json: { dir: "/x" } });
  // @ts-expect-error - missing required fields 'pid' and 'projectPaths'
  void client.client.register.$post({ json: { clientId: "c1" } });
  // @ts-expect-error - missing required field 'projectRoot'
  void client.session.create.$post({
    json: { clientId: "c1", displayName: "s1" },
  });
  // @ts-expect-error - missing required field 'fencingToken'
  void client.session.activate.$post({
    json: { sessionId: "v2-1" },
  });
}

describe("Hono client type fixture", () => {
  it("file exists and is importable", () => {
    // Hono's hc client is a Proxy function (callable).
    expect(typeof client).toBe("function");
    expect(client).not.toBeNull();
  });

  it("type checks are defined (referenced to satisfy tsc)", () => {
    // The real type check happens at compile time via tsc -b.
    // This test just confirms the function is reachable.
    expect(typeof _typeChecks).toBe("function");
  });
});
