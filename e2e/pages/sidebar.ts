import type { Page, Locator } from "@playwright/test";
import { TID } from "./testids";

/**
 * SessionSidebar — list of sessions on the left of the workspace.
 *
 * Each session card carries `data-session-id` so you can target it
 * by id rather than by render position.
 */
export class SidebarPage {
  constructor(private readonly page: Page) {}

  get sidebar(): Locator {
    return this.page.locator(`[data-testid="${TID.sessionSidebar}"]`);
  }

  card(sessionId: string): Locator {
    return this.page.locator(
      `[data-testid="${TID.sessionCard}"][data-session-id="${sessionId}"]`,
    );
  }

  get newSessionButton(): Locator {
    return this.page.locator(`[data-testid="${TID.newSession}"]`);
  }

  async clickNewSession(): Promise<void> {
    await this.newSessionButton.click();
  }

  /**
   * Wait for a session card to appear in the DOM. Useful after kicking
   * off `sessions:create`: the renderer optimistically inserts the row,
   * so the card should show up within ~200ms even before the worktree
   * is created.
   *
   * Accepts a string (exact match) or RegExp (pattern match against
   * data-session-id attribute).
   */
  async waitForCard(
    sessionId: string | RegExp,
    opts?: { timeout?: number },
  ): Promise<void> {
    const timeoutMs = opts?.timeout ?? 10_000;
    const base = this.page.locator(
      `[data-testid="${TID.sessionCard}"]`,
    );
    if (typeof sessionId === "string") {
      await this.card(sessionId).waitFor({
        state: "visible",
        timeout: timeoutMs,
      });
    } else {
      // RegExp — wait for any card to appear, then verify the attribute
      await base.first().waitFor({ state: "visible", timeout: timeoutMs });
      // Verify at least one card's data-session-id matches the pattern
      const ids = await base.evaluateAll((els) =>
        els.map((e) => e.getAttribute("data-session-id")),
      );
      const matched = ids.some((id) => id !== null && sessionId.test(id));
      if (!matched) {
        throw new Error(
          `waitForCard: no session card with data-session-id matching ${sessionId}. Found: ${JSON.stringify(ids)}`,
        );
      }
    }
  }

  /**
   * Return the data-session-id of the first visible session card.
   */
  async firstCardId(): Promise<string> {
    const base = this.page.locator(
      `[data-testid="${TID.sessionCard}"][data-session-id]`,
    );
    await base.first().waitFor({ state: "visible", timeout: 10_000 });
    const id = await base.first().getAttribute("data-session-id");
    if (!id) throw new Error("firstCardId: first card has no data-session-id");
    return id;
  }

  async cardCount(): Promise<number> {
    return await this.page.locator(`[data-testid="${TID.sessionCard}"]`).count();
  }
}
