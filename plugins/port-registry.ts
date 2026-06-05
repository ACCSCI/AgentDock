import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Mutex } from "./mutex.js";
import { updateEnvFile } from "./env.js";
import { allocatePorts } from "./port-pool.js";

const registryMutex = new Mutex();

const AGENTDOCK_DIR = ".data";
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

// ============================================================
// Internal unlocked helpers (called under mutex by public API)
// ============================================================

async function _assignPortsLocked(
  projectPath: string,
  sessionId: string,
  worktreePath: string,
  globalExcludedPorts?: Set<number>,
): Promise<SessionPorts> {
  const entries = loadRegistry(projectPath);
  const existing = entries.find((e) => e.sessionId === sessionId);
  if (existing) {
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

function _releasePortsLocked(projectPath: string, sessionId: string): void {
  const entries = loadRegistry(projectPath);
  const idx = entries.findIndex((e) => e.sessionId === sessionId);
  if (idx === -1) return;
  entries.splice(idx, 1);
  saveRegistry(projectPath, entries);
}

// ============================================================
// Public API (mutex-protected)
// ============================================================

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
  return registryMutex.runExclusive(projectPath, () =>
    _assignPortsLocked(projectPath, sessionId, worktreePath, globalExcludedPorts),
  );
}

/**
 * Get ports for a specific session, or null if not found.
 * Mutex-protected to avoid reading stale data during concurrent writes.
 */
export async function getSessionPorts(
  projectPath: string,
  sessionId: string,
): Promise<SessionPorts | null> {
  return registryMutex.runExclusive(projectPath, () => {
    const entries = loadRegistry(projectPath);
    return entries.find((e) => e.sessionId === sessionId)?.ports ?? null;
  });
}

/**
 * Release a session's ports from the registry.
 */
export async function releaseSessionPorts(
  projectPath: string,
  sessionId: string,
): Promise<void> {
  await registryMutex.runExclusive(projectPath, () => {
    _releasePortsLocked(projectPath, sessionId);
  });
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
  return registryMutex.runExclusive(projectPath, async () => {
    const entries = loadRegistry(projectPath);
    const entry = entries.find((e) => e.sessionId === sessionId);
    const oldPorts = entry?.ports ?? null;
    _releasePortsLocked(projectPath, sessionId);

    if (!oldPorts) {
      return _assignPortsLocked(projectPath, sessionId, worktreePath, globalExcludedPorts);
    }

    // Re-read after release to build exclusion set
    const freshEntries = loadRegistry(projectPath);
    const excluded = new Set<number>(portsArray(oldPorts));
    for (const e of freshEntries) {
      for (const key of PORT_KEYS) {
        excluded.add(e.ports[key]);
      }
    }
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

    freshEntries.push({ sessionId, ports });
    saveRegistry(projectPath, freshEntries);
    writePortsToEnv(worktreePath, ports);

    return ports;
  });
}

function writePortsToEnv(worktreePath: string, ports: SessionPorts): void {
  const envPath = path.join(worktreePath, ".env");
  const updates: Record<string, string> = {};
  for (const key of PORT_KEYS) {
    updates[key] = String(ports[key]);
  }
  updateEnvFile(envPath, updates);
}
