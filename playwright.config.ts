/**
 * Playwright configuration for AgentDock E2E tests.
 *
 * Used from Phase 3 onwards (when Electron can launch via _electron.launch()).
 * Phase 0 only verifies this config loads and lists its spec dir.
 *
 * Why these settings:
 *   - fullyParallel: false  → Electron processes can't safely run in parallel
 *                              (they share ~/.agentdock/ state).
 *   - workers: 1            → Single Electron at a time.
 *   - retries: 0            → No flaky retries; AI agent inspects failures directly.
 *   - JSON reporter         → Machine-readable for AI agent parsing.
 *   - HTML reporter         → Human inspection (open: "never" prevents popups).
 *   - retain-on-failure     → Debug artifacts (trace/video/screenshot) only kept
 *                              for failed runs, to keep CI artifacts small.
 */
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ["json", { outputFile: "e2e-report.json" }],
    ["html", { open: "never", outputFolder: "e2e-report-html" }],
    ["list"],
  ],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});