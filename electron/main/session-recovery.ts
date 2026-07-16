import { existsSync } from "node:fs";
import type { SessionPorts } from "../../plugins/daemon-state.js";
import type { ProjectRow, SessionRow } from "../../plugins/db/schema.js";
import { log } from "../../plugins/logger.js";
import type { SessionManager } from "./session-manager.js";

export interface SessionRecoveryResult {
  restored: number;
  skipped: number;
}

function parsePersistedPorts(raw: string | null): SessionPorts | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entries = Object.entries(parsed);
    if (entries.length === 0) return null;
    const values = entries.map(([, value]) => value);
    if (
      values.some(
        (value) =>
          typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535,
      ) ||
      new Set(values).size !== values.length
    ) {
      return null;
    }
    return parsed as SessionPorts;
  } catch {
    return null;
  }
}

/**
 * Rebuild the in-memory session and port ownership state from persisted DB
 * rows before any new session can allocate ports.
 */
export function restorePersistedSessions(
  sessionRows: SessionRow[],
  projectRows: ProjectRow[],
  sessionManager: SessionManager,
  pathExists: (path: string) => boolean = existsSync,
): SessionRecoveryResult {
  const projectPaths = new Map(projectRows.map((project) => [project.id, project.path]));
  let restored = 0;
  let skipped = 0;

  for (const row of sessionRows) {
    const projectPath = projectPaths.get(row.projectId);
    const ports = parsePersistedPorts(row.ports);
    if (!projectPath || !ports || !pathExists(row.worktreePath)) {
      skipped++;
      continue;
    }

    try {
      sessionManager.restoreSession({
        sessionId: row.id,
        projectPath,
        displayName: row.name,
        ports,
        status: row.status === "creating" ? "creating" : "active",
        createdAt: Number.isFinite(Date.parse(row.createdAt))
          ? Date.parse(row.createdAt)
          : Date.now(),
      });
      restored++;
    } catch (err) {
      skipped++;
      log.warn({ err, sessionId: row.id }, "failed to restore persisted session");
    }
  }

  return { restored, skipped };
}
