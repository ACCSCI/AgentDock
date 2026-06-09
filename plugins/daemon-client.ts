import http from "node:http";
import type { PortAllocator } from "./port-allocator.js";
import type { SessionPorts } from "./daemon-state.js";

// ============================================================
// DaemonClient — HTTP client to AgentDock Daemon
// ============================================================

/**
 * HTTP client that implements PortAllocator by calling the daemon API.
 *
 * Endpoints used:
 *   POST /ports/allocate  { count, exclude } → { ports: number[] }
 *   POST /ports/release   { ports }          → { success: true }
 *   GET  /health          → { status: "ok" }
 */
export class DaemonClient implements PortAllocator {
  private baseUrl: string;

  constructor(port: number = 20000) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  async allocate(count: number, exclude?: Set<number>): Promise<number[]> {
    const res = await this.post("/ports/allocate", {
      count,
      exclude: exclude ? [...exclude] : [],
    });
    return res.data.ports;
  }

  release(ports: number[]): void {
    // Synchronous wrapper — fire and forget for release
    // The daemon processes it, and the file lock ensures consistency
    this.post("/ports/release", { ports }).catch(() => {
      // Best-effort: daemon may be down during shutdown
    });
  }

  /**
   * Check if the daemon is healthy.
   */
  async health(): Promise<boolean> {
    try {
      const res = await this.get("/health");
      return res.status === "ok";
    } catch {
      return false;
    }
  }

  /**
   * Register a directory with the daemon.
   * Fails if directory is already registered by an alive process.
   */
  async register(dir: string, pid: number): Promise<void> {
    await this.post("/register", { dir, pid });
  }

  /**
   * Unregister a directory from the daemon.
   */
  async unregister(dir: string, pid: number): Promise<void> {
    await this.post("/unregister", { dir, pid });
  }

  /**
   * Get status of all registered instances.
   */
  async status(): Promise<{ instances: Array<{ dir: string; pid: number; status: string }> }> {
    const res = await this.get("/status");
    return res.data;
  }

  // --- Session-aware methods ---

  /**
   * Register a client with the daemon.
   */
  async registerClient(clientId: string, pid: number, projectPaths: string[]): Promise<void> {
    await this.post("/client/register", { clientId, pid, projectPaths });
  }

  /**
   * Send a heartbeat to keep the client alive.
   */
  async heartbeat(clientId: string): Promise<void> {
    await this.post("/client/heartbeat", { clientId });
  }

  /**
   * Allocate a session with named ports.
   * Idempotent — returns existing ports if session already exists.
   * @param portKeys - Optional list of port variable names. Defaults to 5 standard ports.
   */
  async allocateSession(params: {
    clientId: string;
    sessionId: string;
    projectPath: string;
    worktreePath: string;
    portKeys?: string[];
  }): Promise<SessionPorts> {
    const res = await this.post("/sessions/allocate", params);
    return res.ports;
  }

  /**
   * Release a session's ports.
   */
  async releaseSession(clientId: string, sessionId: string): Promise<void> {
    await this.post("/sessions/release", { clientId, sessionId });
  }

  /**
   * Reassign ports for an existing session.
   * Returns new ports guaranteed to differ from old ones.
   */
  async reassignSession(clientId: string, sessionId: string): Promise<SessionPorts> {
    const res = await this.post("/sessions/reassign", { clientId, sessionId });
    return res.ports;
  }

  /**
   * Declare all sessions for a client (startup sync).
   * Returns results per session and list of orphaned sessions.
   */
  async declareSessions(clientId: string, sessions: Array<{
    sessionId: string;
    worktreePath: string;
    projectPath: string;
    ports?: SessionPorts | null;
    portKeys?: string[];
  }>): Promise<{
    results: Array<{ sessionId: string; ports: SessionPorts; status: string }>;
    orphans: string[];
  }> {
    const res = await this.post("/sync/declare", { clientId, sessions });
    return { results: res.results, orphans: res.orphans };
  }

  /**
   * List all sessions known to the daemon.
   */
  async listSessions(): Promise<Array<{
    sessionId: string;
    worktreePath: string;
    projectPath: string;
    ports: SessionPorts;
    ownerClientId: string;
  }>> {
    const res = await this.get("/sessions/list");
    return res.sessions;
  }

  // --- HTTP helpers ---

  private async post(path: string, body: unknown): Promise<any> {
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = http.request(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.success) {
              reject(new Error(parsed.error || "Daemon error"));
            } else {
              resolve(parsed);
            }
          } catch (err) {
            reject(err);
          }
        });
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  private async get(path: string): Promise<any> {
    return new Promise((resolve, reject) => {
      http.get(`${this.baseUrl}${path}`, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (!parsed.success) {
              reject(new Error(parsed.error || "Daemon error"));
            } else {
              resolve(parsed);
            }
          } catch (err) {
            reject(err);
          }
        });
      }).on("error", reject);
    });
  }
}
