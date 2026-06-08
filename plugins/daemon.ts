import http from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { FilePortAllocator, isPortAvailable, type PortAllocator } from "./port-allocator.js";
import { Mutex } from "./mutex.js";
import { DaemonState, PORT_KEYS, PORT_RANGE_START, PORT_RANGE_END, type SessionPorts } from "./daemon-state.js";
import { DaemonWAL } from "./daemon-wal.js";

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

// --- New session-aware types ---

interface ClientRegisterRequest {
  clientId?: string;
  pid?: number;
  projectPaths?: string[];
}

interface ClientHeartbeatRequest {
  clientId?: string;
}

interface SessionAllocateRequest {
  clientId?: string;
  sessionId?: string;
  projectPath?: string;
  worktreePath?: string;
}

interface SessionReleaseRequest {
  clientId?: string;
  sessionId?: string;
}

interface SessionReassignRequest {
  clientId?: string;
  sessionId?: string;
}

interface SyncDeclareRequest {
  clientId?: string;
  sessions?: Array<{
    sessionId: string;
    worktreePath: string;
    projectPath: string;
    ports?: SessionPorts | null;
  }>;
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
  private state: DaemonState;
  private wal: DaemonWAL;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastPersistedHeartbeatAt = new Map<string, number>();

  // Heartbeat timeout: clients not sending heartbeat for 90s are considered dead
  private static HEARTBEAT_TIMEOUT = 90_000;
  private static HEARTBEAT_CHECK_INTERVAL = 30_000;
  private static HEARTBEAT_PERSIST_INTERVAL = 30_000;

  constructor(options?: DaemonOptions) {
    this.port = options?.port ?? 20000;
    this.allocator = new FilePortAllocator(options?.baseDir);
    const dataDir = options?.baseDir ?? path.join(os.homedir(), ".agentdock");
    this.registryPath = path.join(dataDir, "registry.json");
    this.loadRegistry();

    // Load session state from WAL
    this.wal = new DaemonWAL(dataDir);
    this.state = this.wal.load() ?? new DaemonState();
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
        // Start heartbeat timeout cleanup
        this.heartbeatTimer = setInterval(() => {
          this.cleanupStaleClients().catch(() => {
            // Ignore errors in cleanup (e.g., mutex contention)
          });
        }, AgentDockDaemon.HEARTBEAT_CHECK_INTERVAL);
        resolve();
      });
    });
  }

  /**
   * Stop the daemon gracefully.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  /**
   * Clean up clients that haven't sent heartbeat within the timeout period.
   * Releases all sessions owned by stale clients.
   */
  private cleanupStaleClients(): Promise<void> {
    return this.mutex.runExclusive("state", () => {
      const now = Date.now();
      let changed = false;
      for (const client of this.state.listClients()) {
        if (now - client.lastHeartbeat > AgentDockDaemon.HEARTBEAT_TIMEOUT) {
          // Release all sessions owned by this client
          for (const session of this.state.listSessions()) {
            if (session.ownerClientId === client.clientId) {
              this.state.releaseSession(session.sessionId);
              changed = true;
            }
          }
          this.state.unregisterClient(client.clientId);
          this.lastPersistedHeartbeatAt.delete(client.clientId);
          changed = true;
        }
      }
      if (changed) {
        this.wal.persist(this.state);
      }
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

    // DNS Rebinding protection: validate Host header to prevent malicious
    // websites from accessing the daemon via DNS rebinding attacks.
    const host = req.headers.host;
    if (host && !host.startsWith("127.0.0.1") && !host.startsWith("localhost")) {
      this.json(res, 403, { success: false, error: "Forbidden: Invalid Host header" });
      return;
    }

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
      this.json(res, 200, { success: true, status: "ok" });
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

    // ============================================================
    // New session-aware endpoints
    // ============================================================

    // POST /client/register
    if (pathname === "/client/register" && method === "POST") {
      const body = await parseBody(req);
      const { clientId, pid, projectPaths } = body as ClientRegisterRequest;
      if (!clientId || typeof pid !== "number" || !Array.isArray(projectPaths)) {
        this.json(res, 400, { success: false, error: "clientId, pid, and projectPaths required" });
        return;
      }
      await this.mutex.runExclusive("state", () => {
        this.state.registerClient(clientId, pid, projectPaths);
        this.lastPersistedHeartbeatAt.set(clientId, this.state.getClient(clientId)?.lastHeartbeat ?? Date.now());
        this.wal.persist(this.state);
      });
      this.json(res, 200, { success: true });
      return;
    }

    // POST /client/unregister
    if (pathname === "/client/unregister" && method === "POST") {
      const body = await parseBody(req);
      const { clientId } = body as ClientHeartbeatRequest;
      if (!clientId) {
        this.json(res, 400, { success: false, error: "clientId required" });
        return;
      }
      await this.mutex.runExclusive("state", () => {
        this.state.unregisterClient(clientId);
        this.lastPersistedHeartbeatAt.delete(clientId);
        this.wal.persist(this.state);
      });
      this.json(res, 200, { success: true });
      return;
    }

    // POST /client/heartbeat
    if (pathname === "/client/heartbeat" && method === "POST") {
      const body = await parseBody(req);
      const { clientId } = body as ClientHeartbeatRequest;
      if (!clientId) {
        this.json(res, 400, { success: false, error: "clientId required" });
        return;
      }
      await this.mutex.runExclusive("state", () => {
        const before = this.state.getClient(clientId)?.lastHeartbeat ?? 0;
        this.state.heartbeat(clientId);
        const after = this.state.getClient(clientId)?.lastHeartbeat ?? before;
        const lastPersisted = this.lastPersistedHeartbeatAt.get(clientId) ?? 0;
        if (after > before && after - lastPersisted >= AgentDockDaemon.HEARTBEAT_PERSIST_INTERVAL) {
          this.lastPersistedHeartbeatAt.set(clientId, after);
          this.wal.persist(this.state);
        }
      });
      this.json(res, 200, { success: true });
      return;
    }

    // POST /sessions/allocate
    if (pathname === "/sessions/allocate" && method === "POST") {
      const body = await parseBody(req);
      const { clientId, sessionId, projectPath, worktreePath } = body as SessionAllocateRequest;
      if (!clientId || !sessionId || !projectPath || !worktreePath) {
        this.json(res, 400, { success: false, error: "clientId, sessionId, projectPath, worktreePath required" });
        return;
      }

      // Validate sessionId: alphanumeric + hyphen + underscore only
      if (!/^[a-zA-Z0-9-_]+$/.test(sessionId)) {
        this.json(res, 400, { success: false, error: "Invalid sessionId" });
        return;
      }
      // Validate worktreePath: must be absolute
      if (!path.isAbsolute(worktreePath)) {
        this.json(res, 400, { success: false, error: "worktreePath must be absolute" });
        return;
      }
      // Normalize paths to prevent duplicate detection bypass
      const normalizedWorktreePath = path.resolve(worktreePath);
      const normalizedProjectPath = path.resolve(projectPath);

      try {
        const result = await this.mutex.runExclusive("state", async () => {
          // Check if session already exists (idempotent)
          const existing = this.state.getSession(sessionId);
          if (existing) {
            return { ports: existing.ports, status: "existing" as const };
          }

          // Check for duplicate worktreePath
          const duplicate = this.state.findDuplicate(normalizedWorktreePath);
          if (duplicate) {
            return { error: `duplicate_worktree: worktreePath already claimed by session ${duplicate}`, status: "conflict" as const };
          }

          // Allocate ports
          const excluded = this.state.getExcludedPorts();
          const allocated = await this.state.allocatePorts(PORT_KEYS.length, excluded);
          const ports: SessionPorts = {
            FRONTEND_PORT: allocated[0],
            BACKEND_PORT: allocated[1],
            WS_PORT: allocated[2],
            DEBUG_PORT: allocated[3],
            PREVIEW_PORT: allocated[4],
          };

          this.state.allocateSession({
            sessionId,
            worktreePath: normalizedWorktreePath,
            projectPath: normalizedProjectPath,
            ports,
            ownerClientId: clientId,
            ownerPid: this.state.getClient(clientId)?.pid ?? 0,
          });
          this.wal.persist(this.state);

          return { ports, status: "allocated" as const };
        });

        if (result.status === "conflict") {
          this.json(res, 409, { success: false, error: result.error });
        } else {
          this.json(res, 200, { success: true, ports: result.ports });
        }
      } catch (err) {
        this.json(res, 500, { success: false, error: err instanceof Error ? err.message : "Unknown error" });
      }
      return;
    }

    // POST /sessions/release
    if (pathname === "/sessions/release" && method === "POST") {
      const body = await parseBody(req);
      const { clientId, sessionId } = body as SessionReleaseRequest;
      if (!clientId || !sessionId) {
        this.json(res, 400, { success: false, error: "clientId and sessionId required" });
        return;
      }
          const result = await this.mutex.runExclusive("state", async () => {
            const ownership = this.state.getSessionOwnership(
              sessionId,
              clientId,
              Date.now(),
              AgentDockDaemon.HEARTBEAT_TIMEOUT,
            );
            if (ownership === "missing") {
              return { status: "missing" as const };
            }
            if (ownership === "foreign") {
              return { status: "forbidden" as const };
            }

            this.state.releaseSession(sessionId);
            this.wal.persist(this.state);
            return { status: "released" as const };
          });

          if (result.status === "missing") {
            this.json(res, 404, { success: false, error: `Session ${sessionId} not found` });
          } else if (result.status === "forbidden") {
            this.json(res, 403, { success: false, error: `Session ${sessionId} is owned by another client` });
          } else {
            this.json(res, 200, { success: true });
          }
      return;
    }

    // POST /sessions/reassign
    if (pathname === "/sessions/reassign" && method === "POST") {
      const body = await parseBody(req);
      const { clientId, sessionId } = body as SessionReassignRequest;
      if (!clientId || !sessionId) {
        this.json(res, 400, { success: false, error: "clientId and sessionId required" });
        return;
      }

      try {
        const result = await this.mutex.runExclusive("state", async () => {
          const session = this.state.getSession(sessionId);
          if (!session) {
            return { status: "missing" as const };
          }

          const ownership = this.state.getSessionOwnership(
            sessionId,
            clientId,
            Date.now(),
            AgentDockDaemon.HEARTBEAT_TIMEOUT,
          );
          if (ownership === "foreign") {
            return { status: "forbidden" as const };
          }

          // Build exclusion set: all currently allocated ports + old ports
          const excluded = this.state.getExcludedPorts();
          const oldPorts = session.ports;
          for (const key of PORT_KEYS) {
            excluded.add(oldPorts[key]);
          }

          const allocated = await this.state.allocatePorts(PORT_KEYS.length, excluded);
          const newPorts: SessionPorts = {
            FRONTEND_PORT: allocated[0],
            BACKEND_PORT: allocated[1],
            WS_PORT: allocated[2],
            DEBUG_PORT: allocated[3],
            PREVIEW_PORT: allocated[4],
          };

          if (ownership === "reclaimable") {
            this.state.claimSession(sessionId, clientId, this.state.getClient(clientId)?.pid ?? session.ownerPid);
          }

          this.state.reassignSession(sessionId, newPorts);
          this.wal.persist(this.state);
          return { status: ownership === "reclaimable" ? "reclaimed" as const : "reassigned" as const, ports: newPorts };
        });

        if (result.status === "missing") {
          this.json(res, 404, { success: false, error: `Session ${sessionId} not found` });
        } else if (result.status === "forbidden") {
          this.json(res, 403, { success: false, error: `Session ${sessionId} is owned by another client` });
        } else {
          this.json(res, 200, { success: true, ports: result.ports, status: result.status });
        }
      } catch (err) {
        this.json(res, 500, { success: false, error: err instanceof Error ? err.message : "Unknown error" });
      }
      return;
    }

    // POST /sync/declare
    if (pathname === "/sync/declare" && method === "POST") {
      const body = await parseBody(req);
      const { clientId, sessions: declaredSessions } = body as SyncDeclareRequest;
      if (!clientId || !Array.isArray(declaredSessions)) {
        this.json(res, 400, { success: false, error: "clientId and sessions array required" });
        return;
      }

      try {
        const result = await this.mutex.runExclusive("state", async () => {
          const results: Array<{ sessionId: string; ports: SessionPorts; status: string }> = [];

          for (const decl of declaredSessions) {
            // Validate sessionId and worktreePath
            if (!decl.sessionId || !decl.worktreePath || !decl.projectPath) {
              results.push({ sessionId: decl.sessionId ?? "", ports: {} as SessionPorts, status: "error" });
              continue;
            }
            if (!/^[a-zA-Z0-9-_]+$/.test(decl.sessionId)) {
              results.push({ sessionId: decl.sessionId, ports: {} as SessionPorts, status: "error" });
              continue;
            }
            if (!path.isAbsolute(decl.worktreePath)) {
              results.push({ sessionId: decl.sessionId, ports: {} as SessionPorts, status: "error" });
              continue;
            }
            const normalizedWtPath = path.resolve(decl.worktreePath);
            const normalizedProjPath = path.resolve(decl.projectPath);

            const existing = this.state.getSession(decl.sessionId);
            if (existing) {
              const ownership = this.state.getSessionOwnership(
                decl.sessionId,
                clientId,
                Date.now(),
                AgentDockDaemon.HEARTBEAT_TIMEOUT,
              );

              if (ownership === "owned") {
                this.state.claimSession(
                  decl.sessionId,
                  clientId,
                  this.state.getClient(clientId)?.pid ?? existing.ownerPid,
                );
                results.push({ sessionId: decl.sessionId, ports: existing.ports, status: "existing" });
                continue;
              }

              if (ownership === "reclaimable") {
                this.state.claimSession(
                  decl.sessionId,
                  clientId,
                  this.state.getClient(clientId)?.pid ?? existing.ownerPid,
                );
                results.push({ sessionId: decl.sessionId, ports: existing.ports, status: "reclaimed" });
                continue;
              }

              results.push({ sessionId: decl.sessionId, ports: existing.ports, status: "foreign" });
              continue;
            }

            // Check for duplicate worktreePath
            const duplicate = this.state.findDuplicate(normalizedWtPath);
            if (duplicate) {
              results.push({ sessionId: decl.sessionId, ports: this.state.getSession(duplicate)!.ports, status: "conflict" });
              continue;
            }

            // New session — use provided ports or allocate new ones
            let ports: SessionPorts;
            const hasAllPorts = !!(decl.ports && PORT_KEYS.every((key) => typeof decl.ports![key] === "number"));
            const providedPortsAreBindable = hasAllPorts
              ? (await Promise.all(PORT_KEYS.map((key) => isPortAvailable(decl.ports![key])))).every(Boolean)
              : false;
            const needsRealloc = !hasAllPorts
              || !providedPortsAreBindable
              || PORT_KEYS.some((key) => this.state.isPortAllocated(decl.ports![key]));

            if (hasAllPorts && !needsRealloc) {
              // Use provided ports (from database) — no conflict
              ports = decl.ports!;
            } else {
              // Allocate new ports (no ports provided, or provided ports conflict)
              const excluded = this.state.getExcludedPorts();
              if (hasAllPorts) {
                // Also exclude the conflicting DB ports so they're not re-picked
                for (const key of PORT_KEYS) excluded.add(decl.ports![key]);
              }
              const allocated = await this.state.allocatePorts(PORT_KEYS.length, excluded);
              ports = {
                FRONTEND_PORT: allocated[0],
                BACKEND_PORT: allocated[1],
                WS_PORT: allocated[2],
                DEBUG_PORT: allocated[3],
                PREVIEW_PORT: allocated[4],
              };
            }

            this.state.allocateSession({
              sessionId: decl.sessionId,
              worktreePath: normalizedWtPath,
              projectPath: normalizedProjPath,
              ports,
              ownerClientId: clientId,
              ownerPid: this.state.getClient(clientId)?.pid ?? 0,
            });

            results.push({ sessionId: decl.sessionId, ports, status: "allocated" });
          }

          // Detect orphans: sessions in state but not declared by any client,
          // whose owner is not the current client
          const declaredIds = new Set(declaredSessions.map((s) => s.sessionId));
          const orphans: string[] = [];
          for (const session of this.state.listSessions()) {
            if (!declaredIds.has(session.sessionId) && session.ownerClientId !== clientId) {
              // Check if owner client still exists
              const owner = this.state.getClient(session.ownerClientId);
              if (!owner) {
                orphans.push(session.sessionId);
              }
            }
          }

          this.wal.persist(this.state);
          return { results, orphans };
        });

        this.json(res, 200, { success: true, ...result });
      } catch (err) {
        this.json(res, 500, { success: false, error: err instanceof Error ? err.message : "Unknown error" });
      }
      return;
    }

    // GET /sessions/list
    if (pathname === "/sessions/list" && method === "GET") {
      const sessions = this.state.listSessions().map((s) => ({
        sessionId: s.sessionId,
        worktreePath: s.worktreePath,
        projectPath: s.projectPath,
        ports: s.ports,
        ownerClientId: s.ownerClientId,
      }));
      this.json(res, 200, { success: true, sessions });
      return;
    }

    // ============================================================
    // Debug endpoints
    // ============================================================

    // GET /debug/state — full state dump
    if (pathname === "/debug/state" && method === "GET") {
      const stats = this.state.getStats();
      this.json(res, 200, { success: true, state: this.state.toDebugObject(), stats });
      return;
    }

    // GET /debug/invariants — run invariant checks
    if (pathname === "/debug/invariants" && method === "GET") {
      const result = this.state.checkInvariants();
      this.json(res, 200, { success: true, ...result });
      return;
    }

    // GET /debug/wal — WAL file status
    if (pathname === "/debug/wal" && method === "GET") {
      try {
        const fs = await import("node:fs");
        const walPath = this.wal.getPath();
        const exists = fs.existsSync(walPath);
        let walInfo: Record<string, unknown> = { exists, path: walPath };

        if (exists) {
          const stat = fs.statSync(walPath);
          walInfo.sizeBytes = stat.size;
          walInfo.lastModified = stat.mtime.toISOString();

          try {
            const content = fs.readFileSync(walPath, "utf-8");
            const parsed = JSON.parse(content);
            walInfo.isValidJson = true;
            walInfo.sessionCount = parsed.sessions ? Object.keys(parsed.sessions).length : 0;
            walInfo.clientCount = parsed.clients ? Object.keys(parsed.clients).length : 0;
          } catch {
            walInfo.isValidJson = false;
          }
        }

        this.json(res, 200, { success: true, wal: walInfo });
      } catch (err) {
        this.json(res, 500, { success: false, error: err instanceof Error ? err.message : "Unknown error" });
      }
      return;
    }

    // GET /debug/ports — port allocation details
    if (pathname === "/debug/ports" && method === "GET") {
      const sessions = this.state.listSessions();
      const bySession: Record<string, unknown> = {};
      for (const s of sessions) {
        bySession[s.sessionId] = {
          ports: PORT_KEYS.map((k) => s.ports[k]),
          named: s.ports,
        };
      }

      const totalAllocated = this.state.getAllAllocatedPorts().size;
      const rangeSize = PORT_RANGE_END - PORT_RANGE_START + 1;
      const utilization = ((totalAllocated / rangeSize) * 100).toFixed(2) + "%";

      this.json(res, 200, {
        success: true,
        totalAllocated,
        range: { start: PORT_RANGE_START, end: PORT_RANGE_END },
        utilization,
        bySession,
      });
      return;
    }

    // GET /debug/clients — client details with heartbeat status
    if (pathname === "/debug/clients" && method === "GET") {
      const now = Date.now();
      const clients = this.state.listClients().map((c) => ({
        clientId: c.clientId,
        pid: c.pid,
        projectPaths: c.projectPaths,
        lastHeartbeat: c.lastHeartbeat,
        heartbeatAge: now - c.lastHeartbeat,
        isStale: now - c.lastHeartbeat > 90_000,
      }));

      const staleCount = clients.filter((c) => c.isStale).length;

      this.json(res, 200, {
        success: true,
        clients,
        heartbeatTimeout: 90_000,
        staleCount,
      });
      return;
    }

    // POST /debug/simulate-stale — simulate client staleness for testing
    if (pathname === "/debug/simulate-stale" && method === "POST") {
      const body = await parseBody(req);
      const { clientId } = body as { clientId?: string };
      if (!clientId) {
        this.json(res, 400, { success: false, error: "clientId required" });
        return;
      }

      const client = this.state.getClient(clientId);
      if (!client) {
        this.json(res, 404, { success: false, error: "Client not found" });
        return;
      }

      // Set lastHeartbeat to 0 to simulate staleness
      client.lastHeartbeat = 0;
      this.json(res, 200, {
        success: true,
        message: `Client ${clientId} heartbeat set to 0, will be cleaned up on next check`,
      });
      return;
    }

    // POST /debug/trigger-cleanup — manually trigger cleanupStaleClients for testing
    if (pathname === "/debug/trigger-cleanup" && method === "POST") {
      await this.cleanupStaleClients();
      this.json(res, 200, { success: true, message: "Cleanup triggered" });
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
