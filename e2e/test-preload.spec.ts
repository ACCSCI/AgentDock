import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, _electron as electron } from "@playwright/test";

const ROOT = process.cwd();

const test_ = base.extend({});

test_("debug: what is window.api", async () => {
  const testDataDir = join(tmpdir(), `agentdock-preload-debug-${Date.now()}`);
  mkdirSync(testDataDir, { recursive: true });

  const mainEntry = join(ROOT, "out/main/main.js");
  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      AGENTDOCK_DATA_DIR: testDataDir,
      FRONTEND_PORT: "5173",
      AGENTDOCK_USE_BUN: "1",
      ELECTRON_ENABLE_LOGGING: "1",
    },
    timeout: 30_000,
  });
  const window = await app.firstWindow({ timeout: 20_000 });
  await window.waitForLoadState("domcontentloaded");

  // Print what's in window
  const windowKeys = await window.evaluate(() => {
    return Object.keys(window).filter((k) => k.includes("api") || k === "api" || k === "electron");
  });
  console.log("Window keys with 'api':", windowKeys);

  const apiType = await window.evaluate(() => typeof (window as { api?: unknown }).api);
  console.log("typeof window.api:", apiType);

  const electronType = await window.evaluate(
    () => typeof (window as { electron?: unknown }).electron,
  );
  console.log("typeof window.electron:", electronType);

  await app.close();
  rmSync(testDataDir, { recursive: true, force: true });
});
