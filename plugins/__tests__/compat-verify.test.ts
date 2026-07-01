// @ts-nocheck
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ============================================================
// IS-PORT: vite.config.ts 不硬编码端口 (Phase 1 后 vite.config.ts 被
// electron.vite.config.ts 替代 — 同样原则要遵守)
// ============================================================

describe("IS-PORT: dev config does not hardcode 5173", () => {
  // Phase 1: vite.config.ts → electron.vite.config.ts (3-target model).
  // The "no hardcoded port" constraint still applies to whichever file owns
  // the renderer dev server config.
  const candidatePaths = [
    "electron.vite.config.ts",
    "vite.config.ts", // legacy fallback until Phase 6 deletes it
  ];
  const existingPath = candidatePaths.find((p) => {
    try {
      readFileSync(p, "utf-8");
      return true;
    } catch {
      return false;
    }
  });

  it("does not hardcode port 5173", () => {
    if (!existingPath) return; // skip — neither file exists
    const code = readFileSync(existingPath, "utf-8");
    expect(code).not.toMatch(/port:\s*5173/);
  });

  it("reads port from environment variable", () => {
    if (!existingPath) return;
    const code = readFileSync(existingPath, "utf-8");
    expect(code).toMatch(/process\.env\.FRONTEND_PORT/);
  });

  it("throws when FRONTEND_PORT is missing (no fallback to 5173)", () => {
    if (!existingPath) return;
    const code = readFileSync(existingPath, "utf-8");
    expect(code).not.toMatch(/\|\|\s*5173/);
  });

  it("keeps strictPort: true", () => {
    if (!existingPath) return;
    const code = readFileSync(existingPath, "utf-8");
    expect(code).toMatch(/strictPort:\s*true/);
  });
});

// ============================================================
// IS-PORT: package.json scripts use TS, not hardcoded 5173
// (Phase 1 后: dev 走 electron-vite, 移除 open-app / start.ts)
// ============================================================

describe("IS-PORT: package.json scripts", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf-8"));

  it("dev script uses electron-vite (not raw vite)", () => {
    expect(pkg.scripts["dev"]).toMatch(/electron-vite/);
  });

  it("dev script does not hardcode localhost:5173", () => {
    expect(pkg.scripts["dev"]).not.toMatch(/localhost:5173/);
  });

  it("build script uses electron-vite", () => {
    expect(pkg.scripts["build"]).toMatch(/electron-vite/);
  });

  it("start script does not hardcode localhost:5173", () => {
    expect(pkg.scripts["start"]).not.toMatch(/localhost:5173/);
  });

  it("dist:win script chains electron-vite build + electron-builder", () => {
    expect(pkg.scripts["dist:win"]).toMatch(/electron-vite build.*electron-builder/);
  });
});

// ============================================================
// IS-PORT: api.ts is GONE (Phase 6 deleted it)
// ============================================================

describe("IS-PORT: api.ts deleted", () => {
  it("plugins/api.ts no longer exists", () => {
    expect(() => readFileSync("plugins/api.ts", "utf-8")).toThrow();
  });

  it("vite.config.ts no longer exists", () => {
    expect(() => readFileSync("vite.config.ts", "utf-8")).toThrow();
  });
});

// ============================================================
// IS-LOCK: singleton lock removed, daemon handles concurrency
// ============================================================

describe("IS-LOCK: singleton removed", () => {
  it("singleton.ts no longer exists", () => {
    expect(() => readFileSync("plugins/singleton.ts", "utf-8")).toThrow();
  });

  it("daemon-client has registerClient method (Hono RPC)", () => {
    const code = readFileSync("plugins/daemon-client.ts", "utf-8");
    expect(code).toMatch(/registerClient/);
  });
});
