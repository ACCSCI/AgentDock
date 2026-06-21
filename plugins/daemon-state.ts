import { PORT_KEYS_DEFAULT } from "./config.js";
import { isPortAvailable } from "./port-allocator.js";

// ============================================================
// Types
// ============================================================

export type SessionPorts = Record<string, number>;

// Single source of truth lives in plugins/config.ts (see 新架构 §14.1).
// The PORT_KEYS alias is retained as a deprecated re-export for tests that
// still import from this module; new code should import from config.js.
/** @deprecated Import from "./config.js" — single source of truth. */
export const PORT_KEYS = PORT_KEYS_DEFAULT;

export const PORT_RANGE_START = 30000;
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
  private daemonPort: number | null = null;

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

    const portKeys = Object.keys(entry.ports);

    // Defense-in-depth: reject if any port is already claimed by another session
    for (const key of portKeys) {
      const port = entry.ports[key];
      if (port === undefined) continue;
      if (this.allocatedPorts.has(port)) {
        throw new Error(
          `Port conflict: ${key}=${port} already allocated (session ${entry.sessionId})`,
        );
      }
    }

    const session: SessionEntry = {
      ...entry,
      createdAt: new Date().toISOString(),
    };

    this.sessions.set(session.sessionId, session);

    for (const key of portKeys) {
      const port = session.ports[key];
      if (port !== undefined) {
        this.allocatedPorts.add(port);
      }
    }

    this.worktreeIndex.set(session.worktreePath, session.sessionId);
  }

  releaseSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    for (const port of Object.values(session.ports)) {
      this.allocatedPorts.delete(port);
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
    for (const port of Object.values(session.ports)) {
      this.allocatedPorts.delete(port);
    }

    // Assign new ports
    session.ports = newPorts;
    for (const port of Object.values(newPorts)) {
      this.allocatedPorts.add(port);
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
   * Also excludes the daemon's listening port to prevent conflicts.
   */
  getExcludedPorts(): Set<number> {
    const excluded = new Set(this.allocatedPorts);
    if (this.daemonPort !== null) {
      excluded.add(this.daemonPort);
    }
    return excluded;
  }

  /**
   * Set the daemon's listening port so it's excluded from session allocation.
   */
  setDaemonPort(port: number): void {
    this.daemonPort = port;
  }

  /**
   * Get the daemon's listening port, if known.
   */
  getDaemonPort(): number | null {
    return this.daemonPort;
  }

  // --- Port Allocation (internal) ---

  /**
   * Allocate `count` unique ports, skipping ports in `exclude` and already-allocated ports.
   * Uses TCP probe to verify availability.
   * Returns the allocated port numbers.
   *
   * @deprecated §14.2 — 端口分配函数归位. 新代码应走 port-allocator.ts
   * `allocateNFreePorts`. 本方法保留以供 v1 /ports/allocate 兼容.
   * DaemonState 自身不应再承担端口业务逻辑, 未来 v1 surface 下线时一并删.
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
      daemonPort: this.daemonPort,
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

      if (typeof data.daemonPort === "number") {
        state.daemonPort = data.daemonPort;
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

    // Check 1: port count matches per session
    const expectedPerSession = sessions.map((s) => Object.keys(s.ports).length);
    const totalExpected = expectedPerSession.reduce((a, b) => a + b, 0);
    const actualPortCount = this.allocatedPorts.size;
    checks.push({
      name: "port_count_matches",
      passed: actualPortCount === totalExpected,
      detail: `${actualPortCount} ports, sessions have ${expectedPerSession.join("+")} = ${totalExpected}`,
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
      for (const port of Object.values(session.ports)) {
        if (port !== undefined) allPorts.push(port);
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
