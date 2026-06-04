import { describe, expect, it } from "vitest";
import { mergeEnv, parseEnv, updateEnvFile, writeEnv } from "../env.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("parseEnv", () => {
  it("parses simple KEY=VALUE pairs", () => {
    const result = parseEnv("FOO=bar\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("handles empty content", () => {
    expect(parseEnv("")).toEqual({});
  });

  it("skips comment lines", () => {
    const result = parseEnv("# comment\nFOO=bar\n# another\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("skips empty lines", () => {
    const result = parseEnv("FOO=bar\n\n\nBAZ=qux");
    expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("handles values with double quotes", () => {
    const result = parseEnv('FOO="hello world"');
    expect(result).toEqual({ FOO: "hello world" });
  });

  it("handles values with single quotes", () => {
    const result = parseEnv("FOO='hello world'");
    expect(result).toEqual({ FOO: "hello world" });
  });

  it("handles values with equals sign", () => {
    const result = parseEnv("FOO=bar=baz");
    expect(result).toEqual({ FOO: "bar=baz" });
  });

  it("handles keys without values", () => {
    const result = parseEnv("FOO=\nBAZ=qux");
    expect(result).toEqual({ FOO: "", BAZ: "qux" });
  });

  it("handles inline comments after unquoted values", () => {
    const result = parseEnv("FOO=bar # this is a comment");
    expect(result).toEqual({ FOO: "bar" });
  });

  it("preserves whitespace in quoted values", () => {
    const result = parseEnv('FOO="  hello  "');
    expect(result).toEqual({ FOO: "  hello  " });
  });
});

describe("mergeEnv", () => {
  it("merges new values into existing", () => {
    const result = mergeEnv({ A: "1", B: "2" }, { B: "3", C: "4" });
    expect(result).toEqual({ A: "1", B: "3", C: "4" });
  });

  it("returns a new object (no mutation)", () => {
    const existing = { A: "1" };
    const result = mergeEnv(existing, { B: "2" });
    expect(result).not.toBe(existing);
    expect(existing).toEqual({ A: "1" });
  });

  it("handles empty updates", () => {
    const result = mergeEnv({ A: "1" }, {});
    expect(result).toEqual({ A: "1" });
  });

  it("handles empty existing", () => {
    const result = mergeEnv({}, { A: "1" });
    expect(result).toEqual({ A: "1" });
  });
});

describe("writeEnv", () => {
  it("serializes to KEY=VALUE format", () => {
    const result = writeEnv({ FOO: "bar", BAZ: "qux" });
    expect(result).toBe("FOO=bar\nBAZ=qux\n");
  });

  it("handles empty values", () => {
    const result = writeEnv({ FOO: "" });
    expect(result).toBe("FOO=\n");
  });

  it("handles empty object", () => {
    const result = writeEnv({});
    expect(result).toBe("");
  });

  it("preserves order", () => {
    const result = writeEnv({ Z: "1", A: "2", M: "3" });
    expect(result).toBe("Z=1\nA=2\nM=3\n");
  });
});

describe("updateEnvFile", () => {
  function createTmpDir(): string {
    const dir = path.join(os.tmpdir(), `agentdock-env-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("creates .env if it does not exist", () => {
    const dir = createTmpDir();
    try {
      const filePath = path.join(dir, ".env");
      updateEnvFile(filePath, { PORT: "3000" });
      expect(existsSync(filePath)).toBe(true);
      expect(readFileSync(filePath, "utf-8")).toBe("PORT=3000\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges with existing .env", () => {
    const dir = createTmpDir();
    try {
      const filePath = path.join(dir, ".env");
      writeFileSync(filePath, "EXISTING=value\nPORT=8080\n");
      updateEnvFile(filePath, { PORT: "3000", NEW: "added" });
      const content = readFileSync(filePath, "utf-8");
      const parsed = parseEnv(content);
      expect(parsed).toEqual({ EXISTING: "value", PORT: "3000", NEW: "added" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves comments are not preserved (by design)", () => {
    const dir = createTmpDir();
    try {
      const filePath = path.join(dir, ".env");
      writeFileSync(filePath, "# header\nFOO=bar\n");
      updateEnvFile(filePath, { BAZ: "qux" });
      const content = readFileSync(filePath, "utf-8");
      // Comments are stripped by parseEnv; only values remain
      expect(parseEnv(content)).toEqual({ FOO: "bar", BAZ: "qux" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
