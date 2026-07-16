import type { Locator, Page } from "@playwright/test";
import { TID } from "./testids";

/**
 * Home page: empty-state "open project" button + the dir-browser modal.
 *
 * Typical flow:
 *   await new HomePage(window).openProject("C:/tmp/.../my-project");
 *
 * The modal lists dirs one level at a time. We dbl-click each path
 * segment to drill in, then single-click the final basename to select
 * and click confirm. Targeting by NAME (textContent of `.dir-entry-name`)
 * avoids the cross-OS path-separator gotcha — CSS selectors with `\` are
 * fragile, and Node's `join()` returns backslashes on Windows.
 */
export class HomePage {
  constructor(private readonly page: Page) {}

  get openProjectButton(): Locator {
    return this.page.locator(`[data-testid="${TID.homeOpenProject}"]`);
  }

  get modal(): Locator {
    return this.page.locator(`[data-testid="${TID.dirModal}"]`);
  }

  /**
   * Click the "open project" button and drill the dir-browser modal to
   * the given absolute path, selecting the final segment + confirming.
   *
   * Steps:
   *   1. Click home-open-project (modal opens)
   *   2. For each path segment except the last: dbl-click the entry
   *      whose `.dir-entry-name` matches the segment name
   *   3. For the last segment: single-click (select), then click confirm
   *
   * Quirk: drive letters on Windows are listed with a trailing
   * backslash (e.g. "C:\\") — strip and re-add as needed.
   */
  async openProject(absolutePath: string): Promise<void> {
    await this.openProjectButton.click();
    await this.modal.waitFor({ state: "visible" });

    const segments = absolutePath.split(/[\\/]/).filter((s) => s.length > 0 && s !== ".");
    if (segments.length === 0) throw new Error(`Empty path: ${absolutePath}`);

    // On Windows the first segment is the drive letter ("C:"); the
    // modal lists it as "C:\".
    if (process.platform === "win32" && /^[A-Za-z]:$/.test(segments[0]!)) {
      segments[0] = `${segments[0]}\\`;
    }

    // Wait for the initial drive-listing to arrive before we start
    // drilling. Under load the IPC round-trip can exceed 5s (especially
    // when the test's data dir is on a different drive than the daemon's
    // home dir, or the daemon is busy with concurrent requests), so
    // give the first render up to 15s to settle.
    await this.waitForDirEntries(15_000);

    // Drill into every segment except the last using search to filter
    // entries, avoiding scroll/visibility issues in long directory listings.
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      const searchInput = this.page.locator(`[data-testid="${TID.dirSearchInput}"]`);
      await searchInput.fill(seg);
      // Wait for the new (filtered) directory listing. The filter is
      // synchronous, so 200ms is plenty for the React re-render; we
      // then re-assert with a generous timeout for the target entry.
      await this.page.waitForTimeout(200);
      const entry = this.entryByName(seg);
      await entry.waitFor({ state: "visible", timeout: 15_000 });
      await entry.dblclick();
      // Wait for the next directory to load via IPC.
      await this.waitForDirEntries(15_000);
    }

    // Select the last segment, then confirm.
    const last = segments[segments.length - 1]!;
    const searchInput = this.page.locator(`[data-testid="${TID.dirSearchInput}"]`);
    await searchInput.fill(last);
    await this.page.waitForTimeout(200);
    const target = this.entryByName(last);
    await target.waitFor({ state: "visible", timeout: 15_000 });
    await target.click();
    const confirm = this.page.locator(`[data-testid="${TID.dirConfirm}"]`);
    // Confirm is disabled until selection lands.
    await confirm.click();
    await this.modal.waitFor({ state: "hidden" });
  }

  /**
   * Block until at least one dir-entry is rendered in the modal. The
   * modal starts with `loading=true` and no entries; the IPC round-trip
   * for `fs:browseDirs` can take >5s under heavy test-suite load on
   * Windows, so we give it a generous timeout. We re-poll instead of
   * relying on the initial `.first()` because the search-input filter
   * can also produce zero entries while the user types.
   */
  private async waitForDirEntries(timeoutMs: number): Promise<void> {
    const entries = this.page.locator(`[data-testid="${TID.dirEntry}"]`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const count = await entries.count();
      if (count > 0) return;
      await this.page.waitForTimeout(100);
    }
    throw new Error(
      `dir modal: no entries rendered after ${timeoutMs}ms (modal hidden? ${await this.modal.isVisible().catch(() => false)})`,
    );
  }

  /**
   * Navigate the already-open dir-browser modal to the given path
   * without clicking the "open project" button. Use this when the
   * modal was opened externally (e.g., via the TabBar "+" button).
   *
   * Uses the search input to filter directories at each level, which
   * avoids scroll/visibility issues with long directory listings.
   */
  async navigateModalTo(absolutePath: string): Promise<void> {
    await this.modal.waitFor({ state: "visible" });
    const segments = absolutePath.split(/[\\/]/).filter((s) => s.length > 0 && s !== ".");
    if (segments.length === 0) throw new Error(`Empty path: ${absolutePath}`);

    if (process.platform === "win32" && /^[A-Za-z]:$/.test(segments[0]!)) {
      segments[0] = `${segments[0]}\\`;
    }

    // Wait for the initial listing before drilling.
    await this.waitForDirEntries(15_000);

    // Drill into every segment except the last using search to filter.
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      // Use search to filter the entry list.
      const searchInput = this.page.locator(`[data-testid="${TID.dirSearchInput}"]`);
      await searchInput.fill(seg);
      await this.page.waitForTimeout(200);
      const entry = this.entryByName(seg);
      await entry.waitFor({ state: "visible", timeout: 15_000 });
      await entry.dblclick();
      // Wait for the new directory to load.
      await this.waitForDirEntries(15_000);
    }

    // For the last segment, use search to find it, click to select, then confirm.
    const last = segments[segments.length - 1]!;
    const searchInput = this.page.locator(`[data-testid="${TID.dirSearchInput}"]`);
    await searchInput.fill(last);
    await this.page.waitForTimeout(200);
    const target = this.entryByName(last);
    await target.waitFor({ state: "visible", timeout: 15_000 });
    await target.click();
    const confirm = this.page.locator(`[data-testid="${TID.dirConfirm}"]`);
    await confirm.click();
    await this.modal.waitFor({ state: "hidden" });
  }

  private entryByName(name: string): Locator {
    // Match against the .dir-entry-name span's textContent; .dir-entry
    // is the row (data-testid="dir-entry").
    return this.page
      .locator(`[data-testid="${TID.dirEntry}"]`)
      .filter({
        has: this.page.locator(".dir-entry-name", {
          hasText: new RegExp(`^${escapeRegex(name)}$`),
        }),
      })
      .first();
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
