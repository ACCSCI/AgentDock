// @ts-nocheck
/**
 * Standalone verification — directly uses the pre-built out/ directory.
 * Skips the fixture's electron-vite build step.
 */
import { test, expect } from "@playwright/test";
import { _electron as electron } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DATA = join(ROOT, ".user-simulator", "runs", "verify-standalone", "userdata");
mkdirSync(DATA, { recursive: true });

test.describe("round-1 fix verification (standalone)", () => {
  let app: import("@playwright/test").ElectronApplication;
  let window: import("@playwright/test").Page;

  test.beforeAll(async () => {
    app = await electron.launch({
      args: ["out/main/main.js"],
      cwd: ROOT,
      env: {
        ...process.env,
        FRONTEND_PORT: "5173",
        AGENTDOCK_DEV_INSTANCE: "standalone",
        AGENTDOCK_USE_BUN: "1",
        NODE_OPTIONS: "--experimental-sqlite",
        NODE_ENV: "test",
        AGENTDOCK_V2: "1",
        ELECTRON_DISABLE_GPU: "1",
        AGENTDOCK_DATA_DIR: DATA,
      },
      timeout: 60_000,
    });
    window = await app.firstWindow({ timeout: 60_000 });
    await window.waitForLoadState("domcontentloaded");
    await window.waitForFunction(() => typeof window.api === "object", null, { timeout: 20_000 });
  });

  test.afterAll(async () => {
    if (app) await app.close();
  });

  test("__root: main has id='main-content'", async () => {
    await window.waitForTimeout(2000);
    const mainId = await window.evaluate(() => document.querySelector("main")?.id ?? null);
    expect(mainId).toBe("main-content");
  });

  test("DirBrowserModal: search input has id + aria-label", async () => {
    await window.click("[data-testid=home-open-project]");
    await window.waitForSelector('[data-testid="dir-modal"]', { timeout: 5000 });
    const input = await window.evaluate(() => {
      const el = document.querySelector('[data-testid="dir-search-input"]');
      return { id: el?.id ?? "", aria: el?.getAttribute("aria-label") ?? "" };
    });
    expect(input.id, "search input must have id").not.toBe("");
    expect(input.aria, "search input must have aria-label").not.toBe("");
    await window.keyboard.press("Escape");
  });

  test("DirBrowserModal: focus not lost to body on Escape", async () => {
    await window.evaluate(() => document.querySelector("main")?.focus?.());
    await window.click("[data-testid=home-open-project]");
    await window.waitForSelector('[data-testid="dir-modal"]', { timeout: 5000 });
    await window.keyboard.press("Escape");
    await window.waitForTimeout(500);
    const tag = await window.evaluate(() => document.activeElement?.tagName ?? "BODY");
    expect(tag, "focus must not land on BODY").not.toBe("BODY");
  });

  test("SessionCard: no role=button div with nested button", async () => {
    // Register a project via the modal
    await window.click("[data-testid=home-open-project]");
    await window.waitForSelector('[data-testid="dir-modal"]', { timeout: 5000 });
    await window.click('[data-testid="dir-entry"]');
    await window.waitForTimeout(300);
    await window.click("[data-testid=dir-confirm]");
    await window.waitForTimeout(4000);

    // Create session
    const nsBtn = await window.$("[data-testid=new-session]");
    if (nsBtn) {
      await nsBtn.click();
      for (let i = 0; i < 30; i++) {
        await window.waitForTimeout(1000);
        const ready = await window.$(".session-card:not(.session-card-creating):not(.session-card-failed)");
        if (ready) {
          const audit = await ready.evaluate((el) => {
            const role = el.getAttribute("role");
            const innerBtns = el.querySelectorAll("button");
            return { role, innerBtnCount: innerBtns.length };
          });
          expect(audit.role !== "button" || audit.innerBtnCount === 0,
            `role=${audit.role} card must not nest buttons`).toBe(true);
          break;
        }
      }
    }
  });

  test("ConfigEditor: inputs have id/label/aria", async () => {
    // Close any lingering modal first
    try { await window.keyboard.press("Escape"); await window.waitForTimeout(300); } catch {}
    // Click project tab to enter workspace
    await window.click("button:has-text('ui-shadcn-refactor')");
    await window.waitForTimeout(3000);

    const inputs = await window.evaluate(() =>
      Array.from(document.querySelectorAll('input, select')).map((el) => ({
        id: el.getAttribute("id") ?? "",
        hasLabel: !!el.closest("label"),
        aria: el.getAttribute("aria-label") ?? null,
      })),
    );
    const unlabelled = inputs.filter((i) => !i.id && !i.hasLabel && !i.aria);
    expect(unlabelled, `${unlabelled.length} inputs lack id/label/aria`).toHaveLength(0);
  });

  test("home: no static 'Git worktree ready'", async () => {
    // Reload to home
    await window.reload();
    await window.waitForFunction(() => typeof window.api === "object", null, { timeout: 10_000 });
    await window.waitForTimeout(2000);
    const text = await window.evaluate(() =>
      Array.from(document.querySelectorAll("*")).some((e) =>
        (e.textContent ?? "").trim() === "Git worktree ready",
      ),
    );
    expect(text, "'Git worktree ready' must not appear").toBe(false);
  });
});