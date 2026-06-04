import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

const DB_DIR = ".agentdock";
const DB_FILE = "db.sqlite";

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

  // Create tables if they don't exist
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
      ports TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Migration: add ports column to existing sessions tables
  try {
    sqlite.exec(`ALTER TABLE sessions ADD COLUMN ports TEXT`);
  } catch {
    // Column already exists — ignore
  }

  return drizzle(sqlite, { schema });
}

export type DrizzleDb = ReturnType<typeof createDb>;
