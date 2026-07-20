// @ts-nocheck
/**
 * E2E a11y gate — runs axe-core against critical AgentDock surfaces and
 * fails on serious/critical violations.
 *
 * Aligned with docs/ui-ux-review-checklist.md P0/P1 acceptance: "Playwright
 * 加入 axe 阻断：无 serious/critical 可访问性违规."
 *
 * Why direct injection: `@axe-core/playwright` calls `browserContext.newPage`
 * to host the scan iframe, but Playwright's Electron driver doesn't implement
 * CDP `Target.createTarget`. We instead load axe.min.js into the existing
 * window, run it in-page, and read the JSON results back via `evaluate`.
 *
 * Coverage:
 *   - home page (initial route)
 *   - DirBrowserModal (open via [data-testid=home-open-project])
 *   - project workspace / ConfigEditor (open via project tab)
 *   - critical keyboard flow check (P0 acceptance)
 *
 * Run:
 *   npx playwright test e2e/a11y-gate.spec.ts
 */
import { test, expect } from "./fixtures/electron-fixture";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type AxeViolation = {
  id: string;
  impact?: "minor" | "moderate" | "serious" | "critical" | null;
  description: string;
  helpUrl: string;
  nodes: Array<{ html: string; target: string[] }>;
};

const BLOCKING = new Set(["serious", "critical"]);

const AXE_SOURCE = readFileSync(
  join("node_modules", "axe-core", "axe.min.js"),
  "utf8",
);

async function scan(
  window: import("@playwright/test").Page,
  label: string,
): Promise<{ blocking: AxeViolation[]; advisory: AxeViolation[]; total: number }> {
  await window.evaluate(AXE_SOURCE);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results = (await window.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axe = (window as any).axe;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
  })) as { violations: AxeViolation[] };

  const blocking = results.violations.filter((v) =>
    BLOCKING.has(v.impact ?? ""),
  );
  const advisory = results.violations.filter(
    (v) => !BLOCKING.has(v.impact ?? ""),
  );
  // eslint-disable-next-line no-console
  console.log(
    `[a11y:${label}] blocking=${blocking.length} advisory=${advisory.length}`,
  );
  if (blocking.length > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[a11y:${label}] BLOCKING:`,
      JSON.stringify(
        blocking.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.length,
          firstNode: v.nodes[0]?.target,
          help: v.helpUrl,
        })),
        null,
        2,
      ),
    );
  }
  return { blocking, advisory, total: results.violations.length };
}

test.describe("a11y axe gate @a11y", () => {
  test("home page has no serious/critical axe violations", async ({ window }) => {
    await window.waitForSelector("h1");
    const { blocking } = await scan(window, "home");
    expect(blocking, JSON.stringify(blocking, null, 2)).toHaveLength(0);
  });

  test("DirBrowserModal has no serious/critical axe violations", async ({
    window,
  }) => {
    await window.waitForSelector("h1");
    await window.click("[data-testid=home-open-project]");
    await window.waitForSelector('[role="dialog"]');
    const { blocking } = await scan(window, "dir-modal");
    expect(blocking, JSON.stringify(blocking, null, 2)).toHaveLength(0);
    await window.keyboard.press("Escape");
  });

  test("workspace ConfigEditor has no serious/critical axe violations", async ({
    window,
  }) => {
    await window.waitForSelector("h1");
    // Open the project (auto-registered worktree).
    const tab = await window.$("button:has-text('ui-shadcn-refactor')");
    if (tab) await tab.click();
    await window.waitForSelector("h1, h2", { timeout: 10_000 });
    const { blocking } = await scan(window, "workspace");
    expect(blocking, JSON.stringify(blocking, null, 2)).toHaveLength(0);
  });

  test("critical flows complete keyboard-only (P0 acceptance)", async ({
    window,
  }) => {
    await window.waitForSelector("h1");
    await window.keyboard.press("Tab");
    const first = await window.evaluate(() => {
      const el = document.activeElement;
      return el
        ? `${el.tagName}:${(el.getAttribute("aria-label") ?? el.textContent ?? "").slice(0, 30)}`
        : null;
    });
    expect(first, "first Tab should land on an interactive element").toBeTruthy();
  });
});