import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { updateEnvFile } from "./env.js";
import { allocatePorts } from "./port-pool.js";

const AGENTDOCK_DIR = ".agentdock";
const REGISTRY_FILE = "port-registry.json";

export interface SessionPorts {
  FRONTEND_PORT: number;
  BACKEND_PORT: number;
  WS_PORT: number;
  DEBUG_PORT: number;
  PREVIEW_PORT: number;
}

export const PORT_KEYS: (keyof SessionPorts)[] = [
  "FRONTEND_PORT",
  "BACKEND_PORT",
  "WS_PORT",
  "DEBUG_PORT",
  "PREVIEW_PORT",
];

export interface PortRegistryEntry {
  sessionId: string;
  ports: SessionPorts;
}

function getRegistryPath(projectPath: string): string {
  return path.join(projectPath, AGENTDOCK_DIR, REGISTRY_FILE);
}

/**
 * Load the port registry from disk. Returns [] if file doesn't exist.
 */
export function loadRegistry(projectPath: string): PortRegistryEntry[] {
  const filePath = getRegistryPath(projectPath);
  if (!existsSync(filePath)) return [];
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as PortRegistryEntry[];
  } catch {
    return [];
  }
}

/**
 * Save the port registry to disk.
 */
export function saveRegistry(
  projectPath: string,
  entries: PortRegistryEntry[],
): void {
  const filePath = getRegistryPath(projectPath);
  const dir = path.dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, JSON.stringify(entries, null, 2), "utf-8");
}

/**
 * Get all currently allocated ports across all sessions.
 */
function getAllAllocatedPorts(projectPath: string): Set<number> {
  const entries = loadRegistry(projectPath);
  const ports = new Set<number>();
  for (const entry of entries) {
    for (const key of PORT_KEYS) {
      ports.add(entry.ports[key]);
    }
  }
  return ports;
}

/**
 * Collect allocated ports from multiple projects' registries.
 */
export function loadGlobalAllocatedPorts(projectPaths: string[]): Set<number> {
  const ports = new Set<number>();
  for (const p of projectPaths) {
    for (const port of getAllAllocatedPorts(p)) {
      ports.add(port);
    }
  }
  return ports;
}

function portsArray(ports: SessionPorts): number[] {
  return PORT_KEYS.map((k) => ports[k]);
}

/**
 * Assign 5 ports to a session. Idempotent — returns existing ports if already assigned.
 * Also writes the ports to the session's .env file.
 * @param globalExcludedPorts - Ports to exclude beyond the current project (cross-project).
 */
export async function assignSessionPorts(
  projectPath: string,
  sessionId: string,
  worktreePath: string,
  globalExcludedPorts?: Set<number>,
): Promise<SessionPorts> {
  const entries = loadRegistry(projectPath);
  const existing = entries.find((e) => e.sessionId === sessionId);
  if (existing) {
    // Ensure .env is up to date
    writePortsToEnv(worktreePath, existing.ports);
    return existing.ports;
  }

  const localExcluded = getAllAllocatedPorts(projectPath);
  const excluded = globalExcludedPorts
    ? new Set([...localExcluded, ...globalExcludedPorts])
    : localExcluded;

  const allocated = await allocatePorts(PORT_KEYS.length, excluded);
  const ports: SessionPorts = {
    FRONTEND_PORT: allocated[0],
    BACKEND_PORT: allocated[1],
    WS_PORT: allocated[2],
    DEBUG_PORT: allocated[3],
    PREVIEW_PORT: allocated[4],
  };

  entries.push({ sessionId, ports });
  saveRegistry(projectPath, entries);
  writePortsToEnv(worktreePath, ports);

  return ports;
}

/**
 * Get ports for a specific session, or null if not found.
 */
export function getSessionPorts(
  projectPath: string,
  sessionId: string,
): SessionPorts | null {
  const entries = loadRegistry(projectPath);
  return entries.find((e) => e.sessionId === sessionId)?.ports ?? null;
}

/**
 * Release a session's ports from the registry.
 */
export function releaseSessionPorts(
  projectPath: string,
  sessionId: string,
): void {
  const entries = loadRegistry(projectPath);
  const idx = entries.findIndex((e) => e.sessionId === sessionId);
  if (idx === -1) return;
  entries.splice(idx, 1);
  saveRegistry(projectPath, entries);
}

/**
 * Release old ports and assign new ones.
 * Old ports are excluded from the new allocation to guarantee different values.
 */
export async function reassignSessionPorts(
  projectPath: string,
  sessionId: string,
  worktreePath: string,
  globalExcludedPorts?: Set<number>,
): Promise<SessionPorts> {
  const oldPorts = getSessionPorts(projectPath, sessionId);
  releaseSessionPorts(projectPath, sessionId);

  if (!oldPorts) {
    return assignSessionPorts(projectPath, sessionId, worktreePath, globalExcludedPorts);
  }

  // Add old ports to the exclusion set so new allocation differs
  const entries = loadRegistry(projectPath);
  const excluded = new Set<number>(portsArray(oldPorts));
  for (const entry of entries) {
    for (const key of PORT_KEYS) {
      excluded.add(entry.ports[key]);
    }
  }
  // Merge with global excluded ports
  if (globalExcludedPorts) {
    for (const port of globalExcludedPorts) {
      excluded.add(port);
    }
  }

  const allocated = await allocatePorts(PORT_KEYS.length, excluded);
  const ports: SessionPorts = {
    FRONTEND_PORT: allocated[0],
    BACKEND_PORT: allocated[1],
    WS_PORT: allocated[2],
    DEBUG_PORT: allocated[3],
    PREVIEW_PORT: allocated[4],
  };

  entries.push({ sessionId, ports });
  saveRegistry(projectPath, entries);
  writePortsToEnv(worktreePath, ports);

  return ports;
}

function writePortsToEnv(worktreePath: string, ports: SessionPorts): void {
  const envPath = path.join(worktreePath, ".env");
  const updates: Record<string, string> = {};
  for (const key of PORT_KEYS) {
    updates[key] = String(ports[key]);
  }
  updateEnvFile(envPath, updates);
}
