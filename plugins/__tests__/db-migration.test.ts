import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createDb, getDbPath, SCHEMA_VERSION } from "../db/index.js";

function tmpProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "ad-dbmig-test-"));
}

function columns(dbPath: string, table: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

function userVersion(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare("PRAGMA user_version").get() as
      | { user_version: number }
      | undefined;
    return row?.user_version ?? 0;
  } finally {
    db.close();
  }
}

describe("DB migration — PRAGMA user_version", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = tmpProject();
  });

  afterEach(() => {
    // WAL-mode SQLite may keep file handles briefly on Windows; tolerate EPERM.
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      // Temp dir; OS will reclaim it.
    }
  });

  it("DBM1: 全新库创建后 user_version 等于 SCHEMA_VERSION", () => {
    createDb(projectDir);
    expect(userVersion(getDbPath(projectDir))).toBe(SCHEMA_VERSION);
  });

  it("DBM2: 全新库包含所有列（含 ports 与 background_hook_status）", () => {
    createDb(projectDir);
    const cols = columns(getDbPath(projectDir), "sessions");
    expect(cols).toContain("ports");
    expect(cols).toContain("background_hook_status");
    const projCols = columns(getDbPath(projectDir), "projects");
    expect(projCols).toEqual(
      expect.arrayContaining(["id", "name", "path", "created_at"]),
    );
  });

  it("DBM3: 重复 createDb 幂等，不报错且版本不变", () => {
    createDb(projectDir);
    const v1 = userVersion(getDbPath(projectDir));
    expect(() => createDb(projectDir)).not.toThrow();
    const v2 = userVersion(getDbPath(projectDir));
    expect(v2).toBe(v1);
    expect(v2).toBe(SCHEMA_VERSION);
  });

  it("DBM4: 旧库（缺列、user_version=0、含数据）升级后补齐列且数据不丢失", () => {
    // Simulate a legacy DB: base columns only, no ports/background_hook_status,
    // user_version left at default 0, with one existing row.
    const dbDir = path.join(projectDir, ".data");
    mkdirSync(dbDir, { recursive: true });
    const dbPath = getDbPath(projectDir);
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    legacy.prepare(
      "INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)",
    ).run("p1", "Legacy", "/tmp/legacy", "2024-01-01T00:00:00.000Z");
    legacy.prepare(
      "INSERT INTO sessions (id, project_id, name, branch, worktree_path, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("s1", "p1", "Old Session", "agentdock/s1", "/tmp/wt", "2024-01-01T00:00:00.000Z");
    expect(
      (legacy.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    ).toBe(0);
    legacy.close();

    // Run the real migration path.
    createDb(projectDir);

    // Columns are now present.
    const cols = columns(dbPath, "sessions");
    expect(cols).toContain("ports");
    expect(cols).toContain("background_hook_status");
    // Version advanced.
    expect(userVersion(dbPath)).toBe(SCHEMA_VERSION);

    // Pre-existing data preserved.
    const check = new DatabaseSync(dbPath);
    try {
      const session = check
        .prepare("SELECT id, name, branch FROM sessions WHERE id = ?")
        .get("s1") as { id: string; name: string; branch: string } | undefined;
      expect(session).toBeDefined();
      expect(session?.name).toBe("Old Session");
      const project = check
        .prepare("SELECT id, name FROM projects WHERE id = ?")
        .get("p1") as { id: string; name: string } | undefined;
      expect(project?.name).toBe("Legacy");
    } finally {
      check.close();
    }
  });
});
