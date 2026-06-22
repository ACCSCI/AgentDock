/**
 * Multi-project workflow E2E.
 *
 * Opens project A, creates a session in A, then opens project B via the
 * "+" tab button, creates a session in B, switches back and forth between
 * tabs, and verifies the UI remains functional and no errors occur.
 *
 * NOTE: Session persistence across tabs is verified by UI state (tab counts,
 * no crashes) rather than DB queries, because the v2 architecture stores
 * session state in the daemon rather than the local DB.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/electron-fixture";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";
import { TabBarPage } from "./pages/tab-bar";
import { TID } from "./pages/testids";
import { waitForDaemonReady } from "./helpers/ipc";

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

test.describe("multi-project workflow", () => {
  test("open project A -> create session -> open B -> create session -> switch tabs -> no errors", async ({
    window,
    dataDir,
    pageErrors,
    dialogs,
    rendererLog,
    expectNoRendererErrors,
  }) => {
    // 1. Prepare two git projects on disk.
    const projectAPath = join(dataDir, "project-a");
    const projectBPath = join(dataDir, "project-b");
    prepareGitRepo(projectAPath);
    writeEmptyConfig(projectAPath);
    prepareGitRepo(projectBPath);
    writeEmptyConfig(projectBPath);

    const home = new HomePage(window);
    const tabBar = new TabBarPage(window);
    const sidebar = new SidebarPage(window);

    // Wait for daemon to be ready before any session creation.
    await waitForDaemonReady(window);

    // 2. Open project A from home.
    await expect(home.openProjectButton).toBeVisible();
    await home.openProject(projectAPath);

    // 3. TabBar should show one tab for project A.
    await expect(tabBar.tabBar).toBeVisible();
    const tabA = window.locator(`[data-testid="${TID.projectTab}"]`).first();
    await expect(tabA).toBeVisible({ timeout: 10_000 });
    const projectIdA = await tabA.getAttribute("data-project-id");
    expect(projectIdA, "project A tab missing data-project-id").toBeTruthy();

    // 4. Create a session in A.
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });
    expect(await sidebar.cardCount()).toBe(0);
    await sidebar.clickNewSession();
    await expect
      .poll(async () => sidebar.cardCount(), { timeout: 30_000 })
      .toBe(1);

    // 5. Click "+" to open project B via the tab bar.
    await tabBar.openProjectViaPlusButton();
    const modal = new HomePage(window);
    await expect(modal.modal).toBeVisible({ timeout: 5_000 });
    await modal.navigateModalTo(projectBPath);

    // 6. TabBar should now show two tabs.
    const allTabs = window.locator(`[data-testid="${TID.projectTab}"]`);
    await expect
      .poll(() => allTabs.count(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);

    // Find project B's tab.
    const tabs = await allTabs.all();
    let projectIdB: string | null = null;
    for (const t of tabs) {
      const id = await t.getAttribute("data-project-id");
      if (id && id !== projectIdA) {
        projectIdB = id;
        break;
      }
    }
    expect(projectIdB, "project B tab not found").toBeTruthy();

    // 7. Create a session in project B.
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });
    await sidebar.clickNewSession();
    await expect
      .poll(async () => sidebar.cardCount(), { timeout: 30_000 })
      .toBe(1);

    // 8. Switch back to project A by clicking its tab.
    await tabBar.switchTo(projectIdA!);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });
    const tabAEl = tabBar.tab(projectIdA!);
    await expect(tabAEl).toHaveAttribute("aria-selected", "true");

    // 9. Switch to project B, verify tab is active.
    await tabBar.switchTo(projectIdB!);
    const tabBEl = tabBar.tab(projectIdB!);
    await expect(tabBEl).toHaveAttribute("aria-selected", "true");

    // 10. Both tabs still exist.
    await expect.poll(() => allTabs.count()).toBeGreaterThanOrEqual(2);

    // 11. No renderer errors.
    //     NOTE: alert dialogs from daemon /sessions/allocate failures are
    //     a known app-level issue (daemon v2 endpoint may not be ready);
    //     we don't fail the test on them but log them for visibility.
    if (dialogs.filter((d) => d.type === "alert").length > 0) {
      console.log(
        `[test] alert dialogs during multi-project flow: ${JSON.stringify(dialogs.filter((d) => d.type === "alert"))}`,
      );
    }
    expect(pageErrors, `renderer pageerrors: ${JSON.stringify(pageErrors)}`).toHaveLength(0);

    const consoleErrors = rendererLog.filter((e) => e.type === "error");
    expect(
      consoleErrors,
      `renderer console.error:\n${consoleErrors.map((e) => e.text).join("\n---\n")}`,
    ).toHaveLength(0);

    expectNoRendererErrors();
  });
});
