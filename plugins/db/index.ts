import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
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
const MIGRATIONS: Array<(sqlite: Database.Database) => void> = [
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
  // v4: add sessions.background_hook_errors.
  (sqlite) => {
    addColumnIfMissing(sqlite, "sessions", "background_hook_errors", "TEXT");
  },
];

/** Target schema version after all migrations are applied. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Add a column only when it does not already exist (idempotent). */
function addColumnIfMissing(
  sqlite: Database.Database,
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

export function getDbPath(projectPath: string): string {
  return path.join(projectPath, DB_DIR, DB_FILE);
}

export function createDb(projectPath: string) {
  const dbDir = path.join(projectPath, DB_DIR);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  const dbPath = getDbPath(projectPath);
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  runMigrations(sqlite);

  return drizzle(sqlite, { schema });
}

/**
 * Apply pending migrations based on PRAGMA user_version.
 *
 * Legacy databases were created without versioning and therefore report
 * user_version = 0. Because every migration is idempotent, re-running them
 * from 0 on such a database adds only the missing pieces without touching
 * existing rows, then advances user_version to SCHEMA_VERSION.
 */
function runMigrations(sqlite: Database.Database): void {
  const current = sqlite.pragma("user_version", { simple: true }) as number;
  if (current >= SCHEMA_VERSION) return;

  const tx = sqlite.transaction(() => {
    for (let version = current; version < SCHEMA_VERSION; version++) {
      MIGRATIONS[version](sqlite);
    }
    // PRAGMA does not accept bound parameters; SCHEMA_VERSION is a trusted int.
    sqlite.pragma(`user_version = ${SCHEMA_VERSION}`);
  });
  tx();
}

export type DrizzleDb = ReturnType<typeof createDb>;
