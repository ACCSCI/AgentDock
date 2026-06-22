import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { drizzle } from "drizzle-orm/node-sqlite";
import * as schema from "./schema.js";

const DB_DIR = ".data";
const DB_FILE = "db.sqlite";

/**
 * Ordered schema migrations. Each entry brings the database from version
 * `index` to `index + 1`. Every step MUST be idempotent so that legacy
 * databases (created before versioning existed, left at user_version = 0)
 * can be re-run safely without data loss.
 *
 * SCHEMA_VERSION is derived from the number of migrations, so adding a new
 * migration automatically bumps the target version.
 */
const MIGRATIONS: Array<(sqlite: DatabaseSync) => void> = [
  // v1: base tables.
  (sqlite) => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  },
  // v2: add sessions.ports.
  (sqlite) => {
    addColumnIfMissing(sqlite, "sessions", "ports", "TEXT");
  },
  // v3: add sessions.background_hook_status.
  (sqlite) => {
    addColumnIfMissing(sqlite, "sessions", "background_hook_status", "TEXT");
  },
  // v4: add sessions.sort_order for drag-and-drop reordering.
  (sqlite) => {
    addColumnIfMissing(sqlite, "sessions", "sort_order", "INTEGER");
    // Backfill sort_order for existing rows using created_at timestamp
    sqlite.exec(`
      UPDATE sessions
      SET sort_order = CAST(strftime('%s', created_at) AS INTEGER) * 1000
      WHERE sort_order IS NULL
    `);
  },
  // v5: add sessions.background_hook_errors.
  (sqlite) => {
    addColumnIfMissing(sqlite, "sessions", "background_hook_errors", "TEXT");
  },
];

/** Target schema version after all migrations are applied. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Add a column only when it does not already exist (idempotent). */
function addColumnIfMissing(
  sqlite: DatabaseSync,
  table: string,
  column: string,
  type: string,
): void {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (cols.some((c) => c.name === column)) return;
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/**
 * Read PRAGMA user_version. node:sqlite has no .pragma() helper like
 * better-sqlite3, so we use a prepared SELECT — PRAGMAs return a single
 * row with a single column whose name matches the pragma.
 */
function getUserVersion(sqlite: DatabaseSync): number {
  const row = sqlite.prepare("PRAGMA user_version").get() as
    | { user_version: number }
    | undefined;
  return row?.user_version ?? 0;
}

export function getDbPath(projectPath: string): string {
  return path.join(projectPath, DB_DIR, DB_FILE);
}

/**
 * Open the project DB and return both the Drizzle wrapper and the
 * underlying `node:sqlite` handle. Migrations are applied before return.
 *
 * Callers that need to close the connection (e.g. the IPC layer when
 * switching projects) should hold onto `sqlite` and call `.close()` on
 * teardown. The legacy `createDb(projectPath)` helper below returns just
 * the Drizzle wrapper for backward compatibility with the unit tests.
 */
export function openDb(projectPath: string): {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: DatabaseSync;
} {
  const dbDir = path.join(projectPath, DB_DIR);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = getDbPath(projectPath);
  const sqlite = new DatabaseSync(dbPath);
  // node:sqlite has no .pragma() shortcut — issue raw PRAGMA statements.
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");

  runMigrations(sqlite);

  return { db: drizzle({ client: sqlite, schema }), sqlite };
}

export function createDb(projectPath: string) {
  return openDb(projectPath).db;
}

/**
 * Apply pending migrations based on PRAGMA user_version.
 *
 * Legacy databases were created without versioning and therefore report
 * user_version = 0. Because every migration is idempotent, re-running them
 * from 0 on such a database adds only the missing pieces without touching
 * existing rows, then advances user_version to SCHEMA_VERSION.
 *
 * node:sqlite has no `.transaction(fn)` wrapper; we drive BEGIN/COMMIT/
 * ROLLBACK manually so the migration set is atomic.
 */
function runMigrations(sqlite: DatabaseSync): void {
  const current = getUserVersion(sqlite);
  if (current >= SCHEMA_VERSION) return;

  sqlite.exec("BEGIN");
  try {
    for (let version = current; version < SCHEMA_VERSION; version++) {
      MIGRATIONS[version](sqlite);
    }
    // PRAGMA does not accept bound parameters; SCHEMA_VERSION is a trusted int.
    sqlite.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    sqlite.exec("COMMIT");
  } catch (err) {
    sqlite.exec("ROLLBACK");
    throw err;
  }
}

export type DrizzleDb = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Process-wide active DB singleton. Every layer that needs the project's
 * Drizzle handle (IPC handlers in db/sessions/worktree-shell) reads from
 * here so they all share the same connection + WAL session.
 *
 * Lifecycle:
 *   - `ensureActiveDb(projectPath)` opens (or returns the cached) handle.
 *     Called from `db:init` and lazily from any handler that needs a DB.
 *   - `resetActiveDb()` closes the current handle. Called from `db:init`
 *     when switching projects so WAL/SHM file handles are released
 *     (Windows EBUSY mitigation).
 *   - `getActiveDb()` returns the cached handle without opening; callers
 *     that need DB-or-throw should use `requireActiveDb()`.
 */
let activeDb: DrizzleDb | null = null;
let activeSqlite: DatabaseSync | null = null;
let activeProjectPath: string | null = null;

export function getActiveDb(): DrizzleDb | null {
  return activeDb;
}

export function getActiveProjectPath(): string | null {
  return activeProjectPath;
}

export function requireActiveDb(): DrizzleDb {
  if (!activeDb) {
    throw new Error(
      "DB not initialized: call db:init with a projectPath first",
    );
  }
  return activeDb;
}

export function ensureActiveDb(projectPath: string): DrizzleDb {
  if (activeProjectPath === projectPath && activeDb) return activeDb;
  resetActiveDb();
  const { db, sqlite } = openDb(projectPath);
  activeDb = db;
  activeSqlite = sqlite;
  activeProjectPath = projectPath;
  return activeDb;
}

export function resetActiveDb(): void {
  if (activeSqlite) {
    try {
      activeSqlite.close();
    } catch {
      // Best-effort; on Windows a still-checkpointing WAL may surface
      // here, but we're discarding the handle either way.
    }
  }
  activeDb = null;
  activeSqlite = null;
  activeProjectPath = null;
}
