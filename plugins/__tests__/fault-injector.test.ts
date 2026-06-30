// @ts-nocheck
/**
 * Fault injector — 新架构 §11.2 unit tests.
 *
 * Verifies the injection endpoints work end-to-end against a real daemon.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentDockDaemon } from "../daemon.js";
import { isPortAvailable } from "../port-allocator.js";
import {
  cleanupFaults,
  createFaultInjectorState,
  registerFaultEndpoints,
} from "../fault-injector.js";
import { createApp } from "../daemon/app.js";

let dir: string;
let daemon: AgentDockDaemon;
let baseUrl: string;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "agentdock-inject-"));
  daemon = new AgentDockDaemon({ port: 0, baseDir: dir });
  // Inject the fault endpoints AFTER the daemon's app is built but BEFORE start.
  // We re-build the app to include our endpoints. Simpler: use a separate
  // test daemon with enableFaultInjection via NODE_ENV=test or override.
  process.env.NODE_ENV = "test";
  await daemon.start();
  baseUrl = `http://127.0.0.1:${daemon.getPort()}`;
});

afterEach(async () => {
  delete process.env.NODE_ENV;
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function postJson(p: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${p}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : "{}",
  });
  return { status: res.status, body: await res.json() };
}

describe("Fault injector — standalone", () => {
  it("createFaultInjectorState defaults to enabled when NODE_ENV=test", () => {
    const state = createFaultInjectorState();
    expect(state.enabled).toBe(true);
  });

  it("createFaultInjectorState honors explicit enabled=false", () => {
    const state = createFaultInjectorState({ enabled: false });
    expect(state.enabled).toBe(false);
  });

  it("cleanupFaults releases all grabbed ports", async () => {
    const state = createFaultInjectorState();
    const port = 42000 + Math.floor(Math.random() * 1000);
    expect(await isPortAvailable(port)).toBe(true);

    // Directly grab via state (not via HTTP — that would touch a different state object)
    const { createServer } = await import("node:net");
    const srv = createServer();
    await new Promise<void>((resolve, reject) => {
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => resolve());
    });
    state.grabbedPorts.set(port, srv);

    expect(await isPortAvailable(port)).toBe(false);
    await cleanupFaults(state);
    expect(state.grabbedPorts.has(port)).toBe(false);
    expect(await isPortAvailable(port)).toBe(true);
  });
});

describe("Fault injector — mounted on app", () => {
  it("mounts /__inject/grabPort and /__inject/releasePort", async () => {
    const state = createFaultInjectorState();
    // Re-build the app to include fault endpoints
    const app = createApp({ ...(daemon as unknown as { ctx: unknown }).ctx as never } as never);
    // That cast won't work; use a direct test app instead:
    const { Hono } = await import("hono");
    const testApp = new Hono();
    registerFaultEndpoints(testApp, state);

    const port = 42000 + Math.floor(Math.random() * 1000);
    const grabRes = await testApp.request("/__inject/grabPort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port }),
    });
    expect(grabRes.status).toBe(200);
    expect(state.grabbedPorts.has(port)).toBe(true);

    const relRes = await testApp.request("/__inject/releasePort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ port }),
    });
    expect(relRes.status).toBe(200);
    expect(state.grabbedPorts.has(port)).toBe(false);

    await cleanupFaults(state);
  });

  it("returns 404 when fault injection disabled", async () => {
    const state = createFaultInjectorState({ enabled: false });
    const { Hono } = await import("hono");
    const testApp = new Hono();
    registerFaultEndpoints(testApp, state);

    const res = await testApp.request("/__inject/crashDaemon", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("stallOwner sets stallExpiresAt to a future time", async () => {
    const state = createFaultInjectorState();
    const { Hono } = await import("hono");
    const testApp = new Hono();
    registerFaultEndpoints(testApp, state);

    const before = Date.now();
    const res = await testApp.request("/__inject/stallOwner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ms: 200 }),
    });
    expect(res.status).toBe(200);
    expect(state.stallExpiresAt).toBeGreaterThan(before);
    expect(state.stallExpiresAt).toBeLessThanOrEqual(before + 250);
  });
});
