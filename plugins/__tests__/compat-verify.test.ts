import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ============================================================
// IS-PORT: vite.config.ts 不硬编码端口
// ============================================================

describe("IS-PORT: vite.config.ts", () => {
  const code = readFileSync("vite.config.ts", "utf-8");

  it("does not hardcode port 5173", () => {
    expect(code).not.toMatch(/port:\s*5173/);
  });

  it("reads port from environment variable", () => {
    expect(code).toMatch(/process\.env\.FRONTEND_PORT/);
  });
});

// ============================================================
// IS-LOCK: singleton lock removed, daemon handles concurrency
// ============================================================

describe("IS-LOCK: singleton removed", () => {
  it("singleton.ts no longer exists", () => {
    expect(() => readFileSync("plugins/singleton.ts", "utf-8")).toThrow();
  });

  it("api.ts does not import singleton", () => {
    const code = readFileSync("plugins/api.ts", "utf-8");
    expect(code).not.toMatch(/singleton/);
  });

  it("daemon-client has register method", () => {
    const code = readFileSync("plugins/daemon-client.ts", "utf-8");
    expect(code).toMatch(/async register\(/);
  });
});
