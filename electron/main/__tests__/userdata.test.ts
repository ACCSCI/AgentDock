// @ts-nocheck
/**
 * userdata decision unit tests.
 *
 * The Electron `app` module is not available in Node test env, so we mock
 * it and verify the perUser/perMachine decision based on process.execPath.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("electron", () => ({
  app: {
    getPath: (key: string) => {
      if (key !== "userData") {
        throw new Error(`unexpected getPath(${key})`);
      }
      // Standard perUser userData path
      return process.platform === "win32"
        ? "C:\\Users\\Test\\AppData\\Roaming\\AgentDock"
        : "/home/test/.config/AgentDock";
    },
  },
}));

import { resolveUserDataPath, migrateLegacyUserData, detectInstallMode } from "../userdata.js";

describe("resolveUserDataPath", () => {
  const originalExecPath = process.execPath;

  afterEach(() => {
    Object.defineProperty(process, "execPath", { value: originalExecPath });
  });

  it("uses %APPDATA%\\AgentDock when exe is perUser", () => {
    Object.defineProperty(process, "execPath", {
      value: "C:\\Users\\Test\\AppData\\Local\\Programs\\AgentDock\\AgentDock.exe",
    });
    expect(resolveUserDataPath()).toBe("C:\\Users\\Test\\AppData\\Roaming\\AgentDock");
  });

  it("uses %PROGRAMDATA%\\AgentDock when exe is in Program Files", () => {
    process.env.PROGRAMDATA = "C:\\ProgramData";
    Object.defineProperty(process, "execPath", {
      value: "C:\\Program Files\\AgentDock\\AgentDock.exe",
    });
    expect(resolveUserDataPath()).toBe("C:\\ProgramData\\AgentDock");
  });

  it("falls back to %PROGRAMDATA% = C:\\ProgramData if env unset", () => {
    const old = process.env.PROGRAMDATA;
    delete process.env.PROGRAMDATA;
    Object.defineProperty(process, "execPath", {
      value: "C:\\Program Files\\AgentDock\\AgentDock.exe",
    });
    try {
      expect(resolveUserDataPath()).toBe("C:\\ProgramData\\AgentDock");
    } finally {
      if (old !== undefined) process.env.PROGRAMDATA = old;
    }
  });
});

describe("detectInstallMode", () => {
  const originalExecPath = process.execPath;

  afterEach(() => {
    Object.defineProperty(process, "execPath", { value: originalExecPath });
  });

  it("perMachine when path contains \\program files\\", () => {
    Object.defineProperty(process, "execPath", {
      value: "C:\\Program Files\\AgentDock\\AgentDock.exe",
    });
    expect(detectInstallMode()).toBe("perMachine");
  });

  it("perUser for AppData\\Local", () => {
    Object.defineProperty(process, "execPath", {
      value: "C:\\Users\\X\\AppData\\Local\\Programs\\AgentDock\\AgentDock.exe",
    });
    expect(detectInstallMode()).toBe("perUser");
  });
});

describe("migrateLegacyUserData", () => {
  let sandbox: string;

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "agentdock-userdata-test-"));
  });

  it("returns migratedFrom=null when new path already has data", () => {
    const newPath = join(sandbox, "new");
    const oldPath = join(sandbox, "old");
    require("node:fs").mkdirSync(newPath, { recursive: true });
    require("node:fs").mkdirSync(oldPath, { recursive: true });
    writeFileSync(join(newPath, "already-here.txt"), "fresh");
    writeFileSync(join(oldPath, "projects.db"), "old data");
    process.env.APPDATA = oldPath;

    const { migratedFrom } = migrateLegacyUserData(newPath);
    expect(migratedFrom).toBeNull();
    // Existing data must NOT be clobbered
    expect(require("node:fs").readFileSync(join(newPath, "already-here.txt"), "utf8")).toBe("fresh");
  });

  it("copies files from $APPDATA\\AgentDock when new is empty", () => {
    const newPath = join(sandbox, "new");
    const oldPath = join(sandbox, "AgentDock");
    require("node:fs").mkdirSync(newPath, { recursive: true });
    require("node:fs").mkdirSync(oldPath, { recursive: true });
    writeFileSync(join(oldPath, "projects.db"), "old data");
    writeFileSync(join(oldPath, "Preferences"), "user prefs");
    process.env.APPDATA = sandbox;

    const { migratedFrom } = migrateLegacyUserData(newPath);
    expect(migratedFrom).toBe(oldPath);
    expect(existsSync(join(newPath, "projects.db"))).toBe(true);
    expect(existsSync(join(newPath, "Preferences"))).toBe(true);
  });

  it("no-op when no legacy path exists", () => {
    const newPath = join(sandbox, "new");
    process.env.APPDATA = join(sandbox, "does-not-exist-appdata");
    process.env.USERPROFILE = join(sandbox, "does-not-exist-userprofile");

    const { migratedFrom } = migrateLegacyUserData(newPath);
    expect(migratedFrom).toBeNull();
  });
});
