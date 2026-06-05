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

  it("throws when FRONTEND_PORT is missing (no fallback to 5173)", () => {
    expect(code).not.toMatch(/\|\|\s*5173/);
  });

  it("keeps strictPort: true", () => {
    expect(code).toMatch(/strictPort:\s*true/);
  });
});

// ============================================================
// IS-PORT: package.json scripts use TS, not hardcoded 5173
// ============================================================

describe("IS-PORT: package.json scripts", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

  it("open-app script does not hardcode localhost:5173", () => {
    expect(pkg.scripts["open-app"]).not.toMatch(/localhost:5173/);
  });

  it("start script does not hardcode localhost:5173", () => {
    expect(pkg.scripts["start"]).not.toMatch(/localhost:5173/);
  });

  it("start script uses TS entry point", () => {
    expect(pkg.scripts["start"]).toMatch(/scripts\/start\.ts/);
  });

  it("open-app script uses TS entry point", () => {
    expect(pkg.scripts["open-app"]).toMatch(/scripts\/open-app\.ts/);
  });
});

// ============================================================
// IS-PORT: api.ts no hardcoded 5173 fallback
// ============================================================

describe("IS-PORT: api.ts", () => {
  it("has no ?? 5173 fallback", () => {
    const code = readFileSync("plugins/api.ts", "utf-8");
    expect(code).not.toMatch(/\?\?\s*5173/);
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
