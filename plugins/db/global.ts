/**
 * Global projects database — machine-level singleton at ~/.agentdock/projects.db.
 *
 * The projects table lives here (not in per-project DBs) so that project
 * records survive across project switches. Per-project DBs still hold
 * sessions and todos.
 */
import { existsSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { drizzle } from "drizzle-orm/node-sqlite";
import { eq } from "drizzle-orm";
import * as schema from "./schema.js";

const GLOBAL_DB_DIR = ".agentdock";
const GLOBAL_DB_FILE = "projects.db";

/**
 * Schema version for the global DB (independent of per-project SCHEMA_VERSION).
 *
 * Default location is `<homedir>/.agentdock/projects.db` (production). Dev / test
 * callers may pass an `overrideDir` to `openGlobalDb()` to redirect the DB into a
 * per-instance userData path. The override MUST be a directory path, not a file.
 */
const GLOBAL_DB_VERSION = 1;

// Reuse schema.projects — the Drizzle table definition does not encode FK
// relationships; those are only in the raw SQL migrations.
type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

export interface GlobalDbHandle {
  db: DrizzleDb;
  sqlite: DatabaseSync;
  close: () => void;
}

// ── Singleton ──────────────────────────────────────────────────────────────
let globalDb: DrizzleDb | null = null;
let globalSqlite: DatabaseSync | null = null;

/**
 * Open (or return the cached) global projects database.
 * Creates the parent directory if needed, enables WAL, and runs
 * the global schema migration (projects table only).
 *
 * @param overrideDir  Optional caller-controlled directory override. When set,
 *                     the DB lives at `<overrideDir>/projects.db` instead of the
 *                     production default `<homedir>/.agentdock/projects.db`.
 *                     Used by dev mode (per-userData isolation) and by E2E
 *                     fixtures to keep test DBs out of the user's real home dir.
 *                     Must be a directory path, not a file path.
 */
export function openGlobalDb(overrideDir?: string): GlobalDbHandle {
  if (globalDb && globalSqlite) {
    return { db: globalDb, sqlite: globalSqlite, close: closeGlobalDb };
  }

  // overrideDir: caller-controlled override for dev / test isolation.
  // When undefined, falls back to the production default (homedir + .agentdock).
  const dbDir = overrideDir ?? path.join(os.homedir(), GLOBAL_DB_DIR);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = path.join(dbDir, GLOBAL_DB_FILE);
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = OFF"); // no FK needed for projects-only table

  runGlobalMigrations(sqlite);

  globalDb = drizzle({ client: sqlite, schema });
  globalSqlite = sqlite;

  return { db: globalDb, sqlite, close: closeGlobalDb };
}

/** Return the cached global DB handle (null if not yet opened). */
export function getGlobalDbHandle(): DrizzleDb | null {
  return globalDb;
}

function closeGlobalDb(): void {
  if (globalSqlite) {
    try {
      globalSqlite.close();
    } catch {
      // best-effort
    }
  }
  globalDb = null;
  globalSqlite = null;
}

// ── Migrations ─────────────────────────────────────────────────────────────

const GLOBAL_MIGRATIONS: Array<(sqlite: DatabaseSync) => void> = [
  // v1: projects table (no FK constraints — cross-DB references not supported)
  (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  },
];

function runGlobalMigrations(sqlite: DatabaseSync): void {
  const row = sqlite.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  const current = row?.user_version ?? 0;
  if (current >= GLOBAL_DB_VERSION) return;

  sqlite.exec("BEGIN");
  try {
    for (let version = current; version < GLOBAL_DB_VERSION; version++) {
      GLOBAL_MIGRATIONS[version](sqlite);
    }
    sqlite.exec(`PRAGMA user_version = ${GLOBAL_DB_VERSION}`);
    sqlite.exec("COMMIT");
  } catch (err) {
    sqlite.exec("ROLLBACK");
    throw err;
  }
}

// ── One-time seed migration ───────────────────────────────────────────────

/**
 * Migrate project rows from a per-project DB's `projects` table into
 * the global DB. Idempotent — only inserts rows whose `id` doesn't
 * already exist in the global DB.
 *
 * Opens the source DB via a lightweight DatabaseSync (not the app's
 * openDb singleton) to avoid side effects.
 */
export function migrateProjectsToGlobal(
  targetDb: DrizzleDb,
  sourceDbPath: string,
): void {
  if (!existsSync(sourceDbPath)) return;

  let srcSqlite: DatabaseSync | null = null;
  try {
    srcSqlite = new DatabaseSync(sourceDbPath);

    // Check if the projects table exists in the source
    const tableCheck = srcSqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='projects'",
    ).get() as { name: string } | undefined;
    if (!tableCheck) return;

    const sourceRows = srcSqlite
      .prepare("SELECT id, name, path, created_at FROM projects")
      .all() as Array<{ id: string; name: string; path: string; created_at: string }>;

    for (const row of sourceRows) {
      const existing = targetDb
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.id, row.id))
        .get();
      if (existing) continue;

      targetDb.insert(schema.projects).values({
        id: row.id,
        name: row.name,
        path: row.path,
        createdAt: row.created_at,
      }).run();
    }
  } catch {
    // Source DB may not have projects table (v9 migration already ran)
    // or may not be a valid SQLite file — silently skip.
  } finally {
    try { srcSqlite?.close(); } catch { /* best-effort */ }
  }
}
