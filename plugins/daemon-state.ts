import { isPortAvailable } from "./port-allocator.js";

// ============================================================
// Types
// ============================================================

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

export const PORT_RANGE_START = 20000;
export const PORT_RANGE_END = 65535;

export interface SessionEntry {
  sessionId: string;
  worktreePath: string;
  projectPath: string;
  ports: SessionPorts;
  ownerClientId: string;
  ownerPid: number;
  createdAt: string;
}

export interface ClientEntry {
  clientId: string;
  pid: number;
  projectPaths: string[];
  lastHeartbeat: number;
}

// ============================================================
// DaemonState — In-memory state model (Single Source of Truth)
// ============================================================

/**
 * Daemon's authoritative in-memory state.
 *
 * Owns:
 *  - sessions: Map<sessionId, SessionEntry>
 *  - clients: Map<clientId, ClientEntry>
 *  - allocatedPorts: Set<number>
 *  - worktreeIndex: Map<worktreePath, sessionId>
 *
 * This class is pure in-memory — persistence is handled by DaemonWAL.
 */
export class DaemonState {
  private sessions = new Map<string, SessionEntry>();
  private clients = new Map<string, ClientEntry>();
  private allocatedPorts = new Set<number>();
  private worktreeIndex = new Map<string, string>();

  // --- Client Management ---

  registerClient(clientId: string, pid: number, projectPaths: string[]): void {
    this.clients.set(clientId, {
      clientId,
      pid,
      projectPaths,
      lastHeartbeat: Date.now(),
    });
  }

  unregisterClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  heartbeat(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.lastHeartbeat = Date.now();
    }
  }

  getClient(clientId: string): ClientEntry | null {
    return this.clients.get(clientId) ?? null;
  }

  listClients(): ClientEntry[] {
    return [...this.clients.values()];
  }

  // --- Session Management ---

  allocateSession(entry: Omit<SessionEntry, "createdAt">): void {
    if (this.sessions.has(entry.sessionId)) {
      throw new Error(`Session ${entry.sessionId} already exists`);
    }

    // Defense-in-depth: reject if any port is already claimed by another session
    for (const key of PORT_KEYS) {
      if (this.allocatedPorts.has(entry.ports[key])) {
        throw new Error(
          `Port conflict: ${key}=${entry.ports[key]} already allocated (session ${entry.sessionId})`,
        );
      }
    }

    const session: SessionEntry = {
      ...entry,
      createdAt: new Date().toISOString(),
    };

    this.sessions.set(session.sessionId, session);

    for (const key of PORT_KEYS) {
      this.allocatedPorts.add(session.ports[key]);
    }

    this.worktreeIndex.set(session.worktreePath, session.sessionId);
  }

  releaseSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const key of PORT_KEYS) {
      this.allocatedPorts.delete(session.ports[key]);
    }

    this.worktreeIndex.delete(session.worktreePath);
    this.sessions.delete(sessionId);
  }

  reassignSession(sessionId: string, newPorts: SessionPorts): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Free old ports
    for (const key of PORT_KEYS) {
      this.allocatedPorts.delete(session.ports[key]);
    }

    // Assign new ports
    session.ports = newPorts;
    for (const key of PORT_KEYS) {
      this.allocatedPorts.add(newPorts[key]);
    }
  }

  getSession(sessionId: string): SessionEntry | null {
    return this.sessions.get(sessionId) ?? null;
  }

  isSessionOwnedBy(sessionId: string, clientId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.ownerClientId === clientId;
  }

  getSessionOwnership(
    sessionId: string,
    clientId: string,
    now: number,
    staleAfterMs: number,
  ): "missing" | "owned" | "reclaimable" | "foreign" {
    const session = this.sessions.get(sessionId);
    if (!session) return "missing";
    if (session.ownerClientId === clientId) return "owned";

    const owner = this.clients.get(session.ownerClientId);
    if (!owner || now - owner.lastHeartbeat > staleAfterMs) {
      return "reclaimable";
    }

    return "foreign";
  }

  claimSession(sessionId: string, clientId: string, ownerPid: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    session.ownerClientId = clientId;
    session.ownerPid = ownerPid;
  }

  listSessions(): SessionEntry[] {
    return [...this.sessions.values()];
  }

  // --- Query ---

  findSessionByWorktree(worktreePath: string): string | null {
    return this.worktreeIndex.get(worktreePath) ?? null;
  }

  /**
   * Check if a worktreePath is already claimed by a different session.
   * Returns the existing sessionId if duplicate, null otherwise.
   */
  findDuplicate(worktreePath: string): string | null {
    return this.worktreeIndex.get(worktreePath) ?? null;
  }

  isPortAllocated(port: number): boolean {
    return this.allocatedPorts.has(port);
  }

  getAllAllocatedPorts(): Set<number> {
    return new Set(this.allocatedPorts);
  }

  /**
   * Get all allocated ports as an exclude set for port allocation.
   */
  getExcludedPorts(): Set<number> {
    return new Set(this.allocatedPorts);
  }

  // --- Port Allocation (internal) ---

  /**
   * Allocate `count` unique ports, skipping ports in `exclude` and already-allocated ports.
   * Uses TCP probe to verify availability.
   * Returns the allocated port numbers.
   */
  async allocatePorts(count: number, exclude?: Set<number>): Promise<number[]> {
    const combined = new Set<number>(this.allocatedPorts);
    if (exclude) {
      for (const p of exclude) combined.add(p);
    }

    const result: number[] = [];
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      if (result.length >= count) break;
      if (combined.has(port)) continue;

      if (await isPortAvailable(port)) {
        result.push(port);
        combined.add(port);
      }
    }

    if (result.length < count) {
      throw new Error(
        `Could not allocate ${count} ports (only found ${result.length} available)`,
      );
    }

    return result;
  }

  // --- Serialization ---

  serialize(): string {
    const data = {
      sessions: Object.fromEntries(this.sessions),
      clients: Object.fromEntries(this.clients),
      allocatedPorts: [...this.allocatedPorts],
      worktreeIndex: Object.fromEntries(this.worktreeIndex),
    };
    return JSON.stringify(data, null, 2);
  }

  static deserialize(json: string): DaemonState {
    const state = new DaemonState();
    try {
      const data = JSON.parse(json);

      if (data.sessions) {
        for (const [id, entry] of Object.entries(data.sessions)) {
          state.sessions.set(id, entry as SessionEntry);
        }
      }

      if (data.clients) {
        for (const [id, entry] of Object.entries(data.clients)) {
          state.clients.set(id, entry as ClientEntry);
        }
      }

      if (Array.isArray(data.allocatedPorts)) {
        for (const port of data.allocatedPorts) {
          state.allocatedPorts.add(port);
        }
      }

      if (data.worktreeIndex) {
        for (const [wt, sid] of Object.entries(data.worktreeIndex)) {
          state.worktreeIndex.set(wt, sid as string);
        }
      }
    } catch {
      // Return empty state on corrupt data
    }
    return state;
  }

  // --- Diagnostics ---

  /**
   * Get statistics about the current state.
   */
  getStats(): { sessionCount: number; clientCount: number; allocatedPortCount: number } {
    return {
      sessionCount: this.sessions.size,
      clientCount: this.clients.size,
      allocatedPortCount: this.allocatedPorts.size,
    };
  }

  /**
   * Run invariant checks and return results.
   */
  checkInvariants(): { valid: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> } {
    const checks: Array<{ name: string; passed: boolean; detail: string }> = [];
    const sessions = this.listSessions();

    // Check 1: port count matches (5 per session)
    const expectedPortCount = sessions.length * 5;
    const actualPortCount = this.allocatedPorts.size;
    checks.push({
      name: "port_count_matches",
      passed: actualPortCount === expectedPortCount,
      detail: `${actualPortCount} ports, ${sessions.length} sessions × 5 = ${expectedPortCount}`,
    });

    // Check 2: worktree index consistent
    let worktreeMismatches = 0;
    for (const session of sessions) {
      const indexedId = this.worktreeIndex.get(session.worktreePath);
      if (indexedId !== session.sessionId) worktreeMismatches++;
    }
    checks.push({
      name: "worktree_index_consistent",
      passed: worktreeMismatches === 0,
      detail: worktreeMismatches === 0
        ? `${this.worktreeIndex.size} entries, all match sessions`
        : `${worktreeMismatches} mismatches found`,
    });

    // Check 3: no duplicate ports
    const allPorts: number[] = [];
    for (const session of sessions) {
      for (const key of PORT_KEYS) {
        allPorts.push(session.ports[key]);
      }
    }
    const uniquePorts = new Set(allPorts);
    checks.push({
      name: "no_duplicate_ports",
      passed: uniquePorts.size === allPorts.length,
      detail: `${uniquePorts.size} unique ports out of ${allPorts.length} total`,
    });

    // Check 4: no duplicate worktrees
    const worktreePaths = sessions.map((s) => s.worktreePath);
    const uniqueWorktrees = new Set(worktreePaths);
    checks.push({
      name: "no_duplicate_worktrees",
      passed: uniqueWorktrees.size === worktreePaths.length,
      detail: `${uniqueWorktrees.size} unique worktrees out of ${worktreePaths.length} total`,
    });

    // Check 5: all allocated ports belong to sessions
    let orphanedPorts = 0;
    for (const port of this.allocatedPorts) {
      if (!allPorts.includes(port)) orphanedPorts++;
    }
    checks.push({
      name: "all_ports_belong_to_sessions",
      passed: orphanedPorts === 0,
      detail: orphanedPorts === 0
        ? `${this.allocatedPorts.size}/${this.allocatedPorts.size} ports mapped`
        : `${orphanedPorts} ports not mapped to any session`,
    });

    const valid = checks.every((c) => c.passed);
    return { valid, checks };
  }

  /**
   * Serialize state to a plain object for JSON responses.
   */
  toDebugObject(): Record<string, unknown> {
    return {
      sessions: Object.fromEntries(this.sessions),
      clients: Object.fromEntries(this.clients),
      allocatedPorts: [...this.allocatedPorts],
      worktreeIndex: Object.fromEntries(this.worktreeIndex),
    };
  }
}
