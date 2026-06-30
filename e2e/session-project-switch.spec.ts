/**
 * E2E Test: Session creation with project switching
 *
 * Tests that session state persists when switching between projects
 */
import { test, expect } from "./fixtures/electron-fixture";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";

// Test projects created in D:\ProgramTest
const PROJECT_1 = "D:\\ProgramTest\\e2e-test-project";
const PROJECT_2 = "D:\\ProgramTest\\e2e-test-project-2";

test.describe("Session state persistence", () => {
  test("session persists after switching projects", async ({
    window,
    dataDir,
    pageErrors,
    dialogs,
    rendererLog,
    expectNoRendererErrors,
  }) => {
    const home = new HomePage(window);
    const sidebar = new SidebarPage(window);

    // Open first project
    await home.openProject(PROJECT_1);

    // Wait for sidebar to be visible
    await sidebar.sidebar.waitFor({ state: "visible", timeout: 15000 });

    // Wait for projects to be loaded
    await window.waitForTimeout(3000);

    // Create a new session
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

    // Open second project in a new tab
    const addTabBtn = window.locator('[data-testid="new-project"]');
    await expect(addTabBtn).toBeVisible();
    await addTabBtn.click();

    // Navigate to second project
    await home.navigateModalTo(PROJECT_2);

    // Wait for projects to be loaded
    await window.waitForTimeout(3000);

    // Switch back to first project tab
    const tabs = window.locator('[data-testid="project-tab"]');
    await tabs.first().click();

    // Wait for projects to be loaded
    await window.waitForTimeout(3000);

    // Check if session is still visible
    const sessionCard = sidebar.card(sessionId);
    const isVisible = await sessionCard.isVisible().catch(() => false);

    if (isVisible) {
      console.log(`✓ Session ${sessionId} is still visible after tab switch`);
    } else {
      // Check if there are any sessions in the sidebar
      const cardCount = await sidebar.cardCount();
      console.log(`Sessions in sidebar: ${cardCount}`);

      // This is expected to fail until the bug is fixed
      expect(isVisible).toBe(true);
    }
  });
});
