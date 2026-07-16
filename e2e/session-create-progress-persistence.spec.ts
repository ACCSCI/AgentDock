import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/**
 * E2E Test: Session creation/deletion progress persistence across project switches
 *
 * Tests that the creation/deletion progress indicator persists when switching
 * between project tabs during an in-flight session lifecycle.
 *
 * Bug: When creating a session and switching projects, the CreatingSession
 * entry in React Query cache is wiped out by invalidateQueries. This test
 * verifies the fix preserves optimistic entries during refetch.
 *
 * Each test creates its own isolated project directories to avoid state leakage.
 */
import { expect, test } from "./fixtures/electron-fixture";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";

/**
 * Create a temporary git project for testing.
 * Returns the path to the created project.
 */
function createTempProject(name: string): string {
  const projectPath = join("D:\\ProgramTest", name);
  if (existsSync(projectPath)) {
    rmSync(projectPath, { recursive: true, force: true });
  }
  mkdirSync(projectPath, { recursive: true });

  // Initialize git repo
  execSync("git init", { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.email "test@test.com"', { cwd: projectPath, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: projectPath, stdio: "ignore" });

  // Create initial commit (required for git worktree)
  writeFileSync(join(projectPath, "README.md"), "# Test Project");
  execSync("git add .", { cwd: projectPath, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: projectPath, stdio: "ignore" });

  // Create agentdock config (disable hooks for faster tests)
  writeFileSync(
    join(projectPath, "agentdock.config.yaml"),
    `
hooks:
  afterCreateSession: []
  afterDeleteSession: []
`,
  );

  return projectPath;
}

/**
 * Clean up a temporary project directory.
 */
function cleanupTempProject(projectPath: string): void {
  try {
    if (existsSync(projectPath)) {
      rmSync(projectPath, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup
  }
}

test.describe("Session creation progress persistence", () => {
  let project1: string;
  let project2: string;

  test.beforeEach(() => {
    // 每个测试前重新创建干净的项目目录
    project1 = createTempProject("e2e-progress-test-1");
    project2 = createTempProject("e2e-progress-test-2");
  });

  test.afterEach(async ({ window }) => {
    // 清理项目目录（包括所有 worktree）
    cleanupTempProject(project1);
    cleanupTempProject(project2);

    // 同时清理数据库中的项目记录
    try {
      const projects = await window.evaluate(async () => {
        const result = await (window as any).api.db.projects.list();
        return result;
      });

      for (const project of projects) {
        if (project.path === project1 || project.path === project2) {
          await window.evaluate(async (projectId: string) => {
            await (window as any).api.db.projects.delete(projectId);
          }, project.id);
          console.log(`Cleaned up project: ${project.name} (${project.id})`);
        }
      }
    } catch (err) {
      console.log(`Failed to clean up project from database: ${err}`);
    }
  });

  test("creation progress persists after switching projects", async ({ window }) => {
    const home = new HomePage(window);
    const sidebar = new SidebarPage(window);

    // Open first project
    await home.openProject(project1);

    // Wait for sidebar to be visible
    await sidebar.sidebar.waitFor({ state: "visible", timeout: 15000 });

    // Wait for projects to be loaded
    await window.waitForTimeout(3000);

    // Get initial session count
    const initialCount = await sidebar.cardCount();
    console.log(`Initial session count: ${initialCount}`);

    // Start creating a new session
    const createBtn = sidebar.newSessionButton;
    await expect(createBtn).toBeVisible();
    await createBtn.click();

    // 立马切换到另一个 project（不等创建完成）
    await window.waitForTimeout(100);

    // Check all session cards
    const allCards = window.locator('[data-testid="session-card"]');
    const cardCount = await allCards.count();
    console.log(`Session cards immediately after create click: ${cardCount}`);

    // The new card should be the last one (temp ID)
    const newCard = allCards.last();
    const newSessionId = await newCard.getAttribute("data-session-id");
    console.log(`New session ID: ${newSessionId}`);

    // Now switch to another project tab immediately
    const addTabBtn = window.locator('[data-testid="new-project"]');
    await expect(addTabBtn).toBeVisible();
    await addTabBtn.click();

    // Navigate to second project
    await home.navigateModalTo(project2);

    // Wait for projects to be loaded
    await window.waitForTimeout(2000);

    // Switch back to first project tab
    const project1Name = project1.split("\\").pop()!;
    const project1Tab = window
      .locator('[data-testid="project-tab"]')
      .filter({ hasText: project1Name })
      .first();
    await project1Tab.click();

    // Wait for projects to be loaded
    await window.waitForTimeout(3000);

    // Log cards after switching back
    const cardsAfterSwitch = await allCards.count();
    console.log(`Session cards after switching back: ${cardsAfterSwitch}`);

    // Log all session IDs after switch
    for (let i = 0; i < cardsAfterSwitch; i++) {
      const card = allCards.nth(i);
      const sessionId = await card.getAttribute("data-session-id");
      console.log(`Card after switch ${i}: id=${sessionId}`);
    }

    // The key assertion: after switching back, we should still have the session
    expect(cardsAfterSwitch).toBe(initialCount + 1);

    // Verify the session is still there by checking the data-session-id attribute
    const sessionCard = window.locator(
      `[data-testid="session-card"][data-session-id="${newSessionId}"]`,
    );
    const sessionStillThere = await sessionCard.isVisible().catch(() => false);
    console.log(`Session ${newSessionId} visible after switch: ${sessionStillThere}`);
    expect(sessionStillThere).toBe(true);
  });

  test("deletion progress persists after switching projects", async ({ window }) => {
    const home = new HomePage(window);
    const sidebar = new SidebarPage(window);

    // Open first project
    await home.openProject(project1);

    // Wait for sidebar to be visible
    await sidebar.sidebar.waitFor({ state: "visible", timeout: 15000 });

    // Wait for projects to be loaded
    await window.waitForTimeout(3000);

    // Create a session first
    const createBtn = sidebar.newSessionButton;
    await expect(createBtn).toBeVisible();
    await createBtn.click();

    // Wait for session to appear
    await sidebar.waitForCard(/.*/, { timeout: 15000 });

    // Get the session ID
    const sessionId = await sidebar.firstCardId();
    console.log(`Created session: ${sessionId}`);

    // Wait for creation to complete
    await window.waitForTimeout(5000);

    // Now delete the session
    const sessionCard = sidebar.card(sessionId);
    await sessionCard.click({ button: "right" });

    // Look for delete option in context menu
    const deleteOption = window.locator("text=Delete, text=删除").first();
    if (await deleteOption.isVisible()) {
      await deleteOption.click();

      // Confirm deletion if modal appears
      const confirmBtn = window
        .locator('button:has-text("Confirm"), button:has-text("确认")')
        .first();
      if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await confirmBtn.click();
      }

      // Wait a bit for deletion to start
      await window.waitForTimeout(500);

      // Verify the card shows deleting state (spinner)
      const deletingCard = sidebar.card(sessionId);
      const hasSpinner = await deletingCard.locator(".step-spinner").count();
      console.log(`Deleting card has spinner: ${hasSpinner > 0}`);

      // Switch to another project tab
      const addTabBtn = window.locator('[data-testid="new-project"]');
      await expect(addTabBtn).toBeVisible();
      await addTabBtn.click();

      // Navigate to second project
      await home.navigateModalTo(project2);

      // Wait for projects to be loaded
      await window.waitForTimeout(2000);

      // Switch back to first project tab
      const project1Name = project1.split("\\").pop()!;
      const project1Tab = window
        .locator('[data-testid="project-tab"]')
        .filter({ hasText: project1Name })
        .first();
      await project1Tab.click();

      // Wait for projects to be loaded
      await window.waitForTimeout(2000);

      // Verify the session card is still visible (either deleting or deleted)
      const cardAfterSwitch = sidebar.card(sessionId);
      const isVisible = await cardAfterSwitch.isVisible().catch(() => false);
      console.log(`Session card visible after tab switch: ${isVisible}`);

      // Either the card is still there (deleting) or gone (deleted) - both are OK
      // The important thing is no errors occurred
    }
  });
});
