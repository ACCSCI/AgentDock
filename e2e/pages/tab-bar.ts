import type { Page, Locator } from "@playwright/test";
import { TID } from "./testids";

/**
 * TabBar — the strip of open-project tabs at the top of the app.
 *
 * Each tab has `data-project-id` so you can target a specific one
 * without depending on its render order.
 */
export class TabBarPage {
  constructor(private readonly page: Page) {}

  get tabBar(): Locator {
    return this.page.locator(`[data-testid="${TID.tabBar}"]`);
  }

  tab(projectId: string): Locator {
    return this.page.locator(
      `[data-testid="${TID.projectTab}"][data-project-id="${projectId}"]`,
    );
  }

  closeTab(projectId: string): Locator {
    return this.tab(projectId).locator(`[data-testid="${TID.projectTabClose}"]`);
  }

  get newProjectButton(): Locator {
    return this.page.locator(`[data-testid="${TID.newProject}"]`);
  }

  async switchTo(projectId: string): Promise<void> {
    await this.tab(projectId).click();
  }

  async closeTabFor(projectId: string): Promise<void> {
    await this.closeTab(projectId).click();
  }

  async openProjectViaPlusButton(): Promise<void> {
    await this.newProjectButton.click();
  }
}
