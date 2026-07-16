/**
 * Tab management E2E.
 *
 * Tests:
 *   1. Open project A, open project B via "+" button, verify both tabs visible.
 *   2. Switch between tabs.
 *   3. Close tab B, verify A is still active.
 *   4. Re-open B.
 *   5. Close A, verify home page renders when the last tab is closed.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures/electron-fixture";
import { waitForAppReady } from "./helpers/ipc";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";
import { TabBarPage } from "./pages/tab-bar";
import { TID } from "./pages/testids";

function prepareGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q -b main", { cwd: dir });
  execSync("git -c user.email=e2e@local -c user.name=E2E commit --allow-empty -q -m init", {
    cwd: dir,
  });
}

function writeEmptyConfig(dir: string): void {
  writeFileSync(
    join(dir, "agentdock.config.yaml"),
    `version: "1"\nresources:\n  sync: []\nhooks: {}\n`,
    "utf-8",
  );
}

test.describe("tab management", () => {
  test("open A -> open B via + -> verify both tabs -> switch -> close B -> re-open B -> close A -> home", async ({
    window,
    dataDir,
    pageErrors,
    rendererLog,
    expectNoRendererErrors,
  }) => {
    const projectAPath = join(dataDir, "tab-project-a");
    const projectBPath = join(dataDir, "tab-project-b");
    prepareGitRepo(projectAPath);
    writeEmptyConfig(projectAPath);
    prepareGitRepo(projectBPath);
    writeEmptyConfig(projectBPath);

    const home = new HomePage(window);
    const tabBar = new TabBarPage(window);
    const sidebar = new SidebarPage(window);

    await waitForAppReady(window);

    // 1. Open project A from the home page.
    await expect(home.openProjectButton).toBeVisible();
    await home.openProject(projectAPath);

    // Verify project A tab exists.
    await expect(tabBar.tabBar).toBeVisible();
    const tabA = window.locator(`[data-testid="${TID.projectTab}"]`).first();
    await expect(tabA).toBeVisible({ timeout: 10_000 });
    const projectIdA = await tabA.getAttribute("data-project-id");
    expect(projectIdA).toBeTruthy();

    // Sidebar for A should be visible.
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });

    // 2. Click "+" to open project B.
    await tabBar.openProjectViaPlusButton();
    await expect(home.modal).toBeVisible({ timeout: 5_000 });
    await home.navigateModalTo(projectBPath);

    // Both tabs should be visible.
    const allTabs = window.locator(`[data-testid="${TID.projectTab}"]`);
    await expect.poll(() => allTabs.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

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

    // 3. Verify B's sidebar is visible (we're now on B since it was just opened).
    await expect(sidebar.sidebar).toBeVisible({ timeout: 5_000 });

    // 4. Switch to A by clicking its tab.
    await tabBar.switchTo(projectIdA!);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 5_000 });
    // Verify A tab is now active.
    const tabAEl = tabBar.tab(projectIdA!);
    await expect(tabAEl).toHaveAttribute("aria-selected", "true");

    // 5. Switch back to B.
    await tabBar.switchTo(projectIdB!);
    const tabBEl = tabBar.tab(projectIdB!);
    await expect(tabBEl).toHaveAttribute("aria-selected", "true");

    // 6. Close tab B.
    await tabBar.closeTabFor(projectIdB!);
    await window.waitForTimeout(500);

    // Only one tab (A) should remain.
    await expect.poll(() => allTabs.count(), { timeout: 5_000 }).toBe(1);

    // A's tab should still be visible and active.
    await expect(tabA).toBeVisible();
    await expect(tabA).toHaveAttribute("aria-selected", "true");

    // 7. Re-open project B via "+".
    await tabBar.openProjectViaPlusButton();
    await expect(home.modal).toBeVisible({ timeout: 5_000 });
    await home.navigateModalTo(projectBPath);

    // Two tabs should be visible again.
    await expect.poll(() => allTabs.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);

    // 8. Find the re-opened B's project ID.
    const tabsAfterReopen = await allTabs.all();
    let projectIdBReopened: string | null = null;
    for (const t of tabsAfterReopen) {
      const id = await t.getAttribute("data-project-id");
      if (id && id !== projectIdA) {
        projectIdBReopened = id;
        break;
      }
    }
    expect(projectIdBReopened).toBeTruthy();

    // 9. Close tab A.
    await tabBar.closeTabFor(projectIdA!);
    await window.waitForTimeout(500);

    // Only B's tab should remain (or we should be on home).
    const remainingTabs = await allTabs.count();
    expect(remainingTabs).toBeGreaterThanOrEqual(1);

    // 10. Close the last remaining tab (B).
    const lastTab = window.locator(`[data-testid="${TID.projectTab}"]`).first();
    await lastTab.locator(`[data-testid="${TID.projectTabClose}"]`).click();
    await window.waitForTimeout(1000);

    // Home page should render (the "open project" button should appear).
    const homePageBtn = window.locator(`[data-testid="${TID.homeOpenProject}"]`);
    await expect(homePageBtn).toBeVisible({ timeout: 10_000 });

    // No renderer errors.
    expect(pageErrors).toHaveLength(0);
    // Filter out expected font CORS errors — the agentdock-fonts://
    // protocol may not resolve in test environments where fonts
    // haven't been downloaded yet. These are benign.
    const consoleErrors = rendererLog.filter(
      (e) =>
        e.type === "error" &&
        !e.text.includes("agentdock-fonts://") &&
        !(e.location?.url || "").includes("agentdock-fonts://") &&
        !e.text.includes("net::ERR_FAILED"),
    );
    expect(consoleErrors).toHaveLength(0);
    expectNoRendererErrors();
  });
});
