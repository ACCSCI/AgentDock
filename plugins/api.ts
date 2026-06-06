import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Plugin } from "vite";
import { type DrizzleDb, createDb } from "./db/index.js";
import { projects, sessions } from "./db/schema.js";
import { isGitRepo, removeWorktree, renameWorktree, scanDiskWorktrees } from "./worktree.js";
import { validateProjectPath } from "./path-validation.js";
import { loadGlobalAllocatedPorts, releaseSessionPorts, reassignSessionPorts } from "./port-registry.js";
import { loadConfig } from "./config.js";
import { createSessionLifecycle } from "./session-lifecycle.js";
import { DaemonManager } from "./daemon-manager.js";
import { setPortAllocator } from "./port-pool.js";

let db: DrizzleDb | null = null;
let _terminalInitialized = false;

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

      // Initialize daemon: detect or start, register directory
      const initDaemon = async () => {
        try {
          const manager = new DaemonManager();
          const { client, started } = await manager.init();
          setPortAllocator(client);

          // Register this directory with daemon
          await client.register(cwd, process.pid);
          console.log(`  ?? Registered directory: ${cwd} (PID: ${process.pid})`);

          if (started) {
            console.log(`  ?? Port daemon started on port 20000`);
          } else {
            console.log(`  ?? Connected to existing port daemon`);
          }

          // Unregister on exit
          process.on("exit", () => {
            client.unregister(cwd, process.pid).catch(() => {});
          });
          process.on("SIGINT", () => {
            client.unregister(cwd, process.pid).catch(() => {});
            process.exit(0);
          });
          process.on("SIGTERM", () => {
            client.unregister(cwd, process.pid).catch(() => {});
            process.exit(0);
          });
        } catch (err) {
          console.warn(`  ? Daemon unavailable: ${err instanceof Error ? err.message : err}`);
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
            const allProjects = d.select().from(projects).all();
            for (const p of allProjects) {
              const diskWts = scanDiskWorktrees(p.path);
              const existingSessions = d.select().from(sessions).where(eq(sessions.projectId, p.id)).all();
              const existingIds = new Set(existingSessions.map((s) => s.id));
              for (const wt of diskWts) {
                if (!existingIds.has(wt.sessionId)) {
                  d.insert(sessions).values({
                    id: wt.sessionId,
                    projectId: p.id,
                    name: `Session ${wt.sessionId}`,
                    branch: wt.branch,
                    worktreePath: wt.worktreePath,
                  }).run();
                }
              }
            }
            // Re-fetch after sync
            const refreshed = d.select().from(projects).all();
            const result = refreshed.map((p) => ({
              ...p,
              sessions: d.select().from(sessions).where(eq(sessions.projectId, p.id)).all().map((s) => ({
                ...s,
                ports: s.ports ? JSON.parse(s.ports) : null,
              })),
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
                d.insert(sessions).values({
                  id: wt.sessionId,
                  projectId: project.id,
                  name: `Session ${wt.sessionId}`,
                  branch: wt.branch,
                  worktreePath: wt.worktreePath,
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

        // DELETE /api/projects/:id
        const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
        if (projectMatch && method === "DELETE") {
          const id = projectMatch[1];
          try {
            const d = getDb();
            const ps = d.select().from(sessions).where(eq(sessions.projectId, id)).all();
            const p = d.select().from(projects).where(eq(projects.id, id)).get();
            if (p) { for (const s of ps) { try { await removeWorktree(p.path, s.id, true); } catch {} } }
            // Release all ports for this project's sessions
            if (p) { for (const s of ps) { try { await releaseSessionPorts(p.path, s.id); } catch {} } }
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
              const allProjectPaths = d.select().from(projects).all().map((proj) => proj.path);
              const globalExcluded = loadGlobalAllocatedPorts(allProjectPaths);
              const config = loadConfig(p.path);
              const lifecycle = createSessionLifecycle({ globalExcludedPorts: globalExcluded });
              try {
                const result = await lifecycle.create({
                  projectId, projectPath: p.path, sessionId: id, sessionName, baseBranch, config,
                  onWorktreeReady: (worktreePath, branch) => {
                    d.insert(sessions).values({ id, projectId, name: sessionName, branch, worktreePath }).run();
                  },
                });
                d.update(sessions).set({ ports: JSON.stringify(result.ports) }).where(eq(sessions.id, id)).run();
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
            const allProjectPaths = d.select().from(projects).all().map((proj) => proj.path);
            const globalExcluded = loadGlobalAllocatedPorts(allProjectPaths);
            const config = loadConfig(p.path);
            const lifecycle = createSessionLifecycle({ globalExcludedPorts: globalExcluded });

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
                const lifecycle = createSessionLifecycle();
                await lifecycle.remove({
                  sessionId: id,
                  projectPath: p.path,
                  worktreePath: s.worktreePath,
                  config,
                });
                d.delete(sessions).where(eq(sessions.id, id)).run();
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
                const lifecycle = createSessionLifecycle();
                await lifecycle.remove({
                  sessionId: id,
                  projectPath: p.path,
                  worktreePath: s.worktreePath,
                  config,
                  onStep: (event) => sendDelSSE("step", event),
                });
                d.delete(sessions).where(eq(sessions.id, id)).run();
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
            const allProjectPaths = d.select().from(projects).all().map((proj) => proj.path);
            const globalExcluded = loadGlobalAllocatedPorts(allProjectPaths);
            const ports = await reassignSessionPorts(p.path, id, s.worktreePath, globalExcluded);
            d.update(sessions).set({ ports: JSON.stringify(ports) }).where(eq(sessions.id, id)).run();
            const updated = d.select().from(sessions).where(eq(sessions.id, id)).get();
            json(res, 200, { success: true, session: { ...updated, ports } });
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
              shell: t.shell,
              status: t.status,
              pid: t.pid,
              createdAt: t.createdAt,
            }));
            json(res, 200, { success: true, terminals });
          } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        // DELETE /api/terminals/:terminalId �� Kill a terminal
        const termKillMatch = pathname.match(/^\/api\/terminals\/([^/]+)$/);
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

        json(res, 404, { error: "Not found" });
      });
    },
  };
}