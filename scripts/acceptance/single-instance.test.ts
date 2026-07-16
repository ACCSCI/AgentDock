import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("single-instance architecture acceptance", () => {
  it("development instance commands target the real TypeScript launcher", () => {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    for (const instance of [1, 2, 3]) {
      const command = pkg.scripts[`dev:${instance}`] as string;
      expect(command).toContain(`scripts/dev-instance.ts ${instance}`);
      expect(command).not.toContain("dev-instance.js");
    }
  });

  it("isolates userData, global DB identity, and renderer ports", () => {
    const launcher = readFileSync(resolve(root, "scripts/dev-instance.ts"), "utf8");
    expect(launcher).toContain("AGENTDOCK_USER_DATA_DIR");
    expect(launcher).toContain("AGENTDOCK_DEV_INSTANCE");
    expect(launcher).toContain("FRONTEND_PORT");
    expect(launcher).not.toContain("AGENTDOCK_DAEMON_URL");
  });

  it("rehydrates persisted session ownership before IPC registration", () => {
    const main = readFileSync(resolve(root, "electron/main.ts"), "utf8");
    const recovery = main.indexOf("restorePersistedSessions(");
    const ipcRegistration = main.indexOf("registerAllIpc(");
    expect(recovery).toBeGreaterThan(-1);
    expect(ipcRegistration).toBeGreaterThan(recovery);
  });
});
