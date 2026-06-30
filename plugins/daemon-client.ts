// @ts-nocheck
/**
 * DaemonClient — Hono-typed HTTP client to the AgentDock Daemon.
 *
 * A thin facade over `createDaemonClient()` from electron/main/hono-client.ts
 * (which itself wraps Hono's `hc<AppType>` proxy).
 *
 * The v1 session/port routes (/sessions/allocate, /sessions/release,
 * /sessions/reassign, /sessions/list, /ports/allocate, /ports/release,
 * /sync/declare) were removed from the daemon in F10-2a, so the class
 * only exposes the still-existing endpoints:
 *   - /health, /register, /unregister, /status (instance lifecycle)
 *   - /client/register, /client/heartbeat (Electron client lifecycle)
 *
 * Session/port management now goes through `plugins/v2-port-service.ts`
 * (raw fetch against /session/create, /claim, /session/activate, etc.).
 */
import { hc } from "hono/client";
import type { AppType } from "./daemon/app.js";
import { readDaemonInfo, isProcessAlive } from "./daemon-discovery.js";

/**
 * The Hono client shape. We re-derive it from AppType so the route surface
 * stays in sync with the daemon without manual maintenance.
 */
type HonoDaemonClient = ReturnType<typeof hc<AppType>>;

interface EnvelopeOk<T> {
  success: true;
  data?: T;
  [key: string]: unknown;
}

interface EnvelopeErr {
  success: false;
  error: string;
}

type Envelope<T> = EnvelopeOk<T> | EnvelopeErr;

/**
 * Internal helper: unwrap a daemon envelope response. Hono returns the
 * `c.json(...)` body verbatim, which is the envelope. We narrow to the
 * success shape and return the data field; on failure, throw a descriptive
 * Error so the legacy try/catch flow keeps working.
 */
async function unwrap<T>(res: Response): Promise<T> {
  const body = (await res.json()) as Envelope<T>;
  if (!body.success) {
    throw new Error(body.error || "Daemon error");
  }
  return body.data as T;
}

export class DaemonClient {
  private baseUrl: string;
  private hc: HonoDaemonClient;

  /**
   * Create a client connected to a known port.
   * @param port - The daemon's listening port.
   */
  constructor(public readonly port: number = 20000) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.hc = hc<AppType>(this.baseUrl);
  }

  /**
   * Create a client via dynamic discovery.
   * Reads daemon.json, verifies liveness, and returns a connected client.
   * Throws if no daemon is available.
   */
  static async createFromDiscovery(): Promise<DaemonClient> {
    const info = readDaemonInfo();
    if (!info || !isProcessAlive(info.pid)) {
      throw new Error("No daemon discovered: daemon.json missing or process not alive");
    }
    const client = new DaemonClient(info.port);
    if (!(await client.health())) {
      throw new Error("No daemon discovered: daemon process not responding");
    }
    return client;
  }

  /**
   * Check if the daemon is healthy.
   */
  async health(): Promise<boolean> {
    try {
      const res = await this.hc.health.$get();
      if (!res.ok) return false;
      const body = (await res.json()) as { status: string };
      return body.status === "ok";
    } catch {
      return false;
    }
  }

  /**
   * Register a directory with the daemon.
   * Fails if directory is already registered by an alive process.
   */
  async register(dir: string, pid: number): Promise<void> {
    const res = await this.hc.register.$post({ json: { dir, pid } });
    if (!res.ok) {
      throw new Error(`POST /register ${res.status}: ${await res.text()}`);
    }
    await unwrap<void>(res);
  }

  /**
   * Unregister a directory from the daemon.
   */
  async unregister(dir: string, _pid: number): Promise<void> {
    const res = await this.hc.unregister.$post({ json: { dir } });
    if (!res.ok) {
      throw new Error(`POST /unregister ${res.status}: ${await res.text()}`);
    }
    await unwrap<void>(res);
  }

  /**
   * Get status of all registered instances.
   */
  async status(): Promise<{ instances: Array<{ dir: string; pid: number; status: string }> }> {
    const res = await this.hc.status.$get();
    if (!res.ok) {
      throw new Error(`GET /status ${res.status}`);
    }
    return unwrap(res);
  }

  // --- Client-lifecycle methods ---

  /**
   * Register a client with the daemon.
   */
  async registerClient(clientId: string, pid: number, projectPaths: string[]): Promise<void> {
    const res = await this.hc.client.register.$post({ json: { clientId, pid, projectPaths } });
    if (!res.ok) {
      throw new Error(`POST /client/register ${res.status}: ${await res.text()}`);
    }
    await unwrap<void>(res);
  }

  /**
   * Send a heartbeat to keep the client alive.
   */
  async heartbeat(clientId: string): Promise<void> {
    const res = await this.hc.client.heartbeat.$post({ json: { clientId } });
    if (!res.ok) {
      throw new Error(`POST /client/heartbeat ${res.status}: ${await res.text()}`);
    }
    await unwrap<void>(res);
  }
}

// Re-export the typed Hono factory for new code paths that don't need
// the class wrapper. Electron main will use this directly in Phase 3+.
export { createDaemonClient } from "../electron/main/hono-client.js";
export type { DaemonHonoClient } from "../electron/main/hono-client.js";
