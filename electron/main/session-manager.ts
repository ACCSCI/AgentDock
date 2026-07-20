import type { SessionPorts } from "../../plugins/daemon-state.js";
import { log } from "../../plugins/logger.js";
/**
 * Session Manager — in-memory session state for the single-instance architecture.
 *
 * Replaces the Daemon's three-table model (ports, owners, sessions) with a
 * simple Map. No HTTP, no SSE, no fencing tokens, no lease renewal — a single
 * Electron process owns everything.
 */
import type { PortPoolInternal } from "./port-pool.js";

// ============================================================
// Types
// ============================================================

export interface SessionInfo {
  sessionId: string;
  projectPath: string;
  displayName: string;
  ports: SessionPorts;
  status: "creating" | "active";
  createdAt: number;
}

export interface SessionManager {
  createSession(params: {
    sessionId: string;
    projectPath: string;
    portKeys: string[];
    displayName: string;
  }): Promise<SessionPorts>;
  restoreSession(session: SessionInfo): void;
  restorePorts(sessionId: string, ports: SessionPorts): void;
  activateSession(sessionId: string): void;
  releaseSession(sessionId: string): Promise<void>;
  getSession(sessionId: string): SessionInfo | null;
  listSessions(): SessionInfo[];
  reassignPorts(sessionId: string): Promise<SessionPorts>;
  /**
   * Re-register an existing session's ports (read back from the DB) into the
   * pool + in-memory map. Called on startup / project sync so the in-memory
   * pool knows which ports are already taken — otherwise a fresh pool would
   * hand out the same ports again (the "two sessions share :30000" bug).
   */
  restoreSession(params: {
    sessionId: string;
    projectPath: string;
    displayName: string;
    ports: SessionPorts;
  }): void;
  dispose(): void;
}

// ============================================================
// Factory
// ============================================================

export function createSessionManager(portPool: PortPoolInternal): SessionManager {
  const sessions = new Map<string, SessionInfo>();

  async function createSession(params: {
    sessionId: string;
    projectPath: string;
    portKeys: string[];
    displayName: string;
  }): Promise<SessionPorts> {
    const { sessionId, projectPath, portKeys, displayName } = params;

    // Check if session already exists
    const existing = sessions.get(sessionId);
    if (existing) {
      log.warn({ sessionId }, "session-manager: session already exists, returning existing");
      return existing.ports;
    }

    // Allocate ports from the pool
    const ports = await portPool.allocate(portKeys.length, portKeys);

    // Record in the pool
    portPool.recordSessionPorts(sessionId, ports);

    // Record in our local state
    const info: SessionInfo = {
      sessionId,
      projectPath,
      displayName,
      ports,
      status: "creating",
      createdAt: Date.now(),
    };
    sessions.set(sessionId, info);

    log.info(
      { sessionId, portCount: Object.keys(ports).length },
      "session-manager: session created",
    );
    return ports;
  }

  function restoreSession(session: SessionInfo): void {
    const restored: SessionInfo = {
      ...session,
      ports: { ...session.ports },
    };
    portPool.recordSessionPorts(restored.sessionId, restored.ports);
    sessions.set(restored.sessionId, restored);
    log.info(
      { sessionId: restored.sessionId, portCount: Object.keys(restored.ports).length },
      "session-manager: persisted session restored",
    );
  }

  function restorePorts(sessionId: string, ports: SessionPorts): void {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const restored = { ...ports };
    portPool.recordSessionPorts(sessionId, restored);
    session.ports = restored;
  }

  function activateSession(sessionId: string): void {
    const session = sessions.get(sessionId);
    if (session) {
      session.status = "active";
    }
  }

  async function releaseSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) {
      log.warn({ sessionId }, "session-manager: session not found for release");
      return;
    }

    portPool.release(sessionId);
    sessions.delete(sessionId);

    log.info({ sessionId }, "session-manager: session released");
  }

  function getSession(sessionId: string): SessionInfo | null {
    return sessions.get(sessionId) ?? null;
  }

  function listSessions(): SessionInfo[] {
    return [...sessions.values()];
  }

  async function reassignPorts(sessionId: string): Promise<SessionPorts> {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Keep the old mapping reserved until replacements have been allocated.
    // If allocation fails, both SessionManager and PortPool remain unchanged.
    const portKeys = Object.keys(session.ports);
    const newPorts = await portPool.allocate(portKeys.length, portKeys);

    // Atomically swap ownership: recordSessionPorts releases the previous
    // mapping only after the replacement set is ready.
    portPool.recordSessionPorts(sessionId, newPorts);
    session.ports = newPorts;

    log.info({ sessionId }, "session-manager: ports reassigned");
    return newPorts;
  }

  function dispose(): void {
    for (const sessionId of sessions.keys()) {
      portPool.release(sessionId);
    }
    sessions.clear();
    portPool.dispose();
    log.info("session-manager: disposed all sessions");
  }

  function restoreSession(params: {
    sessionId: string;
    projectPath: string;
    displayName: string;
    ports: SessionPorts;
  }): void {
    const { sessionId, projectPath, displayName, ports } = params;
    if (!ports || Object.keys(ports).length === 0) return;
    // Idempotent: if we already track this session (e.g. it was created this
    // run), don't double-record. The pool's Set makes duplicate adds harmless
    // anyway, but skipping keeps the local map authoritative.
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        sessionId,
        projectPath,
        displayName,
        ports,
        status: "active",
        createdAt: Date.now(),
      });
    }
    // Mark these ports as allocated so future createSession() skips them.
    portPool.recordSessionPorts(sessionId, ports);
  }

  return {
    createSession,
    restoreSession,
    restorePorts,
    activateSession,
    releaseSession,
    getSession,
    listSessions,
    reassignPorts,
    restoreSession,
    dispose,
  };
}
