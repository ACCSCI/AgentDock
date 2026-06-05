import http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { FilePortAllocator, type PortAllocator } from "./port-allocator.js";
import { Mutex } from "./mutex.js";

// ============================================================
// Types
// ============================================================

export interface DaemonOptions {
  /** Port the daemon listens on. Default: 20000 */
  port?: number;
  /** Base directory for FilePortAllocator. Default: ~/.agentdock */
  baseDir?: string;
}

interface AllocateRequest {
  count?: number;
  exclude?: number[];
}

interface ReleaseRequest {
  ports: number[];
}

interface RegisterRequest {
  dir?: string;
  pid?: number;
}

interface RegistryEntry {
  dir: string;
  pid: number;
  startedAt: string;
}

interface DaemonResponse {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ============================================================
// Daemon
// ============================================================

/**
 * AgentDock Daemon — HTTP server that owns a FilePortAllocator.
 *
 * Endpoints:
 *   POST /ports/allocate  { count?: number, exclude?: number[] }
 *   POST /ports/release   { ports: number[] }
 *   GET  /health          → { status: "ok" }
 *
 * The daemon ensures no duplicate allocations across concurrent clients
 * via the Mutex + FilePortAllocator's file-level locking.
 */
export class AgentDockDaemon {
  private server: http.Server | null = null;
  private allocator: PortAllocator;
  private mutex = new Mutex();
  private port: number;
  private registry: Map<string, RegistryEntry> = new Map();
  private registryPath: string;

  constructor(options?: DaemonOptions) {
    this.port = options?.port ?? 20000;
    this.allocator = new FilePortAllocator(options?.baseDir);
    const dataDir = options?.baseDir ?? path.join(os.homedir(), ".agentdock");
    this.registryPath = path.join(dataDir, "registry.json");
    this.loadRegistry();
  }

  /**
   * Start the daemon HTTP server.
   * Returns a promise that resolves when the server is listening.
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));

      this.server.on("error", reject);

      this.server.listen(this.port, "127.0.0.1", () => {
        resolve();
      });
    });
  }

  /**
   * Stop the daemon gracefully.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  /**
   * The port the daemon is listening on (useful when port=0 was used).
   */
  getPort(): number {
    const addr = this.server?.address();
    if (addr && typeof addr === "object") {
      return addr.port;
    }
    return this.port;
  }

  // --- Registry ---

  private loadRegistry(): void {
    if (!existsSync(this.registryPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.registryPath, "utf-8"));
      for (const [dir, entry] of Object.entries(data)) {
        this.registry.set(dir, entry as RegistryEntry);
      }
    } catch { /* ignore corrupt file */ }
  }

  private saveRegistry(): void {
    const dir = path.dirname(this.registryPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const data: Record<string, RegistryEntry> = {};
    for (const [key, entry] of this.registry) {
      data[key] = entry;
    }
    writeFileSync(this.registryPath, JSON.stringify(data, null, 2), "utf-8");
  }

  private isProcessAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  // --- Request handling ---

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const pathname = new URL(req.url || "/", `http://${req.headers.host}`).pathname;
    const method = req.method || "GET";

    // The daemon is a local-only IPC server bound to 127.0.0.1. Its legitimate
    // clients (daemon-client.ts) use raw http.request and never send an Origin
    // header. A browser performing a cross-site/drive-by request WILL send an
    // Origin header. So: reject any state-changing (POST) request that carries
    // an Origin header to prevent CSRF-style attacks from web pages. We also do
    // NOT advertise a permissive CORS policy.
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method !== "GET" && req.headers.origin) {
      this.json(res, 403, {
        success: false,
        error: "Forbidden: cross-origin requests are not allowed",
      });
      return;
    }

    // Health check
    if (pathname === "/health" && method === "GET") {
      this.json(res, 200, { status: "ok" });
      return;
    }

    // POST /ports/allocate
    if (pathname === "/ports/allocate" && method === "POST") {
      const body = await parseBody(req);
      const { count = 5, exclude = [] } = body as AllocateRequest;

      if (typeof count !== "number" || count < 1 || count > 100) {
        this.json(res, 400, { success: false, error: "count must be 1-100" });
        return;
      }

      if (!Array.isArray(exclude)) {
        this.json(res, 400, { success: false, error: "exclude must be an array" });
        return;
      }

      try {
        const ports = await this.mutex.runExclusive("ports", () =>
          this.allocator.allocate(count, new Set(exclude)),
        );
        this.json(res, 200, { success: true, data: { ports } });
      } catch (err) {
        this.json(res, 500, {
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
      return;
    }

    // POST /ports/release
    if (pathname === "/ports/release" && method === "POST") {
      const body = await parseBody(req);
      const { ports } = body as ReleaseRequest;

      if (!Array.isArray(ports) || ports.length === 0) {
        this.json(res, 400, { success: false, error: "ports must be a non-empty array" });
        return;
      }

      try {
        await this.mutex.runExclusive("ports", () =>
          this.allocator.release(ports),
        );
        this.json(res, 200, { success: true });
      } catch (err) {
        this.json(res, 500, {
          success: false,
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
      return;
    }

    // POST /register
    if (pathname === "/register" && method === "POST") {
      const body = await parseBody(req);
      const { dir, pid } = body as RegisterRequest;
      if (!dir || typeof pid !== "number") {
        this.json(res, 400, { success: false, error: "dir and pid required" });
        return;
      }
      const existing = this.registry.get(dir);
      if (existing && this.isProcessAlive(existing.pid)) {
        this.json(res, 409, { success: false, error: `Directory already registered by PID ${existing.pid}` });
        return;
      }
      // Stale or new — register
      this.registry.set(dir, { dir, pid, startedAt: new Date().toISOString() });
      this.saveRegistry();
      this.json(res, 200, { success: true });
      return;
    }

    // POST /unregister
    if (pathname === "/unregister" && method === "POST") {
      const body = await parseBody(req);
      const { dir } = body as { dir?: string };
      if (!dir) {
        this.json(res, 400, { success: false, error: "dir required" });
        return;
      }
      this.registry.delete(dir);
      this.saveRegistry();
      this.json(res, 200, { success: true });
      return;
    }

    // GET /status
    if (pathname === "/status" && method === "GET") {
      const instances: Array<{ dir: string; pid: number; startedAt: string; status: string }> = [];
      for (const [dir, entry] of this.registry) {
        instances.push({
          dir,
          pid: entry.pid,
          startedAt: entry.startedAt,
          status: this.isProcessAlive(entry.pid) ? "running" : "stale",
        });
      }
      this.json(res, 200, { success: true, data: { instances } });
      return;
    }

    this.json(res, 404, { success: false, error: "Not found" });
  }

  private json(res: http.ServerResponse, status: number, data: DaemonResponse): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }
}

// ============================================================
// Helpers
// ============================================================

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

// ============================================================
// CLI entry point
// ============================================================

const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith("daemon.ts") ||
    process.argv[1].endsWith("daemon.js"));

if (isMainModule) {
  const port = Number(process.env.AGENTDOCK_DAEMON_PORT) || 20000;
  const daemon = new AgentDockDaemon({ port });
  daemon.start().then(() => {
    console.log(`[daemon] listening on http://127.0.0.1:${daemon.getPort()}`);
  });
}
