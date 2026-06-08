import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Plugin } from "vite";
import { type DrizzleDb, createDb } from "./db/index.js";
import { projects, sessions } from "./db/schema.js";
import path from "node:path";
import { isGitRepo, removeOrphanDir, removeWorktree, renameWorktree, scanDiskWorktrees, scanOrphanWorktrees } from "./worktree.js";
import { validateProjectPath } from "./path-validation.js";
import { createHookEngine, createHookRegistry } from "./hook-engine.js";
import { loadConfig } from "./config.js";
import { createSessionLifecycle, type PortService } from "./session-lifecycle.js";
import { DaemonManager } from "./daemon-manager.js";
import type { DaemonClient } from "./daemon-client.js";
import { writePortsToEnv } from "./port-write-env.js";

let db: DrizzleDb | null = null;
let _terminalInitialized = false;
let _daemonClient: DaemonClient | null = null;
let _sessionStatuses = new Map<string, "allocated" | "reclaimed">();
// Stable clientId based on cwd — reuses same ID across restarts from same directory
let _clientId: string = "client_" + process.cwd().replace(/[^a-zA-Z0-9]/g, "_").slice(-20);
// Disk scan throttling: only scan once per project per 30 seconds
const _lastScanTime = new Map<string, number>();
const SCAN_THROTTLE_MS = 30_000;

/**
 * Create a PortService adapter from the DaemonClient for session lifecycle.
 */
function createPortService(client: DaemonClient): PortService {
  return {
    allocateSession: (params) => client.allocateSession({
      clientId: _clientId,
      ...params,
    }),
    releaseSession: (sessionId) => client.releaseSession(_clientId, sessionId).then(() => {}),
  };
}

/**
 * Start periodic heartbeat to keep the client alive with the daemon.
 * The daemon cleans up clients that don't send heartbeat within 90 seconds.
 * Returns the interval timer so the caller can clear it on shutdown.
 */
export function startDaemonHeartbeat(
  client: DaemonClient,
  clientId: string,
  intervalMs: number = 30_000,
): ReturnType<typeof setInterval> {
  return setInterval(() => {
    client.heartbeat(clientId).catch(() => {});
  }, intervalMs);
}

function getDb(): DrizzleDb {
  if (!db) { db = createDb(process.cwd()); }
  return db;
}

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
    req.on("error", (err) => reject(err));
  });
}

function syncProjectPortsToDb(
  d: DrizzleDb,
  projectId: string,
  daemonSessions: Map<string, { sessionId: string; ports: any; worktreePath: string; projectPath: string }>,
): void {
  const projectSessions = d.select().from(sessions).where(eq(sessions.projectId, projectId)).all();
  for (const session of projectSessions) {
    const daemonSession = daemonSessions.get(session.id);
    if (!daemonSession) continue;

    const dbPorts = session.ports ? JSON.parse(session.ports) : null;
    const daemonPortsJson = JSON.stringify(daemonSession.ports);
    if (!dbPorts || JSON.stringify(dbPorts) !== daemonPortsJson) {
      d.update(sessions).set({ ports: daemonPortsJson }).where(eq(sessions.id, session.id)).run();
      writePortsToEnv(session.worktreePath, daemonSession.ports);
    }
  }
}

function getSessionUiStatus(sessionId: string, ownerClientId?: string | null): "existing" | "foreign" | "allocated" | "reclaimed" {
  const transient = _sessionStatuses.get(sessionId);
  if (transient === "allocated" || transient === "reclaimed") return transient;
  if (ownerClientId && ownerClientId !== _clientId) return "foreign";
  return "existing";
}

async function declareDiscoveredSession(
  d: DrizzleDb,
  projectId: string,
  projectPath: string,
  wt: { sessionId: string; worktreePath: string; branch: string },
): Promise<{ ports: any; status: string } | null> {
  if (!_daemonClient) return null;
  const result = await _daemonClient.declareSessions(_clientId, [{
    sessionId: wt.sessionId,
    worktreePath: wt.worktreePath,
    projectPath,
    ports: null,
  }]);
  const declared = result.results.find((r) => r.sessionId === wt.sessionId);
  if (!declared?.ports) return null;

  writePortsToEnv(wt.worktreePath, declared.ports);
  d.insert(sessions).values({
    id: wt.sessionId,
    projectId,
    name: `Session ${wt.sessionId}`,
    branch: wt.branch,
    worktreePath: wt.worktreePath,
    ports: JSON.stringify(declared.ports),
  }).run();
  return { ports: declared.ports, status: declared.status };
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

export function apiPlugin(): Plugin {
  return {
    name: "vite-plugin-agentdock-api",
    configureServer(server) {
      const cwd = process.cwd();

      // Initialize daemon: detect or start, register client, declare sessions
      const initDaemon = async () => {
        try {
          const manager = new DaemonManager();
          const { client, started } = await manager.init();
          _daemonClient = client;

          // Register this client with daemon
          await client.registerClient(_clientId, process.pid, [cwd]);
          console.log(`  Registered client: ${_clientId} (PID: ${process.pid})`);

          if (started) {
            console.log(`  Port daemon started on port 20000`);
          } else {
            console.log(`  Connected to existing port daemon`);
          }

          // Startup sync: declare existing sessions
          try {
            const d = getDb();
            const allProjects = d.select().from(projects).all();
            const declaredSessions: Array<{ sessionId: string; worktreePath: string; projectPath: string; ports?: any }> = [];
            for (const p of allProjects) {
              const pSessions = d.select().from(sessions).where(eq(sessions.projectId, p.id)).all();
              for (const s of pSessions) {
                declaredSessions.push({
                  sessionId: s.id,
                  worktreePath: s.worktreePath,
                  projectPath: p.path,
                  ports: s.ports ? JSON.parse(s.ports) : null,
                });
              }
            }

            if (declaredSessions.length > 0) {
              const syncResult = await client.declareSessions(_clientId, declaredSessions);
              console.log(`  Startup sync: ${syncResult.results.length} sessions declared, ${syncResult.orphans.length} orphans`);

              // Write ports for newly allocated or reconciled sessions
              for (const r of syncResult.results) {
                if (r.ports) {
                  const s = declaredSessions.find((d) => d.sessionId === r.sessionId);
                  if (s) {
                    writePortsToEnv(s.worktreePath, r.ports);
                    d.update(sessions).set({ ports: JSON.stringify(r.ports) }).where(eq(sessions.id, r.sessionId)).run();
                    if (r.status === "allocated" || r.status === "reclaimed") {
                      _sessionStatuses.set(r.sessionId, r.status);
                    }
                  }
                }
              }
            }
          } catch (syncErr) {
            console.warn(`  Startup sync failed: ${syncErr instanceof Error ? syncErr.message : syncErr}`);
          }

          // Start heartbeat to keep client alive (daemon cleans up after 90s without heartbeat)
          startDaemonHeartbeat(client, _clientId);
        } catch (err) {
          console.warn(`  Daemon unavailable: ${err instanceof Error ? err.message : err}`);
        }
      };
      initDaemon();

      // �ӳٳ�ʼ�� Terminal WebSocket ���񣨶�̬ import ���� Vite config ����ʱ�Ӵ�ԭ��ģ�飩
      const initTerminal = async () => {
        if (_terminalInitialized || !server.httpServer) return;
        _terminalInitialized = true;
        try {
          const { createTerminalWebSocket } = await import("./terminal-ws.js");
          const { terminalManager } = await import("./terminal-manager.js");
          createTerminalWebSocket(server.httpServer as any);

          // �����˳�ʱ�������� PTY
          const cleanupTerminals = () => { terminalManager.killAll(); };
          process.on("exit", cleanupTerminals);
          process.on("SIGINT", () => { cleanupTerminals(); process.exit(0); });
          process.on("SIGTERM", () => { cleanupTerminals(); process.exit(0); });
        } catch (err) {
          console.error("[api] Failed to initialize terminal:", err);
        }
      };
      // �첽�������������м��
      initTerminal();

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const pathname = new URL(req.url || "/", `http://${req.headers.host}`).pathname;
        const method = req.method || "GET";

        if (!pathname.startsWith("/api/")) { next(); return; }

        // POST /api/init
        if (pathname === "/api/init" && method === "POST") {
          const body = await parseBody(req);
          const { projectPath } = body as { projectPath?: string };
          if (!projectPath) { json(res, 400, { error: "projectPath is required" }); return; }
          let safePath: string;
          try { safePath = validateProjectPath(projectPath); }
          catch (err) { json(res, 400, { error: err instanceof Error ? err.message : "Invalid projectPath" }); return; }
          try { db = createDb(safePath); json(res, 200, { success: true }); }
          catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // GET /api/projects
        if (pathname === "/api/projects" && method === "GET") {
          try {
            const d = getDb();
            // Auto-sync: scan disk worktrees not yet in DB
            // Also fetch ports from Daemon for sessions missing ports
            let daemonSessions: Map<string, any> = new Map();
            if (_daemonClient) {
              try {
                const list = await _daemonClient.listSessions();
                for (const s of list) daemonSessions.set(s.sessionId, s);
              } catch {}
            }

            const allProjects = d.select().from(projects).all();
            for (const p of allProjects) {
              syncProjectPortsToDb(d, p.id, daemonSessions);
              // Throttle disk scan: only scan once per project per 30 seconds
              const now = Date.now();
              const lastScan = _lastScanTime.get(p.id) ?? 0;
              if (now - lastScan < SCAN_THROTTLE_MS) continue;
              _lastScanTime.set(p.id, now);

              const diskWts = scanDiskWorktrees(p.path);
              const existingSessions = d.select().from(sessions).where(eq(sessions.projectId, p.id)).all();
              const existingIds = new Set(existingSessions.map((s) => s.id));
              for (const wt of diskWts) {
                if (!existingIds.has(wt.sessionId)) {
                  const daemonSession = daemonSessions.get(wt.sessionId);
                  if (daemonSession) {
                    d.insert(sessions).values({
                      id: wt.sessionId,
                      projectId: p.id,
                      name: `Session ${wt.sessionId}`,
                      branch: wt.branch,
                      worktreePath: wt.worktreePath,
                      ports: JSON.stringify(daemonSession.ports),
                    }).run();
                    writePortsToEnv(wt.worktreePath, daemonSession.ports);
                  } else {
                    let declaredResult: { ports: any; status: string } | null = null;
                    try { declaredResult = await declareDiscoveredSession(d, p.id, p.path, wt); } catch (e) {
                      console.warn(`  Failed to declare discovered session ${wt.sessionId}: ${e}`);
                    }
                    if (declaredResult) {
                      _sessionStatuses.set(wt.sessionId, declaredResult.status === "reclaimed" ? "reclaimed" : "allocated");
                      daemonSessions.set(wt.sessionId, {
                        sessionId: wt.sessionId,
                        worktreePath: wt.worktreePath,
                        projectPath: p.path,
                        ports: declaredResult.ports,
                      });
                    } else {
                      d.insert(sessions).values({
                        id: wt.sessionId,
                        projectId: p.id,
                        name: `Session ${wt.sessionId}`,
                        branch: wt.branch,
                        worktreePath: wt.worktreePath,
                        ports: null,
                      }).run();
                    }
                  }
                }
              }

              syncProjectPortsToDb(d, p.id, daemonSessions);
              // Clean up sessions whose worktree no longer exists on disk
              const diskWtIds = new Set(diskWts.map((w) => w.sessionId));
              for (const s of existingSessions) {
                if (!diskWtIds.has(s.id)) {
                  // Worktree deleted from disk — release ports and remove from DB
                  if (_daemonClient) {
                    try { await _daemonClient.releaseSession(_clientId, s.id); } catch {}
                  }
                  d.delete(sessions).where(eq(sessions.id, s.id)).run();
                }
              }
              // Reset stale backgroundHookStatus: if the server was killed while an
              // async afterCreateSession hook was running, the onBackgroundHookComplete
              // callback never fired, leaving backgroundHookStatus stuck at "running".
              // On restart/sync, the async hook process is dead — reset to null.
              for (const s of existingSessions) {
                if (diskWtIds.has(s.id) && s.backgroundHookStatus === "running") {
                  d.update(sessions).set({ backgroundHookStatus: null }).where(eq(sessions.id, s.id)).run();
                }
              }
            }
            // Re-fetch after sync
            const refreshed = d.select().from(projects).all();
            const result = refreshed.map((p) => ({
              ...p,
              sessions: d.select().from(sessions).where(eq(sessions.projectId, p.id)).all().map((s) => {
                const daemonSession = daemonSessions.get(s.id);
                const status = getSessionUiStatus(s.id, daemonSession?.ownerClientId ?? null);
                return {
                  ...s,
                  ports: s.ports ? JSON.parse(s.ports) : null,
                  status,
                  ownerClientId: daemonSession?.ownerClientId ?? null,
                  canSelect: status !== "foreign",
                  canDelete: status !== "foreign",
                  canReassign: status !== "foreign",
                  canRename: status !== "foreign",
                };
              }),
            }));
            json(res, 200, { success: true, projects: result });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // POST /api/sync �� manual sync for a specific project
        if (pathname === "/api/sync" && method === "POST") {
          const body = await parseBody(req);
          const { projectPath } = body as { projectPath?: string };
          if (!projectPath) { json(res, 400, { error: "projectPath is required" }); return; }
          let safePath: string;
          try { safePath = validateProjectPath(projectPath); }
          catch (err) { json(res, 400, { error: err instanceof Error ? err.message : "Invalid projectPath" }); return; }
          try {
            const d = getDb();
            const project = d.select().from(projects).where(eq(projects.path, safePath)).get();
            if (!project) { json(res, 404, { error: "Project not found" }); return; }
            const diskWts = scanDiskWorktrees(safePath);
            const existingSessions = d.select().from(sessions).where(eq(sessions.projectId, project.id)).all();
            const existingIds = new Set(existingSessions.map((s) => s.id));
            let synced = 0;
            for (const wt of diskWts) {
              if (!existingIds.has(wt.sessionId)) {
                let portsJson: string | null = null;
                if (_daemonClient) {
                  try {
                    const list = await _daemonClient.listSessions();
                    const daemonSession = list.find((ds) => ds.sessionId === wt.sessionId);
                    if (daemonSession) portsJson = JSON.stringify(daemonSession.ports);
                  } catch {}
                }
                d.insert(sessions).values({
                  id: wt.sessionId,
                  projectId: project.id,
                  name: `Session ${wt.sessionId}`,
                  branch: wt.branch,
                  worktreePath: wt.worktreePath,
                  ports: portsJson,
                }).run();
                synced++;
              }
            }
            json(res, 200, { success: true, synced });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // POST /api/projects
        if (pathname === "/api/projects" && method === "POST") {
          const body = await parseBody(req);
          const { name, path: projectPath } = body as { name?: string; path?: string };
          if (!name || !projectPath) { json(res, 400, { error: "name and path are required" }); return; }
          let safePath: string;
          try { safePath = validateProjectPath(projectPath); }
          catch (err) { json(res, 400, { error: err instanceof Error ? err.message : "Invalid path" }); return; }
          try {
            const d = getDb(); const id = nanoid(8);
            d.insert(projects).values({ id, name, path: safePath }).run();
            const project = d.select().from(projects).where(eq(projects.id, id)).get();
            json(res, 200, { success: true, project });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // GET /api/projects/:id/config — read agentdock.config.yaml
        const configReadMatch = pathname.match(/^\/api\/projects\/([^/]+)\/config$/);
        if (configReadMatch && method === "GET") {
          const id = configReadMatch[1];
          try {
            const d = getDb();
            const p = d.select().from(projects).where(eq(projects.id, id)).get();
            if (!p) { json(res, 404, { error: "Project not found" }); return; }
            const { loadConfig } = await import("./config.js");
            const { existsSync, readFileSync } = await import("node:fs");
            const yamlPath = path.join(p.path, "agentdock.config.yaml");
            const exists = existsSync(yamlPath);
            const config = loadConfig(p.path);
            const yaml = exists ? readFileSync(yamlPath, "utf-8") : "";
            json(res, 200, { success: true, config, exists, yaml });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // POST /api/projects/:id/config — write agentdock.config.yaml
        if (configReadMatch && method === "POST") {
          const id = configReadMatch[1];
          try {
            const d = getDb();
            const p = d.select().from(projects).where(eq(projects.id, id)).get();
            if (!p) { json(res, 404, { error: "Project not found" }); return; }
            const body = await parseBody(req);
            const { AgentDockConfigSchema } = await import("./config.js");
            const parsed = AgentDockConfigSchema.parse(body.config);
            const { stringify, Scalar } = await import("yaml");
            const hooksForYaml: Record<string, unknown[]> = {};
            if (parsed.hooks) {
              for (const event of Object.keys(parsed.hooks)) {
                hooksForYaml[event] = parsed.hooks[event].map((h) => {
                  const s = new Scalar(h.run);
                  s.type = Scalar.QUOTE_DOUBLE;
                  return { ...h, run: s };
                });
              }
            }
            const yamlContent = stringify({ ...parsed, hooks: hooksForYaml }, { indent: 2 });
            const { writeFileSync } = await import("node:fs");
            const yamlPath = path.join(p.path, "agentdock.config.yaml");
            writeFileSync(yamlPath, yamlContent, "utf-8");
            json(res, 200, { success: true, yaml: yamlContent });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // GET /api/projects/:id/files?path= — list files with git-tracked status
        const filesMatch = pathname.match(/^\/api\/projects\/([^/]+)\/files$/);
        if (filesMatch && method === "GET") {
          const id = filesMatch[1];
          try {
            const d = getDb();
            const p = d.select().from(projects).where(eq(projects.id, id)).get();
            if (!p) { json(res, 404, { error: "Project not found" }); return; }
            const { exec } = await import("node:child_process");
            const { promisify } = await import("node:util");
            const { readdir, stat } = await import("node:fs/promises");
            const execAsync = promisify(exec);
            const url = new URL(req.url!, `http://${req.headers.host}`);
            const queryPath = url.searchParams.get("path") || "";
            const targetDir = path.resolve(p.path, queryPath);
            if (!targetDir.startsWith(path.resolve(p.path))) {
              json(res, 403, { error: "Path is outside project root" }); return;
            }
            try { await stat(targetDir); } catch {
              json(res, 404, { error: "Path does not exist" }); return;
            }
            const [cachedOut, untrackedOut, modifiedOut] = await Promise.all([
              execAsync("git ls-files --cached --full-name " + JSON.stringify(queryPath || "."), { cwd: p.path, encoding: "utf-8", timeout: 5000 }),
              execAsync("git ls-files --others --exclude-standard --full-name " + JSON.stringify(queryPath || "."), { cwd: p.path, encoding: "utf-8", timeout: 5000 }),
              execAsync("git ls-files --modified --full-name " + JSON.stringify(queryPath || "."), { cwd: p.path, encoding: "utf-8", timeout: 5000 }),
            ]);
            const trackedFiles = cachedOut.stdout.trim().split("\n").filter(Boolean);
            const untrackedSet = new Set(untrackedOut.stdout.trim().split("\n").filter(Boolean));
            const modifiedSet = new Set(modifiedOut.stdout.trim().split("\n").filter(Boolean));
            const dirEntries = await readdir(targetDir, { withFileTypes: true });
            const entries = dirEntries.filter((entry) => {
              if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".agentdock") return false;
              return true;
            }).map((entry) => {
              const fullPath = path.join(targetDir, entry.name);
              const relPath = path.relative(p.path, fullPath).replace(/\\/g, "/");
              const isDir = entry.isDirectory();
              let status: "untracked" | "modified" | "tracked";
              if (isDir) {
                status = trackedFiles.some((f) => f.startsWith(relPath + "/")) ? "tracked" : "untracked";
              } else {
                status = trackedFiles.includes(relPath) ? "tracked" : "untracked";
              }
              if (modifiedSet.has(relPath) && status === "tracked") status = "modified";
              return { name: entry.name, path: relPath, isDir, status };
            });
            entries.sort((a, b) => { if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; return a.name.localeCompare(b.name); });
            json(res, 200, { success: true, entries, currentPath: path.relative(p.path, targetDir).replace(/\\/g, "/") });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // GET /api/browse-dirs?path=... — list subdirectories for project picker
        if (pathname === "/api/browse-dirs" && method === "GET") {
          const url = new URL(req.url!, `http://${req.headers.host}`);
          const targetPath = url.searchParams.get("path");
          try {
            const fs = await import("node:fs/promises");
            const nodePath = await import("node:path");
            if (!targetPath) {
              // Return root drives / common starting points
              const roots: Array<{ name: string; path: string }> = [];
              if (process.platform === "win32") {
                // Skip A: and B: (legacy floppy drives) to avoid system delays
                for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
                  const drive = `${letter}:\\`;
                  try { await fs.access(drive); roots.push({ name: drive, path: drive }); } catch {}
                }
              } else {
                roots.push({ name: "/", path: "/" });
              }
              // Also include home directory and common project dirs
              const home = process.env.HOME || process.env.USERPROFILE || "";
              if (home) {
                try { await fs.access(home); roots.push({ name: "~ (Home)", path: home }); } catch {}
                const desktop = nodePath.join(home, "Desktop");
                try { await fs.access(desktop); roots.push({ name: "Desktop", path: desktop }); } catch {}
                const documents = nodePath.join(home, "Documents");
                try { await fs.access(documents); roots.push({ name: "Documents", path: documents }); } catch {}
              }
              json(res, 200, { entries: roots });
              return;
            }
            // List subdirectories of the given path
            const resolved = nodePath.resolve(targetPath);
            try {
              const stat = await fs.stat(resolved);
              if (!stat.isDirectory()) { json(res, 400, { error: "Path is not an existing directory" }); return; }
            } catch {
              json(res, 400, { error: "Path is not an existing directory" }); return;
            }
            const entries: Array<{ name: string; path: string }> = [];
            // Add parent directory entry
            const parent = nodePath.dirname(resolved);
            if (parent !== resolved) {
              entries.push({ name: ".. (上级目录)", path: parent });
            }
            const items = await fs.readdir(resolved, { withFileTypes: true });
            for (const item of items) {
              if (item.isDirectory() && !item.name.startsWith(".")) {
                entries.push({ name: item.name, path: nodePath.join(resolved, item.name) });
              }
            }
            json(res, 200, { entries, currentPath: resolved });
          } catch (err) {
            json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
          }
          return;
        }

        // DELETE /api/projects/:id
        const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
        if (projectMatch && method === "DELETE") {
          const id = projectMatch[1];
          try {
            const d = getDb();
            const ps = d.select().from(sessions).where(eq(sessions.projectId, id)).all();
            const p = d.select().from(projects).where(eq(projects.id, id)).get();
            if (p) { for (const s of ps) { try { await removeWorktree(p.path, s.id, true); } catch {} } }
            // Release all ports for this project's sessions via daemon
            if (_daemonClient) {
              for (const s of ps) { try { await _daemonClient.releaseSession(_clientId, s.id); } catch {} }
            }
            for (const s of ps) { _sessionStatuses.delete(s.id); }
            d.delete(sessions).where(eq(sessions.projectId, id)).run();
            d.delete(projects).where(eq(projects.id, id)).run();
            json(res, 200, { success: true });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // POST /api/projects/:id/sessions
        const scMatch = pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
        if (scMatch && method === "POST") {
          const projectId = scMatch[1];
          const body = await parseBody(req);
          const { name: sessionName, baseBranch } = body as { name?: string; baseBranch?: string };
          if (!sessionName) { json(res, 400, { error: "name is required" }); return; }
          try {
            const d = getDb();
            const p = d.select().from(projects).where(eq(projects.id, projectId)).get();
            if (!p) { json(res, 404, { error: "Project not found" }); return; }
            if (!isGitRepo(p.path)) { json(res, 400, { error: "Not a git repository" }); return; }

            const acceptHeader = req.headers.accept ?? "";
            const wantsSSE = acceptHeader.includes("text/event-stream");

            if (!wantsSSE) {
              // Fallback: non-SSE request (backward compatible)
              const id = nanoid(8);
              const config = loadConfig(p.path);
              const lifecycle = createSessionLifecycle({
                portService: _daemonClient ? createPortService(_daemonClient) : undefined,
              });
              try {
                const result = await lifecycle.create({
                  projectId, projectPath: p.path, sessionId: id, sessionName, baseBranch, config,
                  onWorktreeReady: (worktreePath, branch) => {
                    d.insert(sessions).values({ id, projectId, name: sessionName, branch, worktreePath }).run();
                  },
                });
                d.update(sessions).set({ ports: JSON.stringify(result.ports) }).where(eq(sessions.id, id)).run();
                _sessionStatuses.set(id, "allocated");
                const session = d.select().from(sessions).where(eq(sessions.id, id)).get();
                json(res, 200, { success: true, session: { ...session, ports: result.ports }, syncReport: result.syncReport, hookReports: result.hookReports });
              } catch (err) {
                d.delete(sessions).where(eq(sessions.id, id)).run();
                throw err;
              }
              return;
            }

            // SSE mode
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              "Connection": "keep-alive",
            });

            const sendSSE = (event: string, data: unknown) => {
              res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            };

            const id = nanoid(8);
            const config = loadConfig(p.path);
            const lifecycle = createSessionLifecycle({
              portService: _daemonClient ? createPortService(_daemonClient) : undefined,
            });

            try {
              // Set backgroundHookStatus to "running" if any afterCreateSession hook is async
              const afterHooks = config.hooks.afterCreateSession ?? [];
              const hasAsyncHook = afterHooks.some((h) => h.async);

              const result = await lifecycle.create({
                projectId, projectPath: p.path, sessionId: id, sessionName, baseBranch, config,
                onStep: (event) => sendSSE("step", event),
                onWorktreeReady: (worktreePath, branch) => {
                  d.insert(sessions).values({
                    id, projectId, name: sessionName, branch, worktreePath,
                    backgroundHookStatus: hasAsyncHook ? "running" : null,
                  }).run();
                },
                onBackgroundHookComplete: (report) => {
                  const status = report.success ? "completed" : "failed";
                  d.update(sessions).set({ backgroundHookStatus: status }).where(eq(sessions.id, id)).run();
                },
              });
              d.update(sessions).set({ ports: JSON.stringify(result.ports) }).where(eq(sessions.id, id)).run();
              _sessionStatuses.set(id, "allocated");
              const session = d.select().from(sessions).where(eq(sessions.id, id)).get();
              sendSSE("complete", { session: { ...session, ports: result.ports }, syncReport: result.syncReport, hookReports: result.hookReports });
            } catch (err) {
              d.delete(sessions).where(eq(sessions.id, id)).run();
              sendSSE("error", { error: err instanceof Error ? err.message : "Unknown error" });
            } finally {
              res.end();
            }
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // DELETE/PATCH /api/sessions/:id
        const sMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
        if (sMatch) {
          const id = sMatch[1]; const d = getDb();

          if (method === "DELETE") {
            try {
              const s = d.select().from(sessions).where(eq(sessions.id, id)).get();
              if (!s) { json(res, 404, { error: "Session not found" }); return; }
              const p = d.select().from(projects).where(eq(projects.id, s.projectId)).get();
              if (!p) { json(res, 404, { error: "Project not found" }); return; }

              const acceptHeader = req.headers.accept ?? "";
              const wantsSSE = acceptHeader.includes("text/event-stream");

              if (!wantsSSE) {
                const config = loadConfig(p.path);
                // Kill all terminals for this session before removing worktree
                // (releases file locks on Windows)
                const { terminalManager: tm } = await import("./terminal-manager.js");
                tm.killBySession(id);
                const lifecycle = createSessionLifecycle({
                  portService: _daemonClient ? createPortService(_daemonClient) : undefined,
                });
                await lifecycle.remove({
                  sessionId: id,
                  projectPath: p.path,
                  worktreePath: s.worktreePath,
                  config,
                });
                d.delete(sessions).where(eq(sessions.id, id)).run();
                _sessionStatuses.delete(id);
                json(res, 200, { success: true });
                return;
              }

              // SSE mode
              res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              });

              const sendDelSSE = (event: string, data: unknown) => {
                res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
              };

              try {
                // Kill all terminals for this session before removing worktree
                const { terminalManager: tm } = await import("./terminal-manager.js");
                tm.killBySession(id);
                const config = loadConfig(p.path);
                const lifecycle = createSessionLifecycle({
                  portService: _daemonClient ? createPortService(_daemonClient) : undefined,
                });
                await lifecycle.remove({
                  sessionId: id,
                  projectPath: p.path,
                  worktreePath: s.worktreePath,
                  config,
                  onStep: (event) => sendDelSSE("step", event),
                });
                d.delete(sessions).where(eq(sessions.id, id)).run();
                _sessionStatuses.delete(id);
                sendDelSSE("complete", { success: true });
              } catch (err) {
                sendDelSSE("error", { error: err instanceof Error ? err.message : "Unknown error" });
              } finally {
                res.end();
              }
            } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
            return;
          }

          if (method === "PATCH") {
            try {
              const body = await parseBody(req);
              const { name: newName } = body as { name?: string };
              if (!newName) { json(res, 400, { error: "name is required" }); return; }
              const s = d.select().from(sessions).where(eq(sessions.id, id)).get();
              if (!s) { json(res, 404, { error: "Session not found" }); return; }
              const p = d.select().from(projects).where(eq(projects.id, s.projectId)).get();
              let newBranch: string | undefined;
              if (p) {
                const result = renameWorktree(p.path, id, newName, s.branch);
                newBranch = result.newBranch;
              }
              d.update(sessions).set({
                name: newName,
                ...(newBranch ? { branch: newBranch } : {}),
              }).where(eq(sessions.id, id)).run();
              const updated = d.select().from(sessions).where(eq(sessions.id, id)).get();
              json(res, 200, { success: true, session: updated });
            } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
            return;
          }
        }

        // POST /api/sessions/:id/reassign-ports
        const reassignMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/reassign-ports$/);
        if (reassignMatch && method === "POST") {
          const id = reassignMatch[1];
          try {
            const d = getDb();
            const s = d.select().from(sessions).where(eq(sessions.id, id)).get();
            if (!s) { json(res, 404, { error: "Session not found" }); return; }
            const p = d.select().from(projects).where(eq(projects.id, s.projectId)).get();
            if (!p) { json(res, 404, { error: "Project not found" }); return; }

            if (!_daemonClient) { json(res, 500, { error: "Daemon not available" }); return; }
            let ports;
            try {
              ports = await _daemonClient.reassignSession(_clientId, id);
            } catch (err) {
              // Session not in daemon state (daemon restart) — auto-register then retry
              if (err instanceof Error && err.message.includes("not found")) {
                await _daemonClient.declareSessions(_clientId, [{
                  sessionId: id,
                  worktreePath: s.worktreePath,
                  projectPath: p.path,
                  ports: s.ports ? JSON.parse(s.ports) : null,
                }]);
                ports = await _daemonClient.reassignSession(_clientId, id);
              } else {
                throw err;
              }
            }
            writePortsToEnv(s.worktreePath, ports);
            d.update(sessions).set({ ports: JSON.stringify(ports) }).where(eq(sessions.id, id)).run();
            _sessionStatuses.set(id, "allocated");
            const updated = d.select().from(sessions).where(eq(sessions.id, id)).get();
            json(res, 200, { success: true, session: { ...updated, ports } });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // POST /api/sessions/:id/retry-hooks — re-run afterCreateSession hooks for a failed session
        const retryMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/retry-hooks$/);
        if (retryMatch && method === "POST") {
          const id = retryMatch[1];
          try {
            const d = getDb();
            const s = d.select().from(sessions).where(eq(sessions.id, id)).get();
            if (!s) { json(res, 404, { error: "Session not found" }); return; }
            if (s.backgroundHookStatus !== "failed") {
              json(res, 400, { error: "Session is not in failed state" }); return;
            }
            const p = d.select().from(projects).where(eq(projects.id, s.projectId)).get();
            if (!p) { json(res, 404, { error: "Project not found" }); return; }

            // Set status to "running" immediately
            d.update(sessions).set({ backgroundHookStatus: "running" }).where(eq(sessions.id, id)).run();

            // Re-run hooks asynchronously (fire-and-forget)
            const config = loadConfig(p.path);
            const registry = createHookRegistry();
            const engine = createHookEngine(registry);
            registry.loadFromConfig(config.hooks as Record<string, import("./config.js").HookDefinition[]>);
            const ctx = {
              event: "afterCreateSession" as const,
              sessionId: id,
              projectId: s.projectId,
              projectPath: p.path,
              worktreePath: s.worktreePath,
              payload: {},
            };
            engine.execute("afterCreateSession", ctx).then((report) => {
              const status = report.success ? "completed" : "failed";
              d.update(sessions).set({ backgroundHookStatus: status }).where(eq(sessions.id, id)).run();
            }).catch(() => {
              d.update(sessions).set({ backgroundHookStatus: "failed" }).where(eq(sessions.id, id)).run();
            });

            json(res, 200, { success: true });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // GET /api/sessions/:id/background-hook-status
        const bgStatusMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/background-hook-status$/);
        if (bgStatusMatch && method === "GET") {
          const id = bgStatusMatch[1];
          try {
            const d = getDb();
            const s = d.select().from(sessions).where(eq(sessions.id, id)).get();
            if (!s) { json(res, 404, { error: "Session not found" }); return; }
            json(res, 200, { success: true, status: s.backgroundHookStatus ?? null });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // POST /api/open-explorer
        if (pathname === "/api/open-explorer" && method === "POST") {
          const body = await parseBody(req);
          const { path: dirPath } = body as { path?: string };
          if (!dirPath) { json(res, 400, { error: "path is required" }); return; }
          try {
            const { openInFileManager } = await import("./open-explorer.js");
            await openInFileManager(dirPath);
            json(res, 200, { success: true });
          } catch (err) { json(res, 400, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // ---- Terminal REST API ----

        // POST /api/sessions/:id/terminals �� Create a new terminal
        const termCreateMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/terminals$/);
        if (termCreateMatch && method === "POST") {
          const sessionId = termCreateMatch[1];
          try {
            const d = getDb();
            const s = d.select().from(sessions).where(eq(sessions.id, sessionId)).get();
            if (!s) { json(res, 404, { error: "Session not found" }); return; }
            const { terminalManager: tm } = await import("./terminal-manager.js");
            const body = await parseBody(req);
            const { shell } = body as { shell?: string };
            const terminal = await tm.create({
              sessionId,
              worktreePath: s.worktreePath,
              shell: shell ?? "default",
            });
            json(res, 200, {
              success: true,
              terminal: {
                terminalId: terminal.terminalId,
                sessionId: terminal.sessionId,
                name: terminal.name,
                shell: terminal.shell,
                status: terminal.status,
                pid: terminal.pid,
                createdAt: terminal.createdAt,
              },
            });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // GET /api/sessions/:id/terminals �� List terminals for a session
        if (termCreateMatch && method === "GET") {
          const sessionId = termCreateMatch[1];
          try {
            const { terminalManager: tm } = await import("./terminal-manager.js");
            const terminals = tm.listBySession(sessionId).map((t) => ({
              terminalId: t.terminalId,
              sessionId: t.sessionId,
              name: t.name,
              shell: t.shell,
              status: t.status,
              pid: t.pid,
              createdAt: t.createdAt,
            }));
            json(res, 200, { success: true, terminals });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // PATCH /api/terminals/:terminalId — Rename a terminal
        const termKillMatch = pathname.match(/^\/api\/terminals\/([^/]+)$/);
        if (termKillMatch && method === "PATCH") {
          const terminalId = termKillMatch[1];
          try {
            const { terminalManager: tm } = await import("./terminal-manager.js");
            const body = await parseBody(req);
            const { name } = body as { name?: string };
            if (!name || !name.trim()) { json(res, 400, { error: "name is required" }); return; }
            const terminal = tm.rename(terminalId, name.trim());
            if (!terminal) { json(res, 404, { error: "Terminal not found" }); return; }
            json(res, 200, {
              success: true,
              terminal: {
                terminalId: terminal.terminalId,
                sessionId: terminal.sessionId,
                name: terminal.name,
                shell: terminal.shell,
                status: terminal.status,
                pid: terminal.pid,
                createdAt: terminal.createdAt,
              },
            });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // DELETE /api/terminals/:terminalId — Kill a terminal
        if (termKillMatch && method === "DELETE") {
          const terminalId = termKillMatch[1];
          try {
            const { terminalManager: tm } = await import("./terminal-manager.js");
            const terminal = tm.get(terminalId);
            if (!terminal) { json(res, 404, { error: "Terminal not found" }); return; }
            tm.kill(terminalId);
            json(res, 200, { success: true });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // GET /api/projects/:id/orphans — list orphan directories for a project
        const orphansMatch = pathname.match(/^\/api\/projects\/([^/]+)\/orphans$/);
        if (orphansMatch && method === "GET") {
          const projectId = orphansMatch[1];
          try {
            const d = getDb();
            const project = d.select().from(projects).where(eq(projects.id, projectId)).get();
            if (!project) { json(res, 404, { error: "Project not found" }); return; }
            const orphans = scanOrphanWorktrees(project.path);
            json(res, 200, { orphans });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // POST /api/orphans/delete — delete selected orphan directories
        if (pathname === "/api/orphans/delete" && method === "POST") {
          try {
            const body = await parseBody(req);
            const { paths } = body as { paths?: string[] };
            if (!Array.isArray(paths) || paths.length === 0) {
              json(res, 400, { error: "paths array is required" });
              return;
            }

            // Validate: each path must be under a known project's .agentdock/worktrees/
            const d = getDb();
            const allProjects = d.select().from(projects).all();
            const validPrefixes = allProjects.map((p) => {
              const base = path.resolve(p.path, ".agentdock", "worktrees").replace(/\\/g, "/");
              return base.endsWith("/") ? base : base + "/";
            });

            const deleted: string[] = [];
            const failed: Array<{ path: string; error: string }> = [];

            for (const p of paths) {
              const resolved = path.resolve(p).replace(/\\/g, "/");
              const isUnderProject = validPrefixes.some((prefix) => resolved.startsWith(prefix));
              if (!isUnderProject) {
                failed.push({ path: p, error: "Path is not under any known project's worktree directory" });
                continue;
              }
              try {
                await removeOrphanDir(p);
                deleted.push(p);
              } catch (err) {
                failed.push({ path: p, error: err instanceof Error ? err.message : "Unknown error" });
              }
            }

            json(res, 200, { deleted, failed });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        json(res, 404, { error: "Not found" });
      });
    },
  };
}