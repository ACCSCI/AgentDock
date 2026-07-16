// @ts-nocheck
/**
 * Test-side filesystem + DB inspection helpers.
 *
 * These open the project's `.data/db.sqlite` directly (no IPC) so a
 * spec can assert on what was actually persisted — bypassing any cache
 * or stale-view layer in the renderer. They also enumerate the
 * `.agentdock/worktrees/` tree for cleanup verification and call the
 * daemon's `/debug/state` for cross-checks.
 *
 * Used by both individual specs and the electron-fixture's failure
 * attachment path.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDbPath } from "../../plugins/db/index";

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: string;
}

export interface SessionRow {
  id: string;
  project_id: string;
  name: string;
  branch: string;
  worktree_path: string;
  ports: string | null;
  background_hook_status: string | null;
  background_hook_errors: string | null;
  sort_order: number | null;
  created_at: string;
}

export interface DbDump {
  projects: ProjectRow[];
  sessions: SessionRow[];
}

/**
 * Open `.data/db.sqlite` directly and dump both tables. Read-only
 * (uses DatabaseSync but never writes). Closes the handle before
 * returning so the caller doesn't tie up the WAL.
 *
 * Returns empty arrays — never throws — if the DB file doesn't exist
 * (test ran before `db:init`).
 */
export function dumpDb(projectPath: string): DbDump {
  const dbPath = getDbPath(projectPath);
  if (!existsSync(dbPath)) return { projects: [], sessions: [] };
  // Intentionally NOT opening with `readOnly: true` — a read-only
  // node:sqlite connection on a WAL-mode database can show a stale
  // snapshot (the writer's uncommitted WAL frames aren't always
  // visible). A normal connection plus an explicit `PRAGMA
  // wal_checkpoint(PASSIVE)` flushes pending writes so we read the
  // truly current state.
  const sqlite = new DatabaseSync(dbPath);
  try {
    sqlite.exec("PRAGMA wal_checkpoint(PASSIVE)");
    const projects = sqlite.prepare("SELECT * FROM projects").all() as unknown as ProjectRow[];
    const sessions = sqlite
      .prepare("SELECT * FROM sessions ORDER BY sort_order, id")
      .all() as unknown as SessionRow[];
    return { projects, sessions };
  } finally {
    try {
      sqlite.close();
    } catch {
      // Best-effort.
    }
  }
}

/**
 * Render `.agentdock/worktrees/` as a small text tree (depth = 2)
 * so failure attachments are scannable. Returns "<missing>" when the
 * directory doesn't exist.
 */
export function dumpWorktreeTree(projectPath: string): string {
  const root = join(projectPath, ".agentdock", "worktrees");
  if (!existsSync(root)) return "<missing>";
  const lines: string[] = [root];
  const entries = readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    const full = join(root, e.name);
    let st: ReturnType<typeof statSync> | null = null;
    try {
      st = statSync(full);
    } catch {
      // Symlink target or transient disappearance; skip.
    }
    if (!st) continue;
    lines.push(`  ${e.name}${st.isDirectory() ? "/" : ""}`);
    if (st.isDirectory()) {
      try {
        const inner = readdirSync(full);
        for (const f of inner.slice(0, 20)) {
          lines.push(`    ${f}`);
        }
        if (inner.length > 20) lines.push(`    ... (${inner.length - 20} more)`);
      } catch {
        // Permission or transient; skip.
      }
    }
  }
  return lines.join("\n");
}

export interface DaemonStateSnapshot {
  sessions: Array<{
    sessionId: string;
    ports: Record<string, number>;
    worktreePath: string;
    ownerClientId?: string;
  }>;
  raw?: unknown;
}

/**
 * Pull the daemon's view of session state. Used to cross-check that a
 * delete actually released the daemon's allocation, not just the DB row.
 *
 * The daemon URL is whatever the renderer's `bootstrap:health` reports
 * (the test passes it in so we don't duplicate discovery here).
 */
export async function dumpDaemonState(daemonBaseUrl: string): Promise<DaemonStateSnapshot> {
  const res = await fetch(`${daemonBaseUrl}/sessions/list`);
  if (!res.ok) {
    throw new Error(`daemon /sessions/list failed: ${res.status}`);
  }
  const body = (await res.json()) as {
    sessions: DaemonStateSnapshot["sessions"];
  };
  return { sessions: body.sessions, raw: body };
}
