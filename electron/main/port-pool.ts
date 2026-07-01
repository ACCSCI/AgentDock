/**
 * Port Pool — deterministic port allocation from a configured range.
 *
 * Replaces the Daemon's `pickFreePort()` (OS-random) + three-table model
 * with a simple in-memory pool. Two modes:
 *
 *   1. PORT_STRICT=true  → only AVAILABLE_PORT_* env vars (Agent Talk)
 *   2. PORT_STRICT unset → scan configured range [start, end]
 *
 * All allocated ports are tracked in a Map<sessionId, Set<port>> so releases
 * are O(1). The `isPortAvailable()` bind-probe is reused from
 * plugins/port-allocator.ts.
 */
import { isPortAvailable } from "../../plugins/port-allocator.js";
import {
  DEFAULT_PORT_POOL_END,
  DEFAULT_PORT_POOL_START,
} from "../../plugins/constants.js";
import { log } from "../../plugins/logger.js";

// ============================================================
// Types
// ============================================================

export interface PortPoolConfig {
  start: number;
  end: number;
}

export interface PortPool {
  /** Allocate N unique ports for a session. Returns name → port map. */
  allocate(count: number, portKeys: string[]): Promise<Record<string, number>>;
  /** Release a session's ports back to the pool. */
  release(sessionId: string): void;
  /** Get all ports currently in use across all sessions. */
  getAllocatedPorts(): Set<number>;
  /** Dispose all sessions (shutdown). */
  dispose(): void;
}

export class PortPoolExhaustedError extends Error {
  constructor(needed: number, available: number) {
    super(
      `Port pool exhausted: need ${needed} ports but only ${available} available`,
    );
    this.name = "PortPoolExhaustedError";
  }
}

// ============================================================
// Config resolution
// ============================================================

/**
 * Config resolution — reads from global settings (not YAML).
 */
export async function resolvePortPoolConfig(): Promise<PortPoolConfig> {
  const { getPortPoolStart, getPortPoolEnd } = await import("../../plugins/global-settings.js");
  return {
    start: getPortPoolStart(),
    end: getPortPoolEnd(),
  };
}

// ============================================================
// PORT_STRICT candidate parsing
// ============================================================

/**
 * Parse AVAILABLE_PORT_* environment variables into a candidate list.
 * Handles duplicates, non-numeric values, and out-of-range ports.
 */
function parseAvailablePortEnv(): number[] {
  const ports = new Set<number>();
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("AVAILABLE_PORT") || key === "PORT_STRICT") continue;
    const num = parseInt(value ?? "", 10);
    if (Number.isFinite(num) && num >= 1024 && num <= 65535) {
      ports.add(num);
    } else {
      log.warn({ key, value }, "port-pool: skipping invalid AVAILABLE_PORT env var");
    }
  }
  return [...ports];
}

/**
 * Check if PORT_STRICT mode is enabled.
 */
function isPortStrict(): boolean {
  return process.env.PORT_STRICT === "true" || process.env.PORT_STRICT === "1";
}

// ============================================================
// Factory
// ============================================================

export interface PortPoolInternal extends PortPool {
  /** Record that a session was assigned these ports (called after allocate). */
  recordSessionPorts(sessionId: string, ports: Record<string, number>): void;
}

export function createPortPool(config: PortPoolConfig): PortPoolInternal {
  /** sessionId → Set<port> */
  const sessionPorts = new Map<string, Set<number>>();
  /** All ports in use (union of sessionPorts values). */
  const allocated = new Set<number>();
  // Serialize all allocate() calls through a single promise chain so two
  // concurrent create-session requests can't both probe-and-pick the same
  // ports before either one has reserved them in `allocated`. Without this,
  // a second allocate() can race past the first's bind-probe and grab ports
  // the first one is about to return.
  let allocationQueue: Promise<unknown> = Promise.resolve();

  async function allocate(
    count: number,
    portKeys: string[],
  ): Promise<Record<string, number>> {
    return allocationQueue = allocationQueue.then(async () => {
      // 1. Build candidate list
      const candidates = isPortStrict()
        ? parseAvailablePortEnv()
        : buildRangeCandidates(config.start, config.end);

      // 2. Filter out already-allocated ports
      const free = candidates.filter((p) => !allocated.has(p));

      // 3. Bind-probe the first `count` free candidates
      const result: Record<string, number> = {};
      const picked: number[] = [];

      for (const port of free) {
        if (picked.length >= count) break;

        const available = await isPortAvailable(port);
        if (!available) continue;

        picked.push(port);
        // Map port to the corresponding key by index
        const keyIndex = picked.length - 1;
        if (keyIndex < portKeys.length) {
          result[portKeys[keyIndex]] = port;
        }
      }

      if (picked.length < count) {
        throw new PortPoolExhaustedError(count, picked.length);
      }

      // Reserve immediately, inside the serialized block, so any subsequent
      // queued allocate() already sees these as in-use and won't race-pick
      // them.
      for (const port of picked) {
        allocated.add(port);
      }

      return result;
    });
  }

  function release(sessionId: string): void {
    const ports = sessionPorts.get(sessionId);
    if (!ports) return;
    for (const p of ports) {
      allocated.delete(p);
    }
    sessionPorts.delete(sessionId);
  }

  /** Call after allocate to record the mapping. */
  function recordSessionPorts(
    sessionId: string,
    ports: Record<string, number>,
  ): void {
    const portSet = new Set(Object.values(ports));
    sessionPorts.set(sessionId, portSet);
    for (const p of portSet) {
      allocated.add(p);
    }
  }

  function getAllocatedPorts(): Set<number> {
    return new Set(allocated);
  }

  function dispose(): void {
    sessionPorts.clear();
    allocated.clear();
  }

  return {
    allocate,
    release,
    getAllocatedPorts,
    dispose,
    recordSessionPorts,
  };
}

// ============================================================
// Helpers
// ============================================================

/**
 * Generate an array of candidate ports from [start, end] inclusive.
 * Sorted ascending for deterministic allocation.
 */
function buildRangeCandidates(start: number, end: number): number[] {
  const ports: number[] = [];
  for (let p = start; p <= end; p++) {
    ports.push(p);
  }
  return ports;
}
