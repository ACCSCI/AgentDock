import AxeBuilder from "@axe-core/playwright";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures/electron-fixture";
import { HomePage } from "./pages/home";
import { SidebarPage } from "./pages/sidebar";

test.describe("UI acceptance", () => {
  test.beforeEach(async ({ window }) => {
    await window.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await window.evaluate(() => document.documentElement.setAttribute("data-test-motion", "off"));
    await window.evaluate(() => document.fonts.ready);
  });

  test("home has a stable visual baseline and no serious accessibility violations", async ({
    window,
    expectNoRendererErrors,
  }) => {
    await expect(window.getByTestId("home-page")).toBeVisible();
    await expect(window.getByRole("heading", { level: 1 })).toContainText("每个 Agent");
    await expect(window.getByRole("button", { name: "打开项目" })).toBeVisible();

    // Electron does not support BrowserContext.newPage(); legacy mode runs
    // axe entirely inside the existing renderer page.
    const results = await new AxeBuilder({ page: window }).setLegacyMode().analyze();
    const blocking = results.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact ?? ""),
    );
    expect(
      blocking,
      blocking.map((violation) => `${violation.id}: ${violation.help}`).join("\n"),
    ).toEqual([]);

    await expect(window).toHaveScreenshot("home-operator-console.png", {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.005,
    });
    expectNoRendererErrors();
  });

  test("primary navigation and project picker are keyboard operable", async ({ window }) => {
    const openProject = window.getByRole("button", { name: "打开项目" });
    await openProject.focus();
    await expect(openProject).toBeFocused();
    await window.keyboard.press("Enter");
    await expect(window.getByTestId("dir-modal")).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(window.getByTestId("dir-modal")).toBeHidden();
  });

  test("reduced motion mode preserves controls and content", async ({ window }) => {
    await expect(window.getByRole("button", { name: "打开项目" })).toBeEnabled();
    const durations = await window.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      return [
        styles.getPropertyValue("--motion-fast"),
        styles.getPropertyValue("--motion-normal"),
      ].map(Number.parseFloat);
    });
    expect(durations).toEqual([0, 0]);
  });

  test("settings uses semantic sections and passes the accessibility gate", async ({ window }) => {
    await window.getByRole("button", { name: /Settings|设置/ }).click();
    await expect(window.getByTestId("settings-page")).toBeVisible();
    await expect(window.getByRole("heading", { level: 1, name: "设置" })).toBeVisible();
    await expect(window.getByLabel("端口范围:")).toBeVisible();

    const results = await new AxeBuilder({ page: window }).setLegacyMode().analyze();
    const blocking = results.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact ?? ""),
    );
    expect(
      blocking,
      blocking.map((violation) => `${violation.id}: ${violation.help}`).join("\n"),
    ).toEqual([]);
  });

  test("config editor exposes a clear visual hierarchy and passes the accessibility gate", async ({
    window,
    dataDir,
  }) => {
    const projectPath = join(dataDir, "config-editor-acceptance");
    mkdirSync(projectPath, { recursive: true });
    execSync("git init -q -b main", { cwd: projectPath });
    execSync(
      "git -c user.email=e2e@local -c user.name=E2E commit --allow-empty -q -m init",
      { cwd: projectPath },
    );
    writeFileSync(
      join(projectPath, "agentdock.config.yaml"),
      'version: "1"\nresources:\n  sync: []\nhooks: {}\n',
      "utf8",
    );

    await new HomePage(window).openProject(projectPath);
    await expect(window.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(window.locator("main.config-editor")).toBeVisible();

    const results = await new AxeBuilder({ page: window }).setLegacyMode().analyze();
    const blocking = results.violations.filter((violation) =>
      ["critical", "serious"].includes(violation.impact ?? ""),
    );
    expect(
      blocking,
      blocking.map((violation) => `${violation.id}: ${violation.help}`).join("\n"),
    ).toEqual([]);
  });

  test("hook error dialog is reachable, labelled and keyboard dismissible", async ({
    window,
    dataDir,
  }) => {
    test.setTimeout(90_000);
    const projectPath = join(dataDir, "hook-error-dialog-acceptance");
    mkdirSync(projectPath, { recursive: true });
    execSync("git init -q -b main", { cwd: projectPath });
    execSync(
      "git -c user.email=e2e@local -c user.name=E2E commit --allow-empty -q -m init",
      { cwd: projectPath },
    );
    writeFileSync(join(projectPath, "failing-hook.js"), 'process.stderr.write("boom"); process.exit(7);', "utf8");
    writeFileSync(
      join(projectPath, "agentdock.config.yaml"),
      [
        'version: "1"',
        "resources:",
        "  sync: []",
        "hooks:",
        "  afterCreateSession:",
        '    - run: "node failing-hook.js"',
        "      required: false",
        "      timeout: 30000",
        "      async: true",
        "      cwd: project",
        "",
      ].join("\n"),
      "utf8",
    );

    await new HomePage(window).openProject(projectPath);
    const sidebar = new SidebarPage(window);
    await sidebar.clickNewSession();
    await expect.poll(() => sidebar.cardCount(), { timeout: 30_000 }).toBe(1);
    await window.getByTestId("session-card").first().click();

    const errorTrigger = window.getByRole("button", { name: "⚠ 查看失败日志", exact: true });
    await expect(errorTrigger).toBeVisible({ timeout: 30_000 });
    await errorTrigger.click();
    const dialog = window.getByRole("dialog", { name: "环境初始化失败" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("关闭", { exact: true })).toBeVisible();
    await window.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(errorTrigger).toBeFocused();
  });
});
