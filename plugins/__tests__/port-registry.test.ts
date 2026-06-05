import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  assignSessionPorts,
  getSessionPorts,
  loadGlobalAllocatedPorts,
  loadRegistry,
  reassignSessionPorts,
  releaseSessionPorts,
  saveRegistry,
  type SessionPorts,
} from "../port-registry.js";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const PORT_KEYS: (keyof SessionPorts)[] = [
  "FRONTEND_PORT",
  "BACKEND_PORT",
  "WS_PORT",
  "DEBUG_PORT",
  "PREVIEW_PORT",
];

function tmpDir(): string {
  const dir = path.join(os.tmpdir(), `port-registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("loadRegistry", () => {
  it("returns empty array when file does not exist", () => {
    const dir = tmpDir();
    try {
      expect(loadRegistry(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads entries from JSON file", () => {
    const dir = tmpDir();
    try {
      const entries = [
        { sessionId: "abc", ports: { FRONTEND_PORT: 20000, BACKEND_PORT: 20001, WS_PORT: 20002, DEBUG_PORT: 20003, PREVIEW_PORT: 20004 } },
      ];
      const filePath = path.join(dir, ".agentdock", "port-registry.json");
      mkdirSync(path.dirname(filePath), { recursive: true });
      readFileSync; // just to confirm import
      require("node:fs").writeFileSync(filePath, JSON.stringify(entries));
      expect(loadRegistry(dir)).toEqual(entries);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("saveRegistry", () => {
  it("creates the file and directory", () => {
    const dir = tmpDir();
    try {
      saveRegistry(dir, []);
      const filePath = path.join(dir, ".agentdock", "port-registry.json");
      expect(existsSync(filePath)).toBe(true);
      expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("saves entries correctly", () => {
    const dir = tmpDir();
    try {
      const entries = [
        { sessionId: "s1", ports: { FRONTEND_PORT: 20000, BACKEND_PORT: 20001, WS_PORT: 20002, DEBUG_PORT: 20003, PREVIEW_PORT: 20004 } },
      ];
      saveRegistry(dir, entries);
      const filePath = path.join(dir, ".agentdock", "port-registry.json");
      expect(JSON.parse(readFileSync(filePath, "utf-8"))).toEqual(entries);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("assignSessionPorts", () => {
  let dir: string;
  let worktreePath: string;

  beforeEach(() => {
    dir = tmpDir();
    worktreePath = path.join(dir, "worktree");
    mkdirSync(worktreePath, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("allocates 5 ports and returns a SessionPorts object", async () => {
    const ports = await assignSessionPorts(dir, "s1", worktreePath);
    expect(Object.keys(ports)).toHaveLength(5);
    for (const key of PORT_KEYS) {
      expect(typeof ports[key]).toBe("number");
    }
  });

  it("writes ports to .env in worktree", async () => {
    await assignSessionPorts(dir, "s1", worktreePath);
    const envPath = path.join(worktreePath, ".env");
    expect(existsSync(envPath)).toBe(true);
    const content = readFileSync(envPath, "utf-8");
    for (const key of PORT_KEYS) {
      expect(content).toContain(`${key}=`);
    }
  });

  it("persists to registry file", async () => {
    await assignSessionPorts(dir, "s1", worktreePath);
    const registry = loadRegistry(dir);
    expect(registry).toHaveLength(1);
    expect(registry[0].sessionId).toBe("s1");
  });

  it("is idempotent — second call returns same ports", async () => {
    const p1 = await assignSessionPorts(dir, "s1", worktreePath);
    const p2 = await assignSessionPorts(dir, "s1", worktreePath);
    expect(p1).toEqual(p2);
  });

  it("different sessions get different ports", async () => {
    const wt2 = path.join(dir, "worktree2");
    mkdirSync(wt2, { recursive: true });
    const p1 = await assignSessionPorts(dir, "s1", worktreePath);
    const p2 = await assignSessionPorts(dir, "s2", wt2);
    const allPorts = [...Object.values(p1), ...Object.values(p2)];
    expect(new Set(allPorts).size).toBe(10);
  });
});

describe("getSessionPorts", () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns null for unknown session", async () => {
    expect(await getSessionPorts(dir, "unknown")).toBeNull();
  });

  it("returns ports after assignment", async () => {
    const wt = path.join(dir, "wt");
    mkdirSync(wt, { recursive: true });
    const assigned = await assignSessionPorts(dir, "s1", wt);
    expect(await getSessionPorts(dir, "s1")).toEqual(assigned);
  });
});

describe("releaseSessionPorts", () => {
  let dir: string;

  beforeEach(() => { dir = tmpDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("removes session from registry", async () => {
    const wt = path.join(dir, "wt");
    mkdirSync(wt, { recursive: true });
    await assignSessionPorts(dir, "s1", wt);
    await releaseSessionPorts(dir, "s1");
    expect(await getSessionPorts(dir, "s1")).toBeNull();
  });

  it("is safe to call on unknown session", async () => {
    await releaseSessionPorts(dir, "unknown"); // should not throw
  });
});

describe("reassignSessionPorts", () => {
  let dir: string;
  let worktreePath: string;

  beforeEach(() => {
    dir = tmpDir();
    worktreePath = path.join(dir, "wt");
    mkdirSync(worktreePath, { recursive: true });
  });

  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("returns new ports different from original", async () => {
    const original = await assignSessionPorts(dir, "s1", worktreePath);
    const reassigned = await reassignSessionPorts(dir, "s1", worktreePath);
    // At least some ports should differ (very high probability all differ)
    const sameCount = PORT_KEYS.filter((k) => original[k] === reassigned[k]).length;
    expect(sameCount).toBeLessThan(5);
  });

  it("updates .env with new ports", async () => {
    await assignSessionPorts(dir, "s1", worktreePath);
    const reassigned = await reassignSessionPorts(dir, "s1", worktreePath);
    const content = readFileSync(path.join(worktreePath, ".env"), "utf-8");
    for (const key of PORT_KEYS) {
      expect(content).toContain(`${key}=${reassigned[key]}`);
    }
  });
});

describe("loadGlobalAllocatedPorts", () => {
  it("returns empty set when paths have no registries", () => {
    const dir1 = tmpDir();
    const dir2 = tmpDir();
    try {
      const ports = loadGlobalAllocatedPorts([dir1, dir2]);
      expect(ports.size).toBe(0);
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("merges ports from a single project", async () => {
    const dir = tmpDir();
    const wt = path.join(dir, "wt");
    mkdirSync(wt, { recursive: true });
    try {
      const assigned = await assignSessionPorts(dir, "s1", wt);
      const ports = loadGlobalAllocatedPorts([dir]);
      expect(ports.size).toBe(5);
      for (const key of PORT_KEYS) {
        expect(ports.has(assigned[key])).toBe(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges ports from multiple projects", async () => {
    const dir1 = tmpDir();
    const dir2 = tmpDir();
    const wt1 = path.join(dir1, "wt");
    const wt2 = path.join(dir2, "wt");
    mkdirSync(wt1, { recursive: true });
    mkdirSync(wt2, { recursive: true });
    try {
      await assignSessionPorts(dir1, "s1", wt1);
      const globalExcluded = loadGlobalAllocatedPorts([dir1]);
      await assignSessionPorts(dir2, "s2", wt2, globalExcluded);
      const ports = loadGlobalAllocatedPorts([dir1, dir2]);
      expect(ports.size).toBe(10);
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe("assignSessionPorts with globalExcludedPorts", () => {
  it("does not allocate ports that are globally excluded", async () => {
    const dir1 = tmpDir();
    const dir2 = tmpDir();
    const wt1 = path.join(dir1, "wt");
    const wt2 = path.join(dir2, "wt");
    mkdirSync(wt1, { recursive: true });
    mkdirSync(wt2, { recursive: true });
    try {
      await assignSessionPorts(dir1, "s1", wt1);
      const globalExcluded = loadGlobalAllocatedPorts([dir1]);
      await assignSessionPorts(dir2, "s2", wt2, globalExcluded);
      for (const key of PORT_KEYS) {
        expect((await assignSessionPorts(dir2, "s2", wt2, globalExcluded))[key]).not.toBe((await assignSessionPorts(dir1, "s1", wt1))[key]);
      }
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("works without globalExcludedPorts (backward compatible)", async () => {
    const dir = tmpDir();
    const wt = path.join(dir, "wt");
    mkdirSync(wt, { recursive: true });
    try {
      const ports = await assignSessionPorts(dir, "s1", wt);
      expect(Object.keys(ports)).toHaveLength(5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reassignSessionPorts with globalExcludedPorts", () => {
  it("new ports do not overlap with globally excluded ports", async () => {
    const dir1 = tmpDir();
    const dir2 = tmpDir();
    const wt1 = path.join(dir1, "wt");
    const wt2 = path.join(dir2, "wt");
    mkdirSync(wt1, { recursive: true });
    mkdirSync(wt2, { recursive: true });
    try {
      await assignSessionPorts(dir1, "s1", wt1);
      const globalExcluded = loadGlobalAllocatedPorts([dir1]);
      await assignSessionPorts(dir2, "s2", wt2, globalExcluded);
      const reassigned = await reassignSessionPorts(dir2, "s2", wt2, globalExcluded);
      for (const key of PORT_KEYS) {
        expect(reassigned[key]).not.toBe((await assignSessionPorts(dir1, "s1", wt1))[key]);
      }
    } finally {
      rmSync(dir1, { recursive: true, force: true });
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
