import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  buildScopedChildEnv,
  mergeEnv,
  parseEnv,
  readEnvFile,
  readWorkspaceEnv,
  updateEnvFile,
  writeEnv,
} from "../env.js";
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

describe("buildScopedChildEnv", () => {
  function createTmpDir(): string {
    const dir = path.join(os.tmpdir(), `agentdock-env-scope-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("overrides inherited vars with workspace .env values", () => {
    const dir = createTmpDir();
    try {
      writeFileSync(path.join(dir, ".env"), "FRONTEND_PORT=20091\nAPI_URL=http://local\n");
      const env = buildScopedChildEnv(dir, { AGENTDOCK_SESSION_ID: "sess1" }, {
        FRONTEND_PORT: "5175",
        API_URL: "http://parent",
        PATH: process.env.PATH,
      });
      expect(env.FRONTEND_PORT).toBe("20091");
      expect(env.API_URL).toBe("http://local");
      expect(env.AGENTDOCK_SESSION_ID).toBe("sess1");
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("strips fallback port keys even when workspace .env does not define them", () => {
    const dir = createTmpDir();
    try {
      writeFileSync(path.join(dir, ".env"), "API_URL=http://local\n");
      const env = buildScopedChildEnv(dir, {}, {
        FRONTEND_PORT: "5175",
        PORT: "3000",
        API_URL: "http://parent",
      });
      expect(env.FRONTEND_PORT).toBeUndefined();
      expect(env.PORT).toBeUndefined();
      expect(env.API_URL).toBe("http://local");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps safe inherited vars when no workspace override exists", () => {
    const dir = createTmpDir();
    try {
      const env = buildScopedChildEnv(dir, {}, {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CUSTOM_SAFE: "keep-me",
      });
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.HOME).toBe(process.env.HOME);
      expect(env.CUSTOM_SAFE).toBe("keep-me");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets runtime vars win over workspace .env", () => {
    const dir = createTmpDir();
    try {
      writeFileSync(path.join(dir, ".env"), "AGENTDOCK_SESSION_ID=from-file\nTERM=dumb\n");
      const env = buildScopedChildEnv(dir, {
        AGENTDOCK_SESSION_ID: "runtime-session",
        TERM: "xterm-256color",
      });
      expect(env.AGENTDOCK_SESSION_ID).toBe("runtime-session");
      expect(env.TERM).toBe("xterm-256color");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
