/**
 * Session Manager — in-memory session state for the single-instance architecture.
 *
 * Replaces the Daemon's three-table model (ports, owners, sessions) with a
 * simple Map. No HTTP, no SSE, no fencing tokens, no lease renewal — a single
 * Electron process owns everything.
 */
import type { PortPoolInternal } from "./port-pool.js";
import type { SessionPorts } from "../../plugins/daemon-state.js";
import { log } from "../../plugins/logger.js";

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
  activateSession(sessionId: string): void;
  releaseSession(sessionId: string): Promise<void>;
  getSession(sessionId: string): SessionInfo | null;
  listSessions(): SessionInfo[];
  reassignPorts(sessionId: string): Promise<SessionPorts>;
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
    if (sessions.has(sessionId)) {
      const existing = sessions.get(sessionId)!;
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

    log.info({ sessionId, portCount: Object.keys(ports).length }, "session-manager: session created");
    return ports;
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

    // Release old ports
    portPool.release(sessionId);

    // Allocate new ports
    const portKeys = Object.keys(session.ports);
    const newPorts = await portPool.allocate(portKeys.length, portKeys);

    // Record new ports
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

  return {
    createSession,
    activateSession,
    releaseSession,
    getSession,
    listSessions,
    reassignPorts,
    dispose,
  };
}
