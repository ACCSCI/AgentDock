/**
 * 新架构 UI E2E — DaemonStatusBar + IPC bridges to v2 daemon.
 *
 * Verifies the renderer's DaemonStatusBar reads /health via IPC and the
 * v2 daemon IPC bridge returns the §2 health shape (protocolVersion,
 * capabilities, state, schemaVersion). Tolerates RECOVERING state since
 * tests run against the shared ~/.agentdock/ daemon whose expected
 * session count may include leftover entries.
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

test.describe("DaemonStatusBar — 新架构 §2 + §11.1", () => {
  test("renders with pid, port, protocolVersion, capabilities fields", async ({
    window,
    expectNoRendererErrors,
  }) => {
    const bar = window.locator(`[data-testid="${TID.daemonStatusBar}"]`);
    await expect(bar).toBeVisible({ timeout: 15_000 });

    const state = window.locator(`[data-testid="${TID.daemonState}"]`);
    await expect(state).toBeVisible({ timeout: 10_000 });
    const stateText = await state.textContent();
    expect(["Running", "Recovering"]).toContain(stateText);

    await expect(
      window.locator(`[data-testid="${TID.daemonPid}"]`),
    ).toContainText("pid");
    await expect(
      window.locator(`[data-testid="${TID.daemonPort}"]`),
    ).not.toBeEmpty();
    await expect(
      window.locator(`[data-testid="${TID.daemonProtocol}"]`),
    ).toContainText("v");
    await expect(
      window.locator(`[data-testid="${TID.daemonCapabilities}"]`),
    ).toContainText("caps");

    expectNoRendererErrors();
  });

  test("daemon:health IPC returns v2 health shape (新架构 §2)", async ({
    window,
  }) => {
    const health = await window.evaluate(async () => {
      return await window.api.daemon.health();
    });
    expect(health.protocolVersion).toBe("2");
    expect(health.schemaVersion).toBe(2);
    expect(["READY", "RECOVERING"]).toContain(health.state);
    expect(health.capabilities).toEqual(
      expect.arrayContaining([
        "port-allocation",
        "session-registry",
        "claim-port",
        "fencing",
        "lifecycle-lease",
      ]),
    );
    expect(typeof health.pid).toBe("number");
    expect(health.pid).toBeGreaterThan(0);
    expect(typeof health.port).toBe("number");
    expect(health.port).toBeGreaterThan(0);
  });

  test("daemon:debugState IPC returns v2 three-table state (新架构 §4.1)", async ({
    window,
    dataDir,
  }) => {
    const projectPath = join(dataDir, "dbg-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);
    const { HomePage } = await import("./pages/home");
    const h = new HomePage(window);
    await h.openProject(projectPath);

    const debug = await window.evaluate(async () => {
      const res = await window.api.daemon.debugState();
      return res as Record<string, unknown> | null;
    });
    expect(debug).not.toBeNull();
    expect(debug!.schemaVersion).toBe(2);
    expect(["READY", "RECOVERING"]).toContain(debug!.lifecycleState);
    expect(debug!.v2Sessions).toBeDefined();
    expect(debug!.v2Ports).toBeDefined();
  });
});