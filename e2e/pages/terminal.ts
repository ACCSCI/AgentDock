import type { Page, Locator } from "@playwright/test";
import { TID } from "./testids";

export type TerminalStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "exited";

/**
 * TerminalManager + SessionTerminal — the xterm-hosting right pane.
 *
 * `<div data-testid="session-terminal" data-status="...">` is the
 * authoritative "what state is this terminal in" signal. xterm renders
 * to a canvas, so Playwright cannot assert on textual output directly
 * — drive input through the IPC helpers in e2e/helpers/ipc.ts and
 * observe state via `data-status`.
 */
export class TerminalPage {
  constructor(private readonly page: Page) {}

  get panel(): Locator {
    return this.page.locator(`[data-testid="${TID.terminalPanel}"]`);
  }

  get newTerminalButton(): Locator {
    return this.page.locator(`[data-testid="${TID.newTerminal}"]`);
  }

  tab(terminalId: string): Locator {
    return this.page.locator(
      `[data-testid="${TID.terminalTab}"][data-terminal-id="${terminalId}"]`,
    );
  }

  /**
   * Currently-rendered SessionTerminal locator. There can be at most
   * one mounted at a time (the inactive ones go to the "graveyard"
   * off-screen div).
   */
  get currentTerminal(): Locator {
    return this.page.locator(`[data-testid="${TID.sessionTerminal}"]`).first();
  }

  /**
   * Wait until the current terminal reports the given status. Default
   * status is `connected` (the success signal for PTY readiness).
   */
  async waitForStatus(
    status: TerminalStatus = "connected",
    timeoutMs = 10_000,
  ): Promise<void> {
    await this.currentTerminal.waitFor({ state: "visible", timeout: timeoutMs });
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const current = await this.currentTerminal.getAttribute("data-status");
      if (current === status) return;
      await this.page.waitForTimeout(100);
    }
    const actual = await this.currentTerminal.getAttribute("data-status");
    throw new Error(
      `TerminalPage.waitForStatus("${status}") timed out; final data-status="${actual ?? "<null>"}"`,
    );
  }

  async clickNewTerminal(): Promise<void> {
    await this.newTerminalButton.click();
  }
}
