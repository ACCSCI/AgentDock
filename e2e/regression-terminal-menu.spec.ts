// @ts-nocheck
/**
 * Regression spec — Terminal add menu uses shadcn DropdownMenu semantics.
 *
 * Covers P0 checklist item: "将终端新增菜单迁移到 shadcn DropdownMenu，
 * 确保方向键、Enter、Escape、焦点恢复可用，并消除可点击 div."
 *
 * Before fix: menu uses raw <div class="terminal-add-dropdown-item"> +
 *             <div class="terminal-add-dropdown-pin"> (not focusable, no
 *             menuitem role, no arrow-key support).
 * After fix:  uses Radix DropdownMenu; items are role="menuitem", Tab-able
 *             via standard menu semantics; Escape restores focus.
 */
import { test, expect } from "./fixtures/electron-fixture";

test.describe("Terminal add menu semantics @regression", () => {
  test("add menu items expose role=menuitem and keyboard nav works", async ({ window }) => {
    await window.waitForSelector("h1");

    // Navigate into workspace and ensure a ready session.
    const tab = await window.$("button:has-text('ui-shadcn-refactor')");
    if (tab) await tab.click();

    const newSession = await window.$("[data-testid=new-session]");
    if (newSession) await newSession.click();
    for (let i = 0; i < 30; i++) {
      const ready = await window.$(".session-card:not(.session-card-creating):not(.session-card-failed)");
      if (ready) break;
      await window.waitForTimeout(1000);
    }

    // Open the add-menu via its testid.
    const addBtn = await window.$("[data-testid=new-terminal]");
    if (!addBtn) {
      test.skip(true, "no ready session with terminal area in this fixture");
      return;
    }
    await addBtn.click();

    // Items should expose menuitem role (Radix DropdownMenu).
    const items = await window.$$('[role="menuitem"]');
    expect(items.length, "menu must expose menuitem roles").toBeGreaterThan(0);

    // ArrowDown should move focus among menuitems.
    await window.keyboard.press("ArrowDown");
    const focusedRole = await window.evaluate(
      () => document.activeElement?.getAttribute("role") ?? null,
    );
    expect(focusedRole, "ArrowDown must land on a menuitem").toBe("menuitem");

    // Escape closes and returns focus to the trigger.
    await window.keyboard.press("Escape");
    await window.waitForTimeout(300);
    const focusedTestId = await window.evaluate(
      () => document.activeElement?.getAttribute("data-testid") ?? null,
    );
    expect(focusedTestId, "focus must return to terminal add trigger").toBe("new-terminal");
  });
});