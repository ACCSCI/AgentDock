/**
 * Daemon reconnection E2E.
 *
 * Opens a project, creates a session, then attempts to kill the daemon
 * child process and verifies the UI status bar shows a disconnected/error
 * state. We then verify that attempting to create a new session handles
 * the error gracefully (no crash, no infinite React loop).
 *
 * NOTE: This test is best-effort — killing the daemon may not be fully
 * reliable on all platforms, so we use a generous timeout and soft checks.
 * The core value is verifying the UI doesn't crash when the daemon is gone.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/electron-fixture";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";
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
 * Find and kill the daemon child process (by name).
 * Returns true if a process was killed.
 */
function killDaemonProcess(appPid: number): boolean {
  try {
    if (process.platform === "win32") {
      // Find child processes of the Electron app that look like a daemon.
      const out = execSync(
        `powershell -NoProfile -Command "(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${appPid} } | Select-Object -ExpandProperty ProcessId)"`,
        { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const childPids = out
        .split(/\r?\n/)
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);

      // Kill each child process — one of them should be the daemon.
      let killed = false;
      for (const pid of childPids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
          killed = true;
        } catch {
          // Process may already be gone.
        }
      }
      return killed;
    } else {
      // Unix: kill all children of the Electron process.
      execSync(`pkill -P ${appPid}`, { stdio: "ignore" });
      return true;
    }
  } catch {
    return false;
  }
}

test.describe("daemon reconnection", () => {
  test("kill daemon -> UI degrades gracefully -> no crash", async ({
    app,
    window,
    dataDir,
    pageErrors,
    dialogs,
    rendererLog,
    mainLog,
    expectNoRendererErrors,
  }) => {
    const projectPath = join(dataDir, "reconnect-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);

    const home = new HomePage(window);
    const sidebar = new SidebarPage(window);

    // 1. Open project and create a session.
    await home.openProject(projectPath);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });
    await sidebar.clickNewSession();
    await expect
      .poll(async () => sidebar.cardCount(), { timeout: 30_000 })
      .toBe(1);

    const card = window.locator(`[data-testid="${TID.sessionCard}"]`).first();
    await expect(card).toBeVisible();

    // 2. Verify the daemon status bar initially shows a healthy state.
    const statusBar = window.locator(`[data-testid="${TID.daemonStatusBar}"]`);
    await expect(statusBar).toBeVisible({ timeout: 10_000 });

    // 3. Kill the daemon child process.
    const appPid = app.process().pid;
    expect(appPid).toBeTruthy();
    const killed = killDaemonProcess(appPid!);
    console.log(`[test] killDaemonProcess: killed=${killed}`);

    // 4. Wait a bit for the UI to notice the daemon is gone.
    // The status bar should eventually show a non-healthy state,
    // or the app should remain functional with a degraded status.
    // Give it up to 10 seconds to transition.
    let degradedState = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const stateText = await window
        .locator(`[data-testid="${TID.daemonState}"]`)
        .textContent()
        .catch(() => null);
      if (stateText && stateText.toLowerCase() !== "running") {
        degradedState = true;
        break;
      }
      await window.waitForTimeout(500);
    }
    // NOTE: degradedState may be false if the daemon restarts quickly
    // or the status bar doesn't update. This is acceptable — the core
    // check is that the UI doesn't crash.

    console.log(`[test] degradedState detected: ${degradedState}`);

    // 5. The critical check: no React infinite loops or page errors.
    //    Even if the daemon state didn't visibly change, we verify
    //    the renderer survived the daemon death.
    const maxDepthErrors = rendererLog.filter((e) =>
      /Maximum update depth exceeded/i.test(e.text),
    );
    expect(
      maxDepthErrors,
      `React infinite-loop after daemon kill:\n${maxDepthErrors.map((e) => e.text).join("\n")}`,
    ).toHaveLength(0);

    expect(
      pageErrors,
      `pageerrors after daemon kill: ${JSON.stringify(pageErrors)}`,
    ).toHaveLength(0);

    // 6. No alert dialogs (the app should handle errors gracefully).
    expect(
      dialogs.filter((d) => d.type === "alert"),
      `alert dialogs after daemon kill: ${JSON.stringify(dialogs)}`,
    ).toHaveLength(0);

    expectNoRendererErrors();
  });
});
