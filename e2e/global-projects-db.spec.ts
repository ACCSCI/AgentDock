/**
 * Global projects DB E2E spec.
 *
 * Reproduces the user-reported bug:
 *   1. Project has existing worktree dirs on disk (.agentdock/worktrees/*)
 *   2. After switching to the project, sidebar shows no sessions
 *   3. Clicking "New Session" throws: "no such table: main.projects"
 *
 * Root cause: after migration v9 drops the `projects` table from per-project
 * DBs, some code path still queries `schema.projects` via `getDb()` (the
 * per-project DB handle) instead of `getGlobalDb()` (the global DB).
 *
 * After the fix:
 *   - Disk worktrees sync into the sessions table
 *   - sessions:create works without "no such table" errors
 *   - New session card appears in sidebar
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures/electron-fixture";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";

function prepareGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execSync("git init -q -b main", { cwd: dir });
  execSync(
    'git -c user.email=e2e@local -c user.name=E2E commit --allow-empty -q -m init',
    { cwd: dir, stdio: "pipe" },
  );
}

function writeEmptyConfig(dir: string): void {
  writeFileSync(
    join(dir, "agentdock.config.yaml"),
    `version: "1"\nresources:\n  sync: []\nhooks: {}\n`,
    "utf-8",
  );
}

/** Create a fake worktree directory under .agentdock/worktrees/<id> */
function createFakeWorktree(
  projectPath: string,
  sessionId: string,
  branch: string,
): void {
  const wtDir = join(projectPath, ".agentdock", "worktrees", sessionId);
  mkdirSync(wtDir, { recursive: true });

  // Write a valid .git file (git worktree format)
  const gitDir = join(projectPath, ".git", "worktrees", sessionId);
  writeFileSync(join(wtDir, ".git"), `gitdir: ${gitDir}\n`, "utf-8");

  // Create minimal worktree content so isDirectoryComplete() returns true
  writeFileSync(join(wtDir, "package.json"), "{}", "utf-8");

  // Register the worktree in git's metadata
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`, "utf-8");
  writeFileSync(
    join(gitDir, "gitdir"),
    `${wtDir}/.git\n`,
    "utf-8",
  );
}

test.describe("Global projects DB — worktree sync and session creation", () => {
  test("disk worktrees sync to sidebar and sessions:create works", async ({
    window,
    dataDir,
    mainLog,
    dialogs,
  }) => {
    const projectPath = join(dataDir, "global-db-test");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);

    // Create 2 fake worktrees on disk BEFORE opening the project,
    // simulating worktrees left over from a previous session or CLI usage.
    createFakeWorktree(projectPath, "aaa11111-aaa", "agentdock/aaa11111-aaa");
    createFakeWorktree(projectPath, "bbb22222-bbb", "agentdock/bbb22222-bbb");

    // Verify worktrees exist on disk
    expect(existsSync(join(projectPath, ".agentdock", "worktrees", "aaa11111-aaa", ".git"))).toBe(true);
    expect(existsSync(join(projectPath, ".agentdock", "worktrees", "bbb22222-bbb", ".git"))).toBe(true);

    // Open the project in Electron
    const home = new HomePage(window);
    await home.openProject(projectPath);

    const sidebar = new SidebarPage(window);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 15_000 });

    // Wait for initial sync to complete — poll instead of flat wait
    // because syncProject does async daemon takeover (~6s) then
    // React Query re-fetches after invalidateQueries.
    const syncLines = mainLog.filter((l) =>
      /syncProject|inserted disk|projects:create|projects:list|table:.*projects|seed migration|user_version/.test(l)
    );

    await expect
      .poll(async () => {
        const count = await sidebar.cardCount();
        // Also log latest sync lines for debugging on failure
        const newSync = mainLog.filter((l) =>
          /syncProject|query results/.test(l)
        ).slice(-5);
        if (newSync.length > 0 && count === 0) {
          console.log("poll: count=0, sync logs:", newSync.join("\n"));
        }
        return count;
      }, { timeout: 30_000 })
      .toBeGreaterThanOrEqual(2);
  });

  test("session creation error message does not contain 'no such table'", async ({
    window,
    dataDir,
  }) => {
    const projectPath = join(dataDir, "global-db-error-test");
    prepareGitRepo(projectPath);
    writeEmptyConfig(projectPath);

    // Create 1 fake worktree
    createFakeWorktree(projectPath, "ccc33333-ccc", "agentdock/ccc33333-ccc");

    const home = new HomePage(window);
    await home.openProject(projectPath);

    const sidebar = new SidebarPage(window);
    await expect(sidebar.sidebar).toBeVisible({ timeout: 15_000 });

    // Wait for initial sync
    await expect
      .poll(async () => sidebar.cardCount(), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(1);

    // Track all console errors from the renderer
    const consoleErrors: string[] = [];
    window.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    // Try creating a session
    await sidebar.clickNewSession();

    // Wait a bit for async operations
    await window.waitForTimeout(5_000);

    // ASSERTION: No "no such table: main.projects" in console errors
    const tableErrors = consoleErrors.filter((e) =>
      e.includes("no such table") && e.includes("projects"),
    );
    expect(tableErrors).toEqual([]);
  });
});
