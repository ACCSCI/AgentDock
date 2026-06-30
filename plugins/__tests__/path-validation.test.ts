// @ts-nocheck
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateProjectPath } from "../path-validation.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "ad-pathval-test-"));
});

afterEach(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("validateProjectPath", () => {
  it("PV1: 合法绝对目录路径通过并返回规范化路径", () => {
    const result = validateProjectPath(tmpDir);
    expect(result).toBe(path.resolve(tmpDir));
  });

  it("PV2: 相对路径 → 抛错", () => {
    expect(() => validateProjectPath("relative/path")).toThrow();
    expect(() => validateProjectPath("./foo")).toThrow();
  });

  it("PV3: 不存在的路径 → 抛错", () => {
    const missing = path.join(tmpDir, "does-not-exist");
    expect(() => validateProjectPath(missing)).toThrow();
  });

  it("PV4: 指向文件而非目录 → 抛错", () => {
    const filePath = path.join(tmpDir, "afile.txt");
    writeFileSync(filePath, "x");
    expect(() => validateProjectPath(filePath)).toThrow();
  });

  it("PV5: 空/非字符串 → 抛错", () => {
    expect(() => validateProjectPath("")).toThrow();
    // @ts-expect-error testing runtime guard
    expect(() => validateProjectPath(undefined)).toThrow();
  });
});
