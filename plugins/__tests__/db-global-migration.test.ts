import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateProjectsToGlobal, openGlobalDb } from "../db/global.js";
import { openDb } from "../db/index.js";
import * as schema from "../db/schema.js";

describe("legacy project migration to global DB", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows WAL cleanup */
      }
    }
  });

  it("preserves and copies project rows during a v0-to-current upgrade", () => {
    const sourceDir = mkdtempSync(join(tmpdir(), "agentdock-source-db-"));
    const globalDir = mkdtempSync(join(tmpdir(), "agentdock-global-db-"));
    dirs.push(sourceDir, globalDir);

    const source = openDb(sourceDir);
    source.db
      .insert(schema.projects)
      .values({
        id: "legacy-project",
        name: "Legacy Project",
        path: "C:/legacy-project",
        createdAt: "2024-01-01T00:00:00.000Z",
      })
      .run();
    source.sqlite.close();

    const global = openGlobalDb(globalDir);
    migrateProjectsToGlobal(global.db, join(sourceDir, "data", "db.sqlite"));
    const migrated = global.db.select().from(schema.projects).all();
    expect(migrated).toHaveLength(1);
    expect(migrated[0]?.id).toBe("legacy-project");
    global.close();
  });
});
