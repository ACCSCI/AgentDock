import path from "node:path";
import { updateEnvFile } from "./env.js";
import type { SessionPorts } from "./daemon-state.js";

/**
 * Write port values to a worktree's .env file.
 */
export function writePortsToEnv(worktreePath: string, ports: SessionPorts): void {
  const envPath = path.join(worktreePath, ".env");
  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(ports)) {
    updates[key] = String(value);
  }
  updateEnvFile(envPath, updates);
}
