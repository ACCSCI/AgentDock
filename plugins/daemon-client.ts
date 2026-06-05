import http from "node:http";
import type { PortAllocator } from "./port-allocator.js";

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
            resolve(JSON.parse(data));
          } catch (err) {
            reject(err);
          }
        });
      }).on("error", reject);
    });
  }
}
