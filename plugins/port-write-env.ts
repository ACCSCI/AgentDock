import path from "node:path";
import type { SessionPorts } from "./daemon-state.js";
import { updateEnvFile } from "./env.js";

// @ts-nocheck
/**
 * Write AgentDock-allocated port values to the worktree's .env file.
 *
 * This file is read by dev servers (vite, next, etc.) when the session
 * runs.  The PROJECT ROOT .env is NEVER touched — it holds the user's
 * own configuration and should stay exactly as they wrote it.
 *
 * Accepts an optional `projectRoot` for backward-compat call sites but
 * ignores it — we never write there.
 */
export function writePortsToEnv(
  worktreePath: string,
  ports: SessionPorts,
  _projectRoot?: string,
): void {
  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(ports)) {
    updates[key] = String(value);
  }
  const envPath = path.join(worktreePath, ".env");
  updateEnvFile(envPath, updates);
}
