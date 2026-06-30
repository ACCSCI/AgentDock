// @ts-nocheck
/**
 * Single source of truth assertion — plugins/config.ts owns PORT_KEYS_DEFAULT.
 * plugins/daemon-state.ts (and friends) must re-export, not redefine.
 *
 * 新架构 §14.1: 端口键常量去重（单一真相源）
 */
import { describe, expect, it } from "vitest";
import * as configModule from "../config.js";
import * as daemonStateModule from "../daemon-state.js";

describe("P0: PORT_KEYS_DEFAULT single source of truth", () => {
  it("config.ts exports PORT_KEYS_DEFAULT with 5 standard port keys", () => {
    expect(configModule.PORT_KEYS_DEFAULT).toEqual([
      "FRONTEND_PORT",
      "BACKEND_PORT",
      "WS_PORT",
      "DEBUG_PORT",
      "PREVIEW_PORT",
    ]);
  });

  it("daemon-state.ts PORT_KEYS is identical to config.PORT_KEYS_DEFAULT", () => {
    expect(daemonStateModule.PORT_KEYS).toEqual(configModule.PORT_KEYS_DEFAULT);
    expect(daemonStateModule.PORT_KEYS).toBe(configModule.PORT_KEYS_DEFAULT);
  });

  it("daemon-state.ts no longer redefines PORT_KEYS_DEFAULT (no local array literal)", () => {
    // Read the raw source and ensure no `PORT_KEYS_DEFAULT = [` literal remains
    // inside daemon-state.ts — guards against future drift.
    const fs = require("node:fs");
    const path = require("node:path");
    const source = fs.readFileSync(
      path.resolve(__dirname, "../daemon-state.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/PORT_KEYS_DEFAULT\s*=\s*\[/);
  });

  it("config.ts ports default uses PORT_KEYS_DEFAULT (schema parity)", () => {
    // The Zod schema default for `env.ports` must equal PORT_KEYS_DEFAULT.
    // Verified indirectly: loadConfig({}) returns env.ports === PORT_KEYS_DEFAULT.
    const { loadConfig } = configModule;
    const cfg = loadConfig(makeEmptyProjectDir());
    expect(cfg.env.ports).toEqual([...configModule.PORT_KEYS_DEFAULT]);
  });
});

function makeEmptyProjectDir(): string {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentdock-portkeys-"));
  return dir;
}
