/**
 * Headless debug server — API + Daemon only, no frontend/browser.
 *
 * Usage:
 *   bun run scripts/debug-headless.ts           # default port 20016
 *   bun run scripts/debug-headless.ts 3000      # custom port
 *
 * Starts:
 *   - Port daemon (if not already running)
 *   - HTTP server exposing all /api/* endpoints
 *
 * Does NOT start vite or open a browser.
 * Use curl / Postman / any HTTP client to test.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { readEnvFile } from "../plugins/env.js";
import { resolve } from "node:path";
import { createDb, type DrizzleDb } from "../plugins/db/index.js";
import { projects, sessions } from "../plugins/db/schema.js";
import { eq } from "drizzle-orm";
import { isGitRepo, removeOrphanDir, scanOrphanWorktrees } from "../plugins/worktree.js";
import { createHookEngine, createHookRegistry } from "../plugins/hook-engine.js";
import { loadConfig } from "../plugins/config.js";
import { createSessionLifecycle, type PortService } from "../plugins/session-lifecycle.js";
import { DaemonManager } from "../plugins/daemon-manager.js";
import type { DaemonClient } from "../plugins/daemon-client.js";
import { writePortsToEnv } from "../plugins/port-write-env.js";
import { nanoid } from "nanoid";
import { AgentDockDaemon } from "../plugins/daemon.js";
import { fileURLToPath } from "node:url";

// Load .env
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "..", ".env");
Object.assign(process.env, readEnvFile(envPath));

const port = Number(process.argv[2]) || Number(process.env.FRONTEND_PORT) || 20016;
const projectDir = process.cwd();

let db: DrizzleDb | null = null;
let _daemonClient: DaemonClient | null = null;
let _clientId = "debug_" + process.cwd().replace(/[^a-zA-Z0-9]/g, "_").slice(-20);

function getDb(): DrizzleDb {
  if (!db) db = createDb(projectDir);
  return db;
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.end(JSON.stringify(data, null, 2));
}

function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
    });
  });
}

function createPortService(client: DaemonClient): PortService {
  return {
    allocateSession: (params) => client.allocateSession({ clientId: _clientId, ...params }),
    releaseSession: (sessionId) => client.releaseSession(_clientId, sessionId),
  };
}

// --- Init daemon (inline) ---
async function initDaemon() {
  const daemon = new AgentDockDaemon({ port: 20000 });
  try {
    await daemon.start();
    console.log("  Daemon: started on port 20000");
  } catch {
    console.log("  Daemon: already running on port 20000");
  }

  const manager = new DaemonManager();
  const { client } = await manager.init();
  _daemonClient = client;
  console.log(`  Client: ${_clientId} (PID: ${process.pid})`);

  // Register + declare existing sessions
  await client.register(_clientId, process.pid, [projectDir]);
  const d = getDb();
  const allProjects = d.select().from(projects).all();
  const declared = [];
  for (const p of allProjects) {
    for (const s of d.select().from(sessions).where(eq(sessions.projectId, p.id)).all()) {
      declared.push({ sessionId: s.id, worktreePath: s.worktreePath, projectPath: p.path, ports: s.ports ? JSON.parse(s.ports) : null });
    }
  }
  if (declared.length > 0) {
    const result = await client.declareSessions(_clientId, declared);
    console.log(`  Sync: ${result.results.length} sessions declared, ${result.orphans.length} orphans`);
  }
}

// --- HTTP server ---
async function main() {
  await initDaemon();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const pathname = url.pathname;
    const method = req.method || "GET";

    // CORS preflight
    if (method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.statusCode = 204;
      res.end();
      return;
    }

    if (!pathname.startsWith("/api/")) { json(res, 404, { error: "Not found" }); return; }

    try {
      const d = getDb();

      // GET /api/projects
      if (pathname === "/api/projects" && method === "GET") {
        const allProjects = d.select().from(projects).all();
        const result = allProjects.map((p) => ({
          ...p,
          sessions: d.select().from(sessions).where(eq(sessions.projectId, p.id)).all().map((s) => ({
            ...s, ports: s.ports ? JSON.parse(s.ports) : null,
          })),
        }));
        json(res, 200, { success: true, projects: result });
        return;
      }

      // POST /api/projects/:id/sessions
      const scMatch = pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
      if (scMatch && method === "POST") {
        const projectId = scMatch[1];
        const body = await parseBody(req);
        const { name: sessionName, baseBranch } = body as { name?: string; baseBranch?: string };
        if (!sessionName) { json(res, 400, { error: "name is required" }); return; }
        const p = d.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!p) { json(res, 404, { error: "Project not found" }); return; }
        if (!isGitRepo(p.path)) { json(res, 400, { error: "Not a git repository" }); return; }
        const id = nanoid(8);
        const config = loadConfig(p.path);
        const lifecycle = createSessionLifecycle({ portService: _daemonClient ? createPortService(_daemonClient) : undefined });
        const hasAsyncHook = (config.hooks.afterCreateSession ?? []).some((h: any) => h.async);
        const result = await lifecycle.create({
          projectId, projectPath: p.path, sessionId: id, sessionName, baseBranch, config,
          onWorktreeReady: (worktreePath, branch) => {
            d.insert(sessions).values({ id, projectId, name: sessionName, branch, worktreePath, backgroundHookStatus: hasAsyncHook ? "running" : null }).run();
          },
          onBackgroundHookComplete: (report) => {
            const status = report.success ? "completed" : "failed";
            d.update(sessions).set({ backgroundHookStatus: status }).where(eq(sessions.id, id)).run();
            console.log(`  [${id}] backgroundHook → ${status}`);
          },
        });
        d.update(sessions).set({ ports: JSON.stringify(result.ports) }).where(eq(sessions.id, id)).run();
        const session = d.select().from(sessions).where(eq(sessions.id, id)).get();
        json(res, 200, { success: true, session: { ...session, ports: result.ports } });
        return;
      }

      // DELETE /api/sessions/:id
      const sMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sMatch && method === "DELETE") {
        const id = sMatch[1];
        const s = d.select().from(sessions).where(eq(sessions.id, id)).get();
        if (!s) { json(res, 404, { error: "Session not found" }); return; }
        const p = d.select().from(projects).where(eq(projects.id, s.projectId)).get();
        if (!p) { json(res, 404, { error: "Project not found" }); return; }
        const config = loadConfig(p.path);
        const lifecycle = createSessionLifecycle({ portService: _daemonClient ? createPortService(_daemonClient) : undefined });
        await lifecycle.remove({ sessionId: id, projectPath: p.path, worktreePath: s.worktreePath, config });
        d.delete(sessions).where(eq(sessions.id, id)).run();
        json(res, 200, { success: true });
        return;
      }

      // POST /api/sessions/:id/retry-hooks
      const retryMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/retry-hooks$/);
      if (retryMatch && method === "POST") {
        const id = retryMatch[1];
        const s = d.select().from(sessions).where(eq(sessions.id, id)).get();
        if (!s) { json(res, 404, { error: "Session not found" }); return; }
        if (s.backgroundHookStatus !== "failed") { json(res, 400, { error: "Session is not in failed state" }); return; }
        const p = d.select().from(projects).where(eq(projects.id, s.projectId)).get();
        if (!p) { json(res, 404, { error: "Project not found" }); return; }
        d.update(sessions).set({ backgroundHookStatus: "running" }).where(eq(sessions.id, id)).run();
        const config = loadConfig(p.path);
        const registry = createHookRegistry();
        const engine = createHookEngine(registry);
        registry.loadFromConfig(config.hooks as any);
        const ctx = { event: "afterCreateSession" as const, sessionId: id, projectId: s.projectId, projectPath: p.path, worktreePath: s.worktreePath, payload: {} };
        engine.execute("afterCreateSession", ctx).then((report) => {
          const status = report.success ? "completed" : "failed";
          d.update(sessions).set({ backgroundHookStatus: status }).where(eq(sessions.id, id)).run();
          console.log(`  [${id}] retry-hook → ${status}`);
        }).catch(() => {
          d.update(sessions).set({ backgroundHookStatus: "failed" }).where(eq(sessions.id, id)).run();
        });
        json(res, 200, { success: true });
        return;
      }

      // GET /api/sessions/:id/background-hook-status
      const bgMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/background-hook-status$/);
      if (bgMatch && method === "GET") {
        const id = bgMatch[1];
        const s = d.select().from(sessions).where(eq(sessions.id, id)).get();
        if (!s) { json(res, 404, { error: "Session not found" }); return; }
        json(res, 200, { success: true, status: s.backgroundHookStatus ?? null });
        return;
      }

      // POST /api/sessions/:id/reassign-ports
      const raMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/reassign-ports$/);
      if (raMatch && method === "POST") {
        const id = raMatch[1];
        if (!_daemonClient) { json(res, 500, { error: "Daemon not available" }); return; }
        const s = d.select().from(sessions).where(eq(sessions.id, id)).get();
        if (!s) { json(res, 404, { error: "Session not found" }); return; }
        const p = d.select().from(projects).where(eq(projects.id, s.projectId)).get();
        if (!p) { json(res, 404, { error: "Project not found" }); return; }
        const ports = await _daemonClient.reassignSession(_clientId, id);
        writePortsToEnv(s.worktreePath, ports);
        d.update(sessions).set({ ports: JSON.stringify(ports) }).where(eq(sessions.id, id)).run();
        const updated = d.select().from(sessions).where(eq(sessions.id, id)).get();
        json(res, 200, { success: true, session: { ...updated, ports } });
        return;
      }

      // GET /api/projects/:id/orphans
      const orphansMatch = pathname.match(/^\/api\/projects\/([^/]+)\/orphans$/);
      if (orphansMatch && method === "GET") {
        const projectId = orphansMatch[1];
        const p = d.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!p) { json(res, 404, { error: "Project not found" }); return; }
        const orphans = scanOrphanWorktrees(p.path);
        json(res, 200, { orphans });
        return;
      }

      // POST /api/orphans/delete
      if (pathname === "/api/orphans/delete" && method === "POST") {
        const body = await parseBody(req);
        const { paths } = body as { paths?: string[] };
        if (!Array.isArray(paths) || paths.length === 0) { json(res, 400, { error: "paths array is required" }); return; }
        const allProjects = d.select().from(projects).all();
        const validPrefixes = allProjects.map((p) => {
          const base = path.resolve(p.path, ".agentdock", "worktrees").replace(/\\/g, "/");
          return base.endsWith("/") ? base : base + "/";
        });
        const deleted: string[] = [];
        const failed: Array<{ path: string; error: string }> = [];
        for (const p of paths) {
          const resolved = path.resolve(p).replace(/\\/g, "/");
          if (!validPrefixes.some((prefix) => resolved.startsWith(prefix))) {
            failed.push({ path: p, error: "Path is not under any known project's worktree directory" });
            continue;
          }
          try { await removeOrphanDir(p); deleted.push(p); }
          catch (err) { failed.push({ path: p, error: err instanceof Error ? err.message : "Unknown error" }); }
        }
        json(res, 200, { deleted, failed });
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log("");
    console.log("  ╭──────────────────────────────────────────╮");
    console.log("  │  AgentDock Headless Debug Server          │");
    console.log(`  │  API: http://localhost:${port}              │`);
    console.log("  │  Daemon: http://localhost:20000           │");
    console.log("  ╰──────────────────────────────────────────╯");
    console.log("");
    console.log("  Endpoints:");
    console.log("    GET    /api/projects");
    console.log("    POST   /api/projects/:id/sessions");
    console.log("    DELETE /api/sessions/:id");
    console.log("    POST   /api/sessions/:id/retry-hooks");
    console.log("    GET    /api/sessions/:id/background-hook-status");
    console.log("    POST   /api/sessions/:id/reassign-ports");
    console.log("    GET    /api/projects/:id/orphans");
    console.log("    POST   /api/orphans/delete");
    console.log("");
  });

  process.on("SIGINT", () => { server.close(); process.exit(0); });
  process.on("SIGTERM", () => { server.close(); process.exit(0); });
}

main().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});
