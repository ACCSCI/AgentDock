import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
/**
 * E2E Test: Duplicate project prevention
 *
 * Tests that opening the same project directory twice doesn't create
 * a duplicate project tab. Instead, it should navigate to the existing tab.
 *
 * Each test uses isolated project directories and cleans up after itself.
 */
import { expect, test } from "./fixtures/electron-fixture";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";

/**
 * Create a temporary git project for testing.
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

test.describe("Duplicate project prevention", () => {
  let projectPath: string;
  const projectName = "e2e-duplicate-test";

  test.beforeEach(() => {
    projectPath = createTempProject(projectName);
  });

  test.afterEach(async ({ window }) => {
    cleanupTempProject(projectPath);

    // Also clean up the project from the database
    // Use the window to call the delete project API
    try {
      const projectNameShort = projectName;
      const projects = await window.evaluate(async () => {
        const result = await (window as any).api.db.projects.list();
        return result;
      });

      // Find and delete the test project
      for (const project of projects) {
        if (project.name === projectNameShort || project.path === projectPath) {
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

  test("opening same project twice should not create duplicate tab", async ({ window }) => {
    const home = new HomePage(window);
    const sidebar = new SidebarPage(window);

    // Open the project first time
    await home.openProject(projectPath);

    // Wait for sidebar to be visible
    await sidebar.sidebar.waitFor({ state: "visible", timeout: 15000 });
    await window.waitForTimeout(2000);

    // Count tabs with this project name
    const projectNameShort = projectName;
    const tabsWithProject = window
      .locator(`[data-testid="project-tab"]`)
      .filter({ hasText: projectNameShort });
    const tabCountAfterFirst = await tabsWithProject.count();
    console.log(`Tabs with project name after first open: ${tabCountAfterFirst}`);

    // Should have exactly 1 tab for this project
    expect(tabCountAfterFirst).toBe(1);

    // Now try to open the same project again
    // Click the "+" button to open new project
    const addTabBtn = window.locator('[data-testid="new-project"]');
    await expect(addTabBtn).toBeVisible();
    await addTabBtn.click();

    // Navigate to the same project
    await home.navigateModalTo(projectPath);

    // Wait for navigation
    await window.waitForTimeout(2000);

    // Count tabs with this project name again
    const tabCountAfterSecond = await tabsWithProject.count();
    console.log(`Tabs with project name after second open: ${tabCountAfterSecond}`);

    // Should still have exactly 1 tab - no duplicate
    expect(tabCountAfterSecond).toBe(1);

    // Verify we're on the same project (sidebar should be visible)
    await sidebar.sidebar.waitFor({ state: "visible", timeout: 5000 });
  });

  test("opening project with different path format should not create duplicate", async ({
    window,
  }) => {
    const home = new HomePage(window);
    const sidebar = new SidebarPage(window);

    // Open the project first time
    await home.openProject(projectPath);

    // Wait for sidebar to be visible
    await sidebar.sidebar.waitFor({ state: "visible", timeout: 15000 });
    await window.waitForTimeout(2000);

    // Count tabs with this project name
    const projectNameShort = projectName;
    const tabsWithProject = window
      .locator(`[data-testid="project-tab"]`)
      .filter({ hasText: projectNameShort });
    const tabCountAfterFirst = await tabsWithProject.count();
    console.log(`Tabs with project name after first open: ${tabCountAfterFirst}`);
    expect(tabCountAfterFirst).toBe(1);

    // Now try to open the same project with a slightly different path
    // (e.g., with trailing slash)
    const pathWithSlash = `${projectPath}\\`;
    console.log(`Opening with different path format: ${pathWithSlash}`);

    // Click the "+" button to open new project
    const addTabBtn = window.locator('[data-testid="new-project"]');
    await expect(addTabBtn).toBeVisible();
    await addTabBtn.click();

    // Navigate to the same project with different path format
    await home.navigateModalTo(pathWithSlash);

    // Wait for navigation
    await window.waitForTimeout(2000);

    // Count tabs with this project name again
    const tabCountAfterSecond = await tabsWithProject.count();
    console.log(`Tabs with project name after second open: ${tabCountAfterSecond}`);

    // Should still have exactly 1 tab - no duplicate
    expect(tabCountAfterSecond).toBe(1);
  });
});
