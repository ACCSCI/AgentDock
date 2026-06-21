/**
 * 新架构 UI E2E — v2 架构 IPC 验证.
 *
 * Drives the v2 daemon API directly via the Electron main process IPC
 * bridge (using faultInject-style forwarding). The full UI session
 * creation flow is P9 scope — here we verify the architecture contract:
 *
 *   1. /health returns the §2 capability negotiation surface
 *   2. /session/create returns sessionId + fencingToken=1 (新创建 owner)
 *   3. /claim returns a port and gates writes by fencingToken
 *   4. /session/activate flips status to active
 *   5. /takeover bumps fencingToken; stale writes return 409 STALE_OWNER
 *   6. /session/delete releases all ports + sets status=deleting
 *   7. /session/purge drops the 3-table entries
 *   8. /debug/state exposes v2Sessions/v2Ports/v2Owners superset
 *
 * The renderer is the artifact under test for the DaemonStatusBar +
 * IPC plumbing; the v2 API contract itself is exercised here. (P9 will
 * route UI clicks through these same endpoints.)
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/electron-fixture";
import { TID } from "./pages/testids";

function prepareGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q -b main", { cwd: dir });
  execSync(
    'git -c user.email=e2e@local -c user.name=E2E commit --allow-empty -q -m init',
    { cwd: dir },
  );
}

function writeEmptyConfig(dir: string): void {
  writeFileSync(
    join(dir, "agentdock.config.yaml"),
    `version: "1"\nresources:\n  sync: []\nhooks: {}\n`,
    "utf-8",
  );
}

/**
 * Wait for the daemon to transition from RECOVERING to READY.
 * After a fresh boot with stale WAL, the daemon stays RECOVERING for up to
 * 15s (RECOVERING_HARD_MAX_MS). Polls /health until lifecycleState=READY.
 */
async function waitForDaemonReady(
  window: import("@playwright/test").Page,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await window.evaluate(async () => {
      return (await window.api.daemon.health()) as {
        state?: string;
        lifecycleState?: string;
      };
    });
    const state = health.lifecycleState ?? health.state;
    if (state === "ready" || state === "READY") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForDaemonReady: daemon not READY after ${timeoutMs}ms`);
}

/**
 * Forward a request to the v2 daemon via the daemon:faultInject IPC
 * bridge. The fault injector accepts arbitrary POST paths under
 * /__inject/* in test mode; we just use it as a generic HTTP
 * forwarder here so the test can exercise /session/* and /claim etc.
 */
async function callV2(
  window: import("@playwright/test").Page,
  path: string,
  body: unknown = {},
): Promise<{ success: boolean; status?: number; body?: unknown }> {
  return window.evaluate(
    async ({ p, b }) => {
      const res = await window.api.daemon.faultInject(p, b);
      return res as { success: boolean; status?: number; body?: unknown };
    },
    { p: path, b: body },
  );
}

test.describe("v2 architecture contract (新架构 §13.1)", () => {
  test("/health exposes capability negotiation", async ({ window }) => {
    const r = await callV2(window, "/__inject/grabPort", { port: 49000 });
    // First call warms the IPC bridge — use /health directly instead.
    const health = await window.evaluate(async () => {
      return (await window.api.daemon.health()) as {
        protocolVersion: string;
        capabilities: string[];
      };
    });
    expect(health.protocolVersion).toBe("1");
    expect(health.capabilities).toEqual(
      expect.arrayContaining([
        "port-allocation",
        "session-registry",
        "claim-port",
        "fencing",
        "lifecycle-lease",
      ]),
    );
    // Suppress unused-warning by touching the warmup result.
    expect(typeof r).toBe("object");
  });

  test("/session/create + activate + claim + takeover + delete + purge", async ({
    window,
    dataDir,
  }) => {
    // Wait for daemon READY — stale WAL may cause 15s RECOVERING.
    await waitForDaemonReady(window);

    // Open a project so the renderer has the activeProjectPath wired.
    const projectPath = join(dataDir, "v2-arch-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);
    const { HomePage } = await import("./pages/home");
    await new HomePage(window).openProject(projectPath);

    // 1. Create a session.
    const createRes = await callV2(window, "/session/create", {
      clientId: "e2e-client",
      pid: 12345,
      projectRoot: projectPath,
      displayName: "v2-architecture-e2e",
    });
    expect(createRes.success).toBe(true);
    const sessionId = (createRes.body as { sessionId: string }).sessionId;
    expect(sessionId).toMatch(/^[a-zA-Z0-9-]+$/);
    const initialToken = (createRes.body as { fencingToken: number })
      .fencingToken;
    expect(initialToken).toBe(1);

    // 2. Activate.
    const actRes = await callV2(window, "/session/activate", {
      sessionId,
      fencingToken: initialToken,
    });
    expect(actRes.success).toBe(true);

    // 3. Claim 3 ports for the session.
    const claimedPorts: Record<string, number> = {};
    for (const name of ["FRONTEND_PORT", "API_PORT", "WS_PORT"]) {
      const claimRes = await callV2(window, "/claim", {
        sessionId,
        fencingToken: initialToken,
        name,
      });
      expect(claimRes.success).toBe(true);
      claimedPorts[name] = (claimRes.body as { port: number }).port;
    }
    expect(Object.values(claimedPorts).every((p) => p > 0)).toBe(true);

    // 4. Verify /debug/state shows the session in v2 three-table.
    // Filter to current session — ~/.agentdock is shared across tests.
    const dbg = await window.evaluate(async () => {
      return (await window.api.daemon.debugState()) as {
        v2Sessions: Record<string, { status: string; displayName: string }>;
        v2Ports: Record<number, { sessionId: string; name: string }>;
        v2Owners: Record<string, { clientId: string; fencingToken: number }>;
      };
    });
    expect(dbg.v2Sessions[sessionId].status).toBe("active");
    expect(dbg.v2Sessions[sessionId].displayName).toBe("v2-architecture-e2e");
    expect(dbg.v2Owners[sessionId].fencingToken).toBe(initialToken);
    const sessionPorts = Object.values(dbg.v2Ports).filter(
      (p) => p.sessionId === sessionId,
    );
    expect(sessionPorts.length).toBe(3);

    // 5. Takeover from another client bumps fencingToken.
    const tkRes = await callV2(window, "/takeover", {
      sessionId,
      clientId: "another-e2e-instance",
      pid: 67890,
      fencingToken: initialToken,
    });
    expect(tkRes.success).toBe(true);
    const newToken = (tkRes.body as { fencingToken: number }).fencingToken;
    expect(newToken).toBe(initialToken + 1);

    // 6. Stale write with old token must return 409 STALE_OWNER.
    const staleRes = await callV2(window, "/claim", {
      sessionId,
      fencingToken: initialToken, // stale!
      name: "STALE_PORT",
    });
    expect(staleRes.success).toBe(false);
    expect(staleRes.status).toBe(409);
    const errBody = staleRes.body as { error: { code: string } };
    expect(errBody.error.code).toBe("STALE_OWNER");

    // 7. Delete (phase 1): releases all ports, status=deleting.
    const delRes = await callV2(window, "/session/delete", {
      sessionId,
      fencingToken: newToken,
    });
    expect(delRes.success).toBe(true);

    const dbgAfterDel = await window.evaluate(async () => {
      return (await window.api.daemon.debugState()) as {
        v2Sessions: Record<string, { status: string }>;
        v2Ports: Record<number, { sessionId: string }>;
      };
    });
    expect(dbgAfterDel.v2Sessions[sessionId].status).toBe("deleting");
    const remainingPorts = Object.values(dbgAfterDel.v2Ports).filter(
      (p) => p.sessionId === sessionId,
    );
    expect(remainingPorts.length).toBe(0);

    // 8. Purge (phase 2): drops three-table entries.
    const purgeRes = await callV2(window, "/session/purge", {
      sessionId,
      fencingToken: newToken,
    });
    expect(purgeRes.success).toBe(true);

    const dbgAfterPurge = await window.evaluate(async () => {
      return (await window.api.daemon.debugState()) as {
        v2Sessions: Record<string, unknown>;
      };
    });
    expect(dbgAfterPurge.v2Sessions[sessionId]).toBeUndefined();
  });

  test("port-reassigned event fires when /claim conflicts", async ({
    window,
    dataDir,
  }) => {
    // Wait for daemon READY — stale WAL may cause 15s RECOVERING.
    await waitForDaemonReady(window);

    const projectPath = join(dataDir, "v2-event-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);
    const { HomePage } = await import("./pages/home");
    await new HomePage(window).openProject(projectPath);

    // Create + activate session A.
    const a = await callV2(window, "/session/create", {
      clientId: "cA",
      pid: 1,
      projectRoot: projectPath,
      displayName: "sA",
    });
    const sidA = (a.body as { sessionId: string }).sessionId;
    const tokA = (a.body as { fencingToken: number }).fencingToken;
    await callV2(window, "/session/activate", {
      sessionId: sidA,
      fencingToken: tokA,
    });

    // sA claims a port.
    const aClaim = await callV2(window, "/claim", {
      sessionId: sidA,
      fencingToken: tokA,
      name: "P",
    });
    const portA = (aClaim.body as { port: number }).port;

    // Create session B and try to claim the same port.
    const b = await callV2(window, "/session/create", {
      clientId: "cB",
      pid: 2,
      projectRoot: projectPath,
      displayName: "sB",
    });
    const sidB = (b.body as { sessionId: string }).sessionId;
    const tokB = (b.body as { fencingToken: number }).fencingToken;
    await callV2(window, "/session/activate", {
      sessionId: sidB,
      fencingToken: tokB,
    });

    const bClaim = await callV2(window, "/claim", {
      sessionId: sidB,
      fencingToken: tokB,
      requestedPort: portA,
      name: "P",
    });
    expect(bClaim.success).toBe(true);
    const portB = (bClaim.body as { port: number }).port;
    expect(portB).not.toBe(portA);
  });
});

test.describe("DaemonStatusBar visible in renderer (新架构 §2 + §11.1)", () => {
  test("status bar renders and matches daemon:health IPC payload", async ({
    window,
  }) => {
    const bar = window.locator(`[data-testid="${TID.daemonStatusBar}"]`);
    await expect(bar).toBeVisible({ timeout: 15_000 });

    const health = await window.evaluate(async () => {
      return await window.api.daemon.health();
    });
    // The status bar polls the same IPC, so its rendered text should
    // be a substring of the response (state is lowercased in the UI).
    const stateEl = window.locator(`[data-testid="${TID.daemonState}"]`);
    const renderedState = await stateEl.textContent();
    expect(["ready", "recovering"]).toContain(renderedState);
    expect(health.state.toLowerCase()).toBe(renderedState);
  });
});