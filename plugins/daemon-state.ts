/**
 * DaemonState — in-memory client state (F10-2b).
 *
 * After F10, only the clients Map is retained. Session and port management
 * was moved to DaemonStateV2 (three-table model, 新架构 §4.1).
 *
 * Types (SessionEntry, SessionPorts) are re-exported for backward compat
 * with test fixtures and serialization helpers.
 */
import { PORT_KEYS_DEFAULT } from "./config.js";

// ============================================================
// Types (retained for backward compatibility)
// ============================================================

export type SessionPorts = Record<string, number>;

// Single source of truth lives in plugins/config.ts (see 新架构 §14.1).
// The PORT_KEYS alias is retained as a deprecated re-export for tests that
// still import from this module; new code should import from config.js.
/** @deprecated Import from "./config.js" — single source of truth. */
export const PORT_KEYS = PORT_KEYS_DEFAULT;

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
// DaemonState — clients only (F10-2b)
// ============================================================

/**
 * Daemon's in-memory client state.
 *
 * After v1 surface removal (F10), only the clients Map is retained.
 * Session and port management lives in DaemonStateV2 (§4.1).
 */
export class DaemonState {
  private clients = new Map<string, ClientEntry>();
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

  // --- Daemon Port ---

  setDaemonPort(port: number): void {
    this.daemonPort = port;
  }

  getDaemonPort(): number | null {
    return this.daemonPort;
  }

  // --- Serialization ---

  serialize(): string {
    const data = {
      clients: Object.fromEntries(this.clients),
      daemonPort: this.daemonPort,
    };
    return JSON.stringify(data, null, 2);
  }

  static deserialize(json: string): DaemonState {
    const state = new DaemonState();
    try {
      const data = JSON.parse(json);

      if (data.clients) {
        for (const [id, entry] of Object.entries(data.clients)) {
          state.clients.set(id, entry as ClientEntry);
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

  getStats(): { clientCount: number } {
    return {
      clientCount: this.clients.size,
    };
  }

  toDebugObject(): Record<string, unknown> {
    return {
      sessions: {},
      clients: Object.fromEntries(this.clients),
      allocatedPorts: [],
      worktreeIndex: {},
    };
  }
}
