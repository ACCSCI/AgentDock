import path from "node:path";
import { updateEnvFile } from "./env.js";
import { PORT_KEYS, type SessionPorts } from "./daemon-state.js";

/**
 * Write port values to a worktree's .env file.
 */
export function writePortsToEnv(worktreePath: string, ports: SessionPorts): void {
  const envPath = path.join(worktreePath, ".env");
  const updates: Record<string, string> = {};
  for (const key of PORT_KEYS) {
    updates[key] = String(ports[key]);
  }
  updateEnvFile(envPath, updates);
}
