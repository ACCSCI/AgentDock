/**
 * db:projects:create fuzzy dedup unit tests.
 *
 * Covers the project-creation path in electron/main/ipc/db.ts that
 * normalizes paths (forward slashes, lowercase drive, no trailing
 * slash) and merges entries that differ only in case or trailing slash.
 * The path-healing step (writing the caller's spelling on fuzzy
 * match) is also verified.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";

/**
 * Inline copy of the project-create handler's dedup logic for testing.
 * Mirrors electron/main/ipc/db.ts:423-453. Kept inline because the
 * handler depends on Electron's ipcMain which is hard to mock.
 */
function normalize(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/^([A-Z]):/i, (_, d: string) => d.toLowerCase() + ":");
}

function createOrHeal(
  db: ReturnType<typeof drizzle<typeof schema>>,
  name: string,
  path: string,
): { id: string; name: string; path: string } {
  const safePath = path;
  const normalized = normalize(safePath);
  const allProjects = db.select().from(schema.projects).all();
  const existing = allProjects.find((p) => normalize(p.path) === normalized);
  if (existing) {
    if (existing.path !== safePath) {
      db.update(schema.projects)
        .set({ path: safePath })
        .where(eq(schema.projects.id, existing.id))
        .run();
    }
    return db
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, existing.id))
      .get()!;
  }
  const id = Math.random().toString(36).slice(2, 10);
  db.insert(schema.projects)
    .values({ id, name, path: safePath })
    .run();
  return db.select().from(schema.projects).where(eq(schema.projects.id, id)).get()!;
}

describe("db:projects:create dedup", () => {
  let sandbox: string;
  let dbFile: string;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sandbox = mkdtempSync(join(process.env.TEMP ?? "/tmp", "db-dedup-"));
    dbFile = join(sandbox, "test.db");
    sqlite = new DatabaseSync(dbFile);
    sqlite.exec("PRAGMA journal_mode = WAL");
    // Replicate the projects table schema
    sqlite.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
    db = drizzle({ client: sqlite, schema });
  });

  it("creates a new project when path is fresh", () => {
    const project = createOrHeal(db, "SpeedWriter", "F:\\ProgramPlayground\\JavaScript\\SpeedWriter");
    expect(project.id).toBeTruthy();
    expect(project.path).toBe("F:\\ProgramPlayground\\JavaScript\\SpeedWriter");

    const all = db.select().from(schema.projects).all();
    expect(all.length).toBe(1);
  });

  it("returns existing project when path matches exactly", () => {
    const first = createOrHeal(db, "SpeedWriter", "F:\\ProgramPlayground\\JavaScript\\SpeedWriter");
    const second = createOrHeal(db, "SpeedWriter", "F:\\ProgramPlayground\\JavaScript\\SpeedWriter");
    expect(second.id).toBe(first.id);

    const all = db.select().from(schema.projects).all();
    expect(all.length).toBe(1);
  });

  it("fuzzy-matches when caller uses different case (Windows drives are case-insensitive)", () => {
    const first = createOrHeal(db, "SpeedWriter", "F:\\ProgramPlayground\\JavaScript\\SpeedWriter");
    const second = createOrHeal(db, "SpeedWriter", "f:\\ProgramPlayground\\JavaScript\\SpeedWriter");
    expect(second.id).toBe(first.id);

    const all = db.select().from(schema.projects).all();
    expect(all.length).toBe(1);
  });

  it("fuzzy-matches when caller uses trailing slash", () => {
    const first = createOrHeal(db, "SpeedWriter", "F:\\ProgramPlayground\\JavaScript\\SpeedWriter");
    const second = createOrHeal(db, "SpeedWriter", "F:\\ProgramPlayground\\JavaScript\\SpeedWriter\\");
    expect(second.id).toBe(first.id);

    const all = db.select().from(schema.projects).all();
    expect(all.length).toBe(1);
  });

  it("fuzzy-matches when caller uses forward slashes", () => {
    const first = createOrHeal(db, "SpeedWriter", "F:\\ProgramPlayground\\JavaScript\\SpeedWriter");
    const second = createOrHeal(db, "SpeedWriter", "F:/ProgramPlayground/JavaScript/SpeedWriter");
    expect(second.id).toBe(first.id);

    const all = db.select().from(schema.projects).all();
    expect(all.length).toBe(1);
  });

  it("heals the stored path to the caller's spelling on fuzzy match", () => {
    createOrHeal(db, "SpeedWriter", "F:\\ProgramPlayground\\JavaScript\\SpeedWriter");
    const updated = createOrHeal(db, "SpeedWriter", "F:/ProgramPlayground/JavaScript/SpeedWriter/");
    expect(updated.path).toBe("F:/ProgramPlayground/JavaScript/SpeedWriter/");

    const stored = db.select().from(schema.projects).all();
    expect(stored[0].path).toBe("F:/ProgramPlayground/JavaScript/SpeedWriter/");
  });

  it("creates a new project for genuinely different paths", () => {
    const a = createOrHeal(db, "ProjA", "F:\\ProgramPlayground\\JavaScript\\ProjA");
    const b = createOrHeal(db, "ProjB", "F:\\ProgramPlayground\\JavaScript\\ProjB");
    expect(a.id).not.toBe(b.id);

    const all = db.select().from(schema.projects).all();
    expect(all.length).toBe(2);
  });
});
