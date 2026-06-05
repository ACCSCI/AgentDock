import { exec } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { Plugin } from "vite";
import { type DrizzleDb, createDb } from "./db/index.js";
import { projects, sessions } from "./db/schema.js";
import { isGitRepo, removeWorktree, renameWorktree, scanDiskWorktrees } from "./worktree.js";
import { loadGlobalAllocatedPorts, releaseSessionPorts, reassignSessionPorts } from "./port-registry.js";
import { acquireLock, openExistingUrl } from "./singleton.js";
import { loadConfig } from "./config.js";
import { createSessionLifecycle } from "./session-lifecycle.js";

let db: DrizzleDb | null = null;

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
      // Singleton lock: check before Vite binds the port
      const port = server.config.server.port ?? 5173;
      const lockResult = acquireLock(port);
      if (!lockResult.acquired) {
        const url = `http://localhost:${lockResult.existing.port}`;
        console.log(`\n  ⚠ AgentDock 已在运行中 (PID: ${lockResult.existing.pid}, 端口: ${lockResult.existing.port})`);
        console.log(`  → 正在打开: ${url}\n`);
        openExistingUrl(lockResult.existing.port);
        process.exit(0);
      }

      console.log(`  🔒 AgentDock 单例锁已获取 (PID: ${process.pid})`);

      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        const pathname = new URL(req.url || "/", `http://${req.headers.host}`).pathname;
        const method = req.method || "GET";

        if (!pathname.startsWith("/api/")) { next(); return; }

        // POST /api/init
        if (pathname === "/api/init" && method === "POST") {
          const body = await parseBody(req);
          const { projectPath } = body as { projectPath?: string };
          if (!projectPath) { json(res, 400, { error: "projectPath is required" }); return; }
          try { db = createDb(projectPath); json(res, 200, { success: true }); }
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

        // POST /api/sync — manual sync for a specific project
        if (pathname === "/api/sync" && method === "POST") {
          const body = await parseBody(req);
          const { projectPath } = body as { projectPath?: string };
          if (!projectPath) { json(res, 400, { error: "projectPath is required" }); return; }
          try {
            const d = getDb();
            const project = d.select().from(projects).where(eq(projects.path, projectPath)).get();
            if (!project) { json(res, 404, { error: "Project not found" }); return; }
            const diskWts = scanDiskWorktrees(projectPath);
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
          try {
            const d = getDb(); const id = nanoid(8);
            d.insert(projects).values({ id, name, path: projectPath }).run();
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
              const result = await lifecycle.create({
                projectId, projectPath: p.path, sessionId: id, sessionName, baseBranch, config,
                onStep: (event) => sendSSE("step", event),
                onWorktreeReady: (worktreePath, branch) => {
                  d.insert(sessions).values({ id, projectId, name: sessionName, branch, worktreePath }).run();
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
              if (p) renameWorktree(p.path, id, newName);
              d.update(sessions).set({ name: newName }).where(eq(sessions.id, id)).run();
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

        // POST /api/open-explorer
        if (pathname === "/api/open-explorer" && method === "POST") {
          const body = await parseBody(req);
          const { path: dirPath } = body as { path?: string };
          if (!dirPath) { json(res, 400, { error: "path is required" }); return; }
          try { exec(`explorer "${dirPath}"`); json(res, 200, { success: true }); }
          catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
          return;
        }

        json(res, 404, { error: "Not found" });
      });
    },
  };
}
