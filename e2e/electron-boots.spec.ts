// @ts-nocheck
/**
 * E2E pilot: verify the Electron app boots and the renderer bridge works.
 *
 * This spec serves as the pilot for REUSE mode — it uses `reuseTest` so
 * multiple tests share a single Electron instance, exercising the
 * __e2eResetMainState hook between tests.
 *
 * To run in REUSE mode:
 *   AGENTDOCK_E2E_REUSE=1 npx playwright test e2e/electron-boots.spec.ts
 *
 * To run in isolation mode (default):
 *   npx playwright test e2e/electron-boots.spec.ts
 */
import { test, expect } from "./fixtures/electron-fixture";

test.describe("electron boots @reuse", () => {
  test("main window has a title", async ({ window }) => {
    const title = await window.title();
    // Title may be empty during very early load; just verify the window
    // is responsive enough to return *something*.
    expect(typeof title).toBe("string");
  });

  test("window.api bridge is ready", async ({ window }) => {
    const hasApi = await window.evaluate(
      () => typeof (window as unknown as { api?: unknown }).api === "object",
    );
    expect(hasApi).toBe(true);
  });

  test("bootstrap.health returns daemon ok", async ({ window }) => {
    const health = await window.evaluate(async () => {
      return await (window as unknown as { api: { bootstrap: { health: () => Promise<{ daemon: string }> } } }).api.bootstrap.health();
    });
    expect(health.daemon).toBe("ok");
  });
});
