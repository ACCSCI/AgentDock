/**
 * Real-click OrphanCleanModal regression spec.
 *
 * Reproduces the user-reported "全选 (2) 已选 1 / 0 成功 1 失败" sequence:
 *
 *   1. Project has 2 dangling agentdock/* branches (no DB row, no worktree
 *      dir). Master version is fine but Electron's OrphanCleanModal
 *      used to key the selection Set by `worktreePath` — branches have
 *      empty worktreePath, so two branches collapsed to one Set entry.
 *   2. handleDelete then sent `paths: [""]` which the
 *      worktree:deleteOrphans handler rejected with a prefix-validation
 *      failure → "0 成功 1 失败" alert with no detail.
 *
 * After the fix:
 *   - selected count tracks each branch independently (key = "branch:<name>")
 *   - handleDelete splits selection into {paths, branches} before sending
 *   - both branches are deleted
 *
 * Also covers a mixed dir+branch scenario to keep both code paths
 * exercised together.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/electron-fixture";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";

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

function listAgentdockBranches(projectPath: string): string[] {
  const out = execFileSync(
    "git",
    ["branch", "--list", "agentdock/*"],
    { cwd: projectPath, encoding: "utf-8" },
  );
  return out
    .split(/\r?\n/)
    .map((l) => l.replace(/^[*+]?\s+/, "").trim())
    .filter(Boolean);
}

test.describe("OrphanCleanModal real clicks", () => {
  test("two orphan branches: 全选 = 已选 2, delete clears both", async ({
    window,
    dataDir,
    dialogs,
  }) => {
    const projectPath = join(dataDir, "orphan-ui-project");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);

    // Create two dangling agentdock/* branches BEFORE opening the
    // project so the orphan scan sees them on first render.
    execFileSync("git", ["branch", "agentdock/abandoned-A", "main"], { cwd: projectPath });
    execFileSync("git", ["branch", "agentdock/abandoned-B", "main"], { cwd: projectPath });

    const home = new HomePage(window);
    await home.openProject(projectPath);

    const sidebar = new SidebarPage(window);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });

    // Open the orphan modal via the 🧹 icon-sidebar button.
    await window.locator('[data-testid="open-orphan-modal"]').click();
    const modal = window.locator('[data-testid="orphan-modal"]');
    await expect(modal).toBeVisible();

    // Two orphan rows show up, both with reason="orphan-branch".
    const items = window.locator('[data-testid="orphan-item"]');
    await expect.poll(() => items.count(), { timeout: 10_000 }).toBe(2);
    for (let i = 0; i < 2; i++) {
      await expect(items.nth(i)).toHaveAttribute("data-orphan-reason", "orphan-branch");
    }

    // ★ The bug repro: click "全选" — counter should read 已选 2.
    //   Old code collapsed both branches to one Set key (both share
    //   empty worktreePath) and counter said 已选 1.
    await window.locator('[data-testid="orphan-select-all"]').click();
    const countSpan = window.locator('[data-testid="orphan-selected-count"]');
    await expect(countSpan).toHaveText("已选 2");

    // Click delete.
    await window.locator('[data-testid="orphan-delete-selected"]').click();

    // Dialogs go through the fixture's auto-accept. On the broken
    // version this would have been "0 成功, 1 失败". On the fixed
    // version we expect NO alert (because failed.length === 0).
    await expect.poll(() => items.count(), { timeout: 10_000 }).toBe(0);

    // Cross-check via git itself: both dangling branches gone.
    const branches = listAgentdockBranches(projectPath);
    expect(branches).not.toContain("agentdock/abandoned-A");
    expect(branches).not.toContain("agentdock/abandoned-B");

    // The success path triggers no alert (modal stays open with empty
    // list). The failure path WOULD pop an alert; we capture them via
    // the fixture and assert none happened.
    const errorAlerts = dialogs.filter(
      (d) => d.type === "alert" && /失败/.test(d.message),
    );
    expect(
      errorAlerts,
      `unexpected delete-failure alerts: ${JSON.stringify(errorAlerts)}`,
    ).toHaveLength(0);
  });

  test("mixed: 1 dir orphan + 1 branch orphan, both selectable and deletable", async ({
    window,
    dataDir,
    dialogs,
  }) => {
    const projectPath = join(dataDir, "orphan-mixed");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);

    // 1 dangling branch
    execFileSync("git", ["branch", "agentdock/dangling", "main"], { cwd: projectPath });
    // 1 dir-only orphan (a folder under .agentdock/worktrees/ with no .git file)
    const fakeWtDir = join(projectPath, ".agentdock", "worktrees", "fake-orphan-dir");
    mkdirSync(fakeWtDir, { recursive: true });
    writeFileSync(join(fakeWtDir, "leftover.txt"), "stale file", "utf-8");

    const home = new HomePage(window);
    await home.openProject(projectPath);
    const sidebar = new SidebarPage(window);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 10_000 });

    await window.locator('[data-testid="open-orphan-modal"]').click();
    const modal = window.locator('[data-testid="orphan-modal"]');
    await expect(modal).toBeVisible();

    const items = window.locator('[data-testid="orphan-item"]');
    await expect.poll(() => items.count(), { timeout: 10_000 }).toBe(2);

    // One item per reason — proves keys don't collide across kinds.
    // The reason attribute sits ON the orphan-item itself, not a child,
    // so target by combined selector instead of `.filter({has:...})`.
    const dirItem = window.locator('[data-testid="orphan-item"][data-orphan-reason="no-git-file"]');
    const branchItem = window.locator('[data-testid="orphan-item"][data-orphan-reason="orphan-branch"]');
    await expect(dirItem).toHaveCount(1);
    await expect(branchItem).toHaveCount(1);

    await window.locator('[data-testid="orphan-select-all"]').click();
    await expect(window.locator('[data-testid="orphan-selected-count"]')).toHaveText("已选 2");

    await window.locator('[data-testid="orphan-delete-selected"]').click();
    await expect.poll(() => items.count(), { timeout: 15_000 }).toBe(0);

    // Both kinds gone on disk.
    const branches = listAgentdockBranches(projectPath);
    expect(branches).not.toContain("agentdock/dangling");
    const { existsSync } = await import("node:fs");
    expect(existsSync(fakeWtDir)).toBe(false);

    const errorAlerts = dialogs.filter(
      (d) => d.type === "alert" && /失败/.test(d.message),
    );
    expect(errorAlerts).toHaveLength(0);
  });
});
