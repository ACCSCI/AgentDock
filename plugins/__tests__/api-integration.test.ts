import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import os from "node:os";
import { createDb, type DrizzleDb } from "../db/index.js";
import { projects, sessions } from "../db/schema.js";
import { eq } from "drizzle-orm";

// We test the handler logic by importing the pieces directly
// and constructing a minimal HTTP test server.
import { isGitRepo, renameWorktree, scanDiskWorktrees } from "../worktree.js";
import { createHookEngine, createHookRegistry } from "../hook-engine.js";
import { loadConfig } from "../config.js";
import { createSessionLifecycle, type PortService } from "../session-lifecycle.js";
import { nanoid } from "nanoid";
import type { SessionPorts } from "../daemon-state.js";
import { AgentDockDaemon } from "../daemon.js";
import { DaemonClient } from "../daemon-client.js";
import { writePortsToEnv } from "../port-write-env.js";

let projectDir: string;
let db: DrizzleDb;
let dbDir: string;
let server: ReturnType<typeof createServer>;
let baseUrl: string;
let daemon: AgentDockDaemon | null = null;
let daemonClient: DaemonClient | null = null;
const testClientId = "test-api-client";

// Simple in-memory port service mock for integration tests
let allocatedPorts = new Set<number>();
function createMockPortService(): PortService {
  return {
    async allocateSession(params) {
      const keys = params.portKeys?.length ? params.portKeys : ["FRONTEND_PORT", "BACKEND_PORT", "WS_PORT", "DEBUG_PORT", "PREVIEW_PORT"];
      const ports: SessionPorts = {};
      keys.forEach((key, i) => {
        ports[key] = 30000 + allocatedPorts.size * keys.length + i;
      });
      for (const v of Object.values(ports)) allocatedPorts.add(v);
      return ports;
    },
    async releaseSession(_sessionId) {
      // no-op for tests
    },
  };
}

function syncProjectPortsToDb(projectId: string, daemonSessions: Map<string, any>) {
  const projectSessions = db.select().from(sessions).where(eq(sessions.projectId, projectId)).all();
  for (const session of projectSessions) {
    const daemonSession = daemonSessions.get(session.id);
    if (!daemonSession) continue;

    const dbPorts = session.ports ? JSON.parse(session.ports) : null;
    const daemonPortsJson = JSON.stringify(daemonSession.ports);
    if (!dbPorts || JSON.stringify(dbPorts) !== daemonPortsJson) {
      db.update(sessions).set({ ports: daemonPortsJson }).where(eq(sessions.id, session.id)).run();
      writePortsToEnv(session.worktreePath, daemonSession.ports);
    }
  }
}

async function declareDiscoveredSession(projectId: string, projectPath: string, wt: { sessionId: string; worktreePath: string; branch: string }) {
  if (!daemonClient) return null;
  const result = await daemonClient.declareSessions(testClientId, [{
    sessionId: wt.sessionId,
    worktreePath: wt.worktreePath,
    projectPath,
    ports: null,
  }]);
  const declared = result.results.find((r) => r.sessionId === wt.sessionId);
  if (!declared?.ports) return null;

  db.insert(sessions).values({
    id: wt.sessionId,
    projectId,
    name: `Session ${wt.sessionId}`,
    branch: wt.branch,
    worktreePath: wt.worktreePath,
    ports: JSON.stringify(declared.ports),
  }).run();
  writePortsToEnv(wt.worktreePath, declared.ports);
  return declared.ports;
}

function initGitRepo(dir: string) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
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

function json(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function startTestServer(port: number): Promise<void> {
  return new Promise((resolve) => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      const pathname = url.pathname;
      const method = req.method || "GET";

      // POST /api/projects/:id/sessions
      const scMatch = pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
      if (scMatch && method === "POST") {
        const projectId = scMatch[1];
        const body = await parseBody(req);
        const { name: sessionName, baseBranch } = body as { name?: string; baseBranch?: string };
        if (!sessionName) { json(res, 400, { error: "name is required" }); return; }
        try {
          const p = db.select().from(projects).where(eq(projects.id, projectId)).get();
          if (!p) { json(res, 404, { error: "Project not found" }); return; }
          if (!isGitRepo(p.path)) { json(res, 400, { error: "Not a git repository" }); return; }
          const id = nanoid(8);
          const config = loadConfig(p.path);
          const lifecycle = createSessionLifecycle({ portService: createMockPortService() });
          const result = await lifecycle.create({
            projectId, projectPath: p.path, sessionId: id, sessionName, baseBranch, config,
          });
          db.insert(sessions).values({ id, projectId, name: sessionName, branch: result.branch, worktreePath: result.worktreePath, ports: JSON.stringify(result.ports) }).run();
          const session = db.select().from(sessions).where(eq(sessions.id, id)).get();
          json(res, 200, { success: true, session: { ...session, ports: result.ports }, syncReport: result.syncReport, hookReports: result.hookReports });
        } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
        return;
      }

      // DELETE /api/sessions/:id
      const sMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sMatch && method === "DELETE") {
        const id = sMatch[1];
        try {
          const s = db.select().from(sessions).where(eq(sessions.id, id)).get();
          if (!s) { json(res, 404, { error: "Session not found" }); return; }
          const p = db.select().from(projects).where(eq(projects.id, s.projectId)).get();
          if (!p) { json(res, 404, { error: "Project not found" }); return; }

          // ?delay=500 — simulate slow synchronous I/O (like big-repo git worktree remove)
          const delayMs = Number(url.searchParams.get("delay")) || 0;
          if (delayMs > 0) {
            execSync(`node -e "const start=Date.now();while(Date.now()-start<${delayMs}){}"`);
          }

          const config = loadConfig(p.path);
          const lifecycle = createSessionLifecycle();
          await lifecycle.remove({ sessionId: id, projectPath: p.path, worktreePath: s.worktreePath, config });
          db.delete(sessions).where(eq(sessions.id, id)).run();
          json(res, 200, { success: true });
        } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
        return;
      }

      // PATCH /api/sessions/:id
      if (sMatch && method === "PATCH") {
        const id = sMatch[1];
        try {
          const body = await parseBody(req);
          const { name: newName } = body as { name?: string };
          if (!newName) { json(res, 400, { error: "name is required" }); return; }
          const s = db.select().from(sessions).where(eq(sessions.id, id)).get();
          if (!s) { json(res, 404, { error: "Session not found" }); return; }
          const p = db.select().from(projects).where(eq(projects.id, s.projectId)).get();
          let newBranch: string | undefined;
          if (p) {
            const result = renameWorktree(p.path, id, newName, s.branch);
            newBranch = result.newBranch;
          }
          db.update(sessions).set({
            name: newName,
            ...(newBranch ? { branch: newBranch } : {}),
          }).where(eq(sessions.id, id)).run();
          const updated = db.select().from(sessions).where(eq(sessions.id, id)).get();
          json(res, 200, { success: true, session: updated });
        } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
        return;
      }

      // GET /api/projects — with auto-sync (simplified from api.ts)
      if (pathname === "/api/projects" && method === "GET") {
        try {
          let daemonSessions: Map<string, any> = new Map();
          if (daemonClient) {
            const list = await daemonClient.listSessions();
            for (const s of list) daemonSessions.set(s.sessionId, s);
          }

          const allProjects = db.select().from(projects).all();
          for (const p of allProjects) {
            syncProjectPortsToDb(p.id, daemonSessions);

            const diskWts = scanDiskWorktrees(p.path);
            const existingSessions = db.select().from(sessions).where(eq(sessions.projectId, p.id)).all();
            const existingIds = new Set(existingSessions.map((s) => s.id));
            // Add missing sessions from disk
            for (const wt of diskWts) {
              if (!existingIds.has(wt.sessionId)) {
                const daemonSession = daemonSessions.get(wt.sessionId);
                if (daemonSession) {
                  db.insert(sessions).values({
                    id: wt.sessionId,
                    projectId: p.id,
                    name: `Session ${wt.sessionId}`,
                    branch: wt.branch,
                    worktreePath: wt.worktreePath,
                    ports: JSON.stringify(daemonSession.ports),
                  }).run();
                  writePortsToEnv(wt.worktreePath, daemonSession.ports);
                } else {
                  const declaredPorts = await declareDiscoveredSession(p.id, p.path, wt);
                  if (!declaredPorts) {
                    db.insert(sessions).values({
                      id: wt.sessionId,
                      projectId: p.id,
                      name: `Session ${wt.sessionId}`,
                      branch: wt.branch,
                      worktreePath: wt.worktreePath,
                    }).run();
                  } else {
                    daemonSessions.set(wt.sessionId, {
                      sessionId: wt.sessionId,
                      worktreePath: wt.worktreePath,
                      projectPath: p.path,
                      ports: declaredPorts,
                    });
                  }
                }
              }
            }
            syncProjectPortsToDb(p.id, daemonSessions);
            // Clean up sessions whose worktree no longer exists
            const diskWtIds = new Set(diskWts.map((w) => w.sessionId));
            for (const s of existingSessions) {
              if (!diskWtIds.has(s.id)) {
                db.delete(sessions).where(eq(sessions.id, s.id)).run();
              }
            }
            // Reset stale backgroundHookStatus
            for (const s of existingSessions) {
              if (s.backgroundHookStatus === "running") {
                db.update(sessions).set({ backgroundHookStatus: null }).where(eq(sessions.id, s.id)).run();
              }
            }
          }
          const result = db.select().from(projects).all().map((p) => ({
            ...p,
            sessions: db.select().from(sessions).where(eq(sessions.projectId, p.id)).all().map((s) => ({
              ...s, ports: s.ports ? JSON.parse(s.ports) : null,
            })),
          }));
          json(res, 200, { success: true, projects: result });
        } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
        return;
      }

      // POST /api/sessions/:id/retry-hooks — re-run afterCreateSession hooks
      const retryMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/retry-hooks$/);
      if (retryMatch && method === "POST") {
        const id = retryMatch[1];
        try {
          const s = db.select().from(sessions).where(eq(sessions.id, id)).get();
          if (!s) { json(res, 404, { error: "Session not found" }); return; }
          if (s.backgroundHookStatus !== "failed") {
            json(res, 400, { error: "Session is not in failed state" }); return;
          }
          const p = db.select().from(projects).where(eq(projects.id, s.projectId)).get();
          if (!p) { json(res, 404, { error: "Project not found" }); return; }

          // Set status to "running" immediately
          db.update(sessions).set({ backgroundHookStatus: "running" }).where(eq(sessions.id, id)).run();

          // Re-run hooks asynchronously
          const config = loadConfig(p.path);
          const registry = createHookRegistry();
          const engine = createHookEngine(registry);
          registry.loadFromConfig(config.hooks as any);
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
            db.update(sessions).set({ backgroundHookStatus: status }).where(eq(sessions.id, id)).run();
          }).catch(() => {
            db.update(sessions).set({ backgroundHookStatus: "failed" }).where(eq(sessions.id, id)).run();
          });

          json(res, 200, { success: true });
        } catch (err) { json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" }); }
        return;
      }

      json(res, 404, { error: "Not found" });
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

async function api(method: string, path: string, body?: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

beforeEach(async () => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  projectDir = path.join(os.tmpdir(), `ad-api-test-${id}`);
  mkdirSync(projectDir, { recursive: true });
  initGitRepo(projectDir);

  dbDir = path.join(os.tmpdir(), `ad-api-db-${id}`);
  mkdirSync(dbDir, { recursive: true });
  db = createDb(dbDir);
  daemon = new AgentDockDaemon({ port: 0, baseDir: dbDir });
  await daemon.start();
  daemonClient = new DaemonClient(daemon.getPort());
  await daemonClient.registerClient(testClientId, process.pid, [projectDir]);

  const projId = "testproj";
  db.insert(projects).values({ id: projId, name: "Test Project", path: projectDir }).run();

  // Find a free port
  const port = 19000 + Math.floor(Math.random() * 1000);
  baseUrl = `http://127.0.0.1:${port}`;
  await startTestServer(port);
});

afterEach(async () => {
  if (server) server.close();
  if (daemon) {
    await daemon.stop();
    daemon = null;
    daemonClient = null;
  }
  // Close the SQLite connection before cleanup
  try {
    const sqlite = (db as unknown as { $client: { close: () => void } }).$client;
    sqlite.close();
  } catch {}
  if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
  if (existsSync(dbDir)) rmSync(dbDir, { recursive: true, force: true });
});

// ============================================================
// E1–E10: POST /api/projects/:id/sessions
// ============================================================
describe("POST /api/projects/:id/sessions", () => {
  it("E1: 正常创建 session 返回 200", async () => {
    const res = await api("POST", "/api/projects/testproj/sessions", { name: "My Session" });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.session).toBeDefined();
    expect(res.data.session.id).toBeDefined();
    expect(res.data.session.branch).toContain("agentdock/");
    expect(res.data.session.worktreePath).toBeDefined();
    expect(res.data.session.ports).toBeDefined();
  });

  it("E2: 创建后 worktree 在磁盘上存在", async () => {
    const res = await api("POST", "/api/projects/testproj/sessions", { name: "My Session" });
    expect(res.data.session.worktreePath).toBeDefined();
    expect(existsSync(res.data.session.worktreePath)).toBe(true);
  });

  it("E3: 创建后 DB 中有记录", async () => {
    const res = await api("POST", "/api/projects/testproj/sessions", { name: "My Session" });
    const sid = res.data.session.id;
    const row = db.select().from(sessions).where(eq(sessions.id, sid)).get();
    expect(row).toBeDefined();
    expect(row!.name).toBe("My Session");
  });

  it("E4: 创建后端口写入 worktree .env", async () => {
    const res = await api("POST", "/api/projects/testproj/sessions", { name: "My Session" });
    const envPath = path.join(res.data.session.worktreePath, ".env");
    expect(existsSync(envPath)).toBe(true);
    const envContent = readFileSync(envPath, "utf-8");
    expect(envContent).toContain(`FRONTEND_PORT=${res.data.session.ports.FRONTEND_PORT}`);
  });

  it("E5: 缺少 name 返回 400", async () => {
    const res = await api("POST", "/api/projects/testproj/sessions", {});
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("name is required");
  });

  it("E6: project 不存在返回 404", async () => {
    const res = await api("POST", "/api/projects/nonexistent/sessions", { name: "test" });
    expect(res.status).toBe(404);
  });

  it("E7: 非 git repo 返回 400", async () => {
    const badDir = path.join(os.tmpdir(), `bad-${Date.now()}`);
    mkdirSync(badDir, { recursive: true });
    const badId = "badproj";
    db.insert(projects).values({ id: badId, name: "Bad", path: badDir }).run();
    try {
      const res = await api("POST", `/api/projects/${badId}/sessions`, { name: "test" });
      expect(res.status).toBe(400);
      expect(res.data.error).toContain("git");
    } finally {
      rmSync(badDir, { recursive: true, force: true });
    }
  });

  it("E8: 加载 config 中的 resources.sync", async () => {
    writeFileSync(path.join(projectDir, ".env"), "MY_VAR=hello\n");
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), `
version: "1"
resources:
  sync:
    - source: .env
      strategy: overwrite
      skipIfMissing: true
`);
    const res = await api("POST", "/api/projects/testproj/sessions", { name: "Config Test" });
    expect(res.status).toBe(200);
    expect(res.data.syncReport).toBeDefined();
    expect(res.data.syncReport.results).toHaveLength(1);
    // .env should be synced to worktree
    const envContent = readFileSync(path.join(res.data.session.worktreePath, ".env"), "utf-8");
    expect(envContent).toContain("MY_VAR=hello");
  });

  it("E9: 加载 config 中的 hooks", async () => {
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), `
version: "1"
hooks:
  afterCreateSession:
    - run: "echo hook-executed"
      required: false
`);
    const res = await api("POST", "/api/projects/testproj/sessions", { name: "Hook Test" });
    expect(res.status).toBe(200);
    expect(res.data.hookReports).toBeDefined();
    const afterReport = res.data.hookReports.find((r: { event: string }) => r.event === "afterCreateSession");
    expect(afterReport).toBeDefined();
    expect(afterReport.results[0].stdout).toContain("hook-executed");
  });

  it("E10: required hook 失败返回 500", async () => {
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), `
version: "1"
hooks:
  afterCreateSession:
    - run: "exit 1"
      required: true
`);
    const res = await api("POST", "/api/projects/testproj/sessions", { name: "Fail Test" });
    expect(res.status).toBe(500);
  });
});

// ============================================================
// E11–E15: DELETE /api/sessions/:id
// ============================================================
describe("DELETE /api/sessions/:id", () => {
  it("E11: 正常删除 session 返回 200", async () => {
    const created = await api("POST", "/api/projects/testproj/sessions", { name: "To Delete" });
    const sid = created.data.session.id;
    const wtPath = created.data.session.worktreePath;

    const res = await api("DELETE", `/api/sessions/${sid}`);
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(existsSync(wtPath)).toBe(false);
    const row = db.select().from(sessions).where(eq(sessions.id, sid)).get();
    expect(row).toBeUndefined();
  });

  it("E12: 删除后端口可重新分配", async () => {
    const created = await api("POST", "/api/projects/testproj/sessions", { name: "To Delete" });
    await api("DELETE", `/api/sessions/${created.data.session.id}`);

    const recreated = await api("POST", "/api/projects/testproj/sessions", { name: "Recreated" });
    expect(recreated.status).toBe(200);
    expect(recreated.data.session.ports.FRONTEND_PORT).toBeGreaterThan(0);
  });

  it("E13: session 不存在返回 404", async () => {
    const res = await api("DELETE", "/api/sessions/nonexistent");
    expect(res.status).toBe(404);
  });

  it("E14: 删除时执行 beforeDeleteSession hook", async () => {
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), `
version: "1"
hooks:
  beforeDeleteSession:
    - run: "echo deleting"
      required: false
`);
    const created = await api("POST", "/api/projects/testproj/sessions", { name: "With Hook" });
    const res = await api("DELETE", `/api/sessions/${created.data.session.id}`);
    expect(res.status).toBe(200);
  });

  it("E15: beforeDeleteSession required hook 失败中断删除", async () => {
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), `
version: "1"
hooks:
  beforeDeleteSession:
    - run: "exit 1"
      required: true
`);
    const created = await api("POST", "/api/projects/testproj/sessions", { name: "Will Fail" });
    const sid = created.data.session.id;
    const wtPath = created.data.session.worktreePath;

    const res = await api("DELETE", `/api/sessions/${sid}`);
    expect(res.status).toBe(500);
    // Worktree should still exist (deletion was interrupted)
    expect(existsSync(wtPath)).toBe(true);
  });
});

// ============================================================
// E16–E18: 端到端完整流程
// ============================================================
describe("端到端完整流程", () => {
  it("E16: 完整流程：创建 → 验证 → 删除 → 验证", async () => {
    // Create
    const created = await api("POST", "/api/projects/testproj/sessions", { name: "E2E Test" });
    expect(created.status).toBe(200);
    const sid = created.data.session.id;
    const wtPath = created.data.session.worktreePath;

    // Verify created
    expect(existsSync(wtPath)).toBe(true);
    const row = db.select().from(sessions).where(eq(sessions.id, sid)).get();
    expect(row).toBeDefined();

    // Delete
    const deleted = await api("DELETE", `/api/sessions/${sid}`);
    expect(deleted.status).toBe(200);

    // Verify deleted
    expect(existsSync(wtPath)).toBe(false);
    const rowAfter = db.select().from(sessions).where(eq(sessions.id, sid)).get();
    expect(rowAfter).toBeUndefined();
  });

  it("E17: 无 config 文件时行为与原有逻辑一致", async () => {
    // No agentdock.config.yaml — should work with defaults
    const created = await api("POST", "/api/projects/testproj/sessions", { name: "No Config" });
    expect(created.status).toBe(200);
    expect(created.data.session.ports).toBeDefined();
    expect(created.data.syncReport.results).toEqual([]);
    expect(created.data.hookReports).toBeDefined();

    const deleted = await api("DELETE", `/api/sessions/${created.data.session.id}`);
    expect(deleted.status).toBe(200);
  });

  it("E18: 多次创建删除不冲突", async () => {
    const s1 = await api("POST", "/api/projects/testproj/sessions", { name: "Session 1" });
    const s2 = await api("POST", "/api/projects/testproj/sessions", { name: "Session 2" });
    const s3 = await api("POST", "/api/projects/testproj/sessions", { name: "Session 3" });

    // Delete session 2
    await api("DELETE", `/api/sessions/${s2.data.session.id}`);

    // Verify session 1 and 3 still exist
    expect(existsSync(s1.data.session.worktreePath)).toBe(true);
    expect(existsSync(s3.data.session.worktreePath)).toBe(true);

    const row1 = db.select().from(sessions).where(eq(sessions.id, s1.data.session.id)).get();
    const row3 = db.select().from(sessions).where(eq(sessions.id, s3.data.session.id)).get();
    expect(row1).toBeDefined();
    expect(row3).toBeDefined();
  });
});

// ============================================================
// 并发请求 — execSync 阻塞事件循环
// ============================================================
describe("并发请求 — execSync 阻塞事件循环", () => {
  it("RACE1: BUG 复现 — DELETE 中 execSync 同步阻塞导致并发 CREATE 响应延迟", async () => {
    // 先创建一个 session，用于后续删除
    const created = await api("POST", "/api/projects/testproj/sessions", { name: "To Delete" });
    expect(created.status).toBe(200);
    const sessionId = created.data.session.id;

    const SYNC_DELAY = 800; // ms — 模拟大型仓库上 git worktree remove 的阻塞耗时

    // 并发发起 DELETE（带同步阻塞延迟）和 CREATE
    const start = Date.now();

    const [deleteRes, createRes] = await Promise.all([
      api("DELETE", `/api/sessions/${sessionId}?delay=${SYNC_DELAY}`),
      api("POST", "/api/projects/testproj/sessions", { name: "Race Create" }),
    ]);

    const elapsed = Date.now() - start;

    // 两个请求都必须成功
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.data.success).toBe(true);
    expect(createRes.status).toBe(200);
    expect(createRes.data.success).toBe(true);

    // 关键断言：总耗时必须 >= sync_delay + create_time（约 800ms+）
    // 如果事件循环没有被阻塞，两个请求应并发执行，总耗时 ≈ max(800, create_time) ≈ 800ms
    // 如果 execSync 阻塞了事件循环，总耗时 ≈ 800 + create_time ≈ 1300ms+（前后串行）
    //
    // 创建时间通常在 300-500ms，所以 800 + 300 = 1100ms 为保守下限
    expect(elapsed).toBeGreaterThanOrEqual(SYNC_DELAY + 200);

    // 清理：删除通过并发创建出来的 session
    if (createRes.data.session?.id) {
      await api("DELETE", `/api/sessions/${createRes.data.session.id}`);
    }
  });

  it("RACE2: 对照 — 无 execSync 阻塞时 CREATE 不受阻塞", async () => {
    const created = await api("POST", "/api/projects/testproj/sessions", { name: "To Delete" });
    const sessionId = created.data.session.id;

    const [deleteRes, createRes] = await Promise.all([
      api("DELETE", `/api/sessions/${sessionId}`), // 无 delay
      api("POST", "/api/projects/testproj/sessions", { name: "Concurrent Create" }),
    ]);

    // 两个请求都应该成功
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.data.success).toBe(true);
    expect(createRes.status).toBe(200);
    expect(createRes.data.success).toBe(true);

    // CREATE 的 session 应该有正常返回数据
    expect(createRes.data.session).toBeDefined();
    expect(createRes.data.session.id).toBeDefined();
    expect(createRes.data.session.worktreePath).toBeDefined();

    if (createRes.data.session?.id) {
      await api("DELETE", `/api/sessions/${createRes.data.session.id}`);
    }
  });
});

// ============================================================
// R1–R4: PATCH /api/sessions/:id (重命名)
// ============================================================
describe("PATCH /api/sessions/:id", () => {
  it("R1: 重命名后数据库 name 和 branch 都更新", async () => {
    const createRes = await api("POST", "/api/projects/testproj/sessions", { name: "Old Name" });
    expect(createRes.status).toBe(200);
    const sid = createRes.data.session.id;
    const oldBranch = createRes.data.session.branch;

    const res = await api("PATCH", `/api/sessions/${sid}`, { name: "NewName" });
    expect(res.status).toBe(200);
    expect(res.data.session.name).toBe("NewName");

    // 验证数据库 branch 字段也更新了
    const row = db.select().from(sessions).where(eq(sessions.id, sid)).get();
    expect(row?.name).toBe("NewName");
    expect(row?.branch).toBe("agentdock/NewName");
    expect(row?.branch).not.toBe(oldBranch);
  });

  it("R2: 中文名称重命名成功", async () => {
    const createRes = await api("POST", "/api/projects/testproj/sessions", { name: "Old" });
    expect(createRes.status).toBe(200);
    const sid = createRes.data.session.id;

    const res = await api("PATCH", `/api/sessions/${sid}`, { name: "测试会话" });
    expect(res.status).toBe(200);
    expect(res.data.session.name).toBe("测试会话");

    // 验证 branch 也更新为中文
    const row = db.select().from(sessions).where(eq(sessions.id, sid)).get();
    expect(row?.branch).toBe("agentdock/测试会话");
  });

  it("R3: 缺少 name 返回 400", async () => {
    const createRes = await api("POST", "/api/projects/testproj/sessions", { name: "Test" });
    const sid = createRes.data.session.id;

    const res = await api("PATCH", `/api/sessions/${sid}`, {});
    expect(res.status).toBe(400);
    expect(res.data.error).toContain("name is required");
  });

  it("R4: 不存在的 session 返回 404", async () => {
    const res = await api("PATCH", "/api/sessions/nonexistent", { name: "New" });
    expect(res.status).toBe(404);
  });

  it("R5: 连续重命名两次都成功", async () => {
    const createRes = await api("POST", "/api/projects/testproj/sessions", { name: "Original" });
    expect(createRes.status).toBe(200);
    const sid = createRes.data.session.id;

    // 第一次重命名
    const res1 = await api("PATCH", `/api/sessions/${sid}`, { name: "First" });
    expect(res1.status).toBe(200);

    // 第二次重命名 — 当前会 500
    const res2 = await api("PATCH", `/api/sessions/${sid}`, { name: "Second" });
    expect(res2.status).toBe(200);
    expect(res2.data.session.name).toBe("Second");
    expect(res2.data.session.branch).toBe("agentdock/Second");
  });
});

// ============================================================
// EP1-EP5: env.ports 配置 — 自定义端口分配
// ============================================================
describe("env.ports 配置 — 自定义端口分配", () => {
  it("EP1: 配置 2 个端口变量时只分配 2 个端口", async () => {
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), `
version: "1"
env:
  ports:
    - FRONTEND_PORT
    - BACKEND_PORT
`);
    const res = await api("POST", "/api/projects/testproj/sessions", { name: "2 Ports" });
    expect(res.status).toBe(200);
    const ports = res.data.session.ports;
    expect(Object.keys(ports)).toHaveLength(2);
    expect(ports.FRONTEND_PORT).toBeGreaterThanOrEqual(20000);
    expect(ports.BACKEND_PORT).toBeGreaterThanOrEqual(20000);
  });

  it("EP2: 配置自定义端口变量名", async () => {
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), `
version: "1"
env:
  ports:
    - MY_API_PORT
    - METRICS_PORT
    - WS_PORT
`);
    const res = await api("POST", "/api/projects/testproj/sessions", { name: "Custom Names" });
    expect(res.status).toBe(200);
    const ports = res.data.session.ports;
    expect(Object.keys(ports)).toHaveLength(3);
    expect(ports.MY_API_PORT).toBeGreaterThanOrEqual(20000);
    expect(ports.METRICS_PORT).toBeGreaterThanOrEqual(20000);
    expect(ports.WS_PORT).toBeGreaterThanOrEqual(20000);
  });

  it("EP3: worktree .env 文件只包含配置的端口变量", async () => {
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), `
version: "1"
env:
  ports:
    - FRONTEND_PORT
    - WS_PORT
`);
    const res = await api("POST", "/api/projects/testproj/sessions", { name: "Env Check" });
    expect(res.status).toBe(200);
    const envPath = path.join(res.data.session.worktreePath, ".env");
    const envContent = readFileSync(envPath, "utf-8");
    expect(envContent).toContain("FRONTEND_PORT=");
    expect(envContent).toContain("WS_PORT=");
    expect(envContent).not.toContain("BACKEND_PORT=");
    expect(envContent).not.toContain("DEBUG_PORT=");
    expect(envContent).not.toContain("PREVIEW_PORT=");
  });

  it("EP4: 不配置 env.ports 时仍分配默认 5 端口", async () => {
    // Remove any existing config file
    const configPath = path.join(projectDir, "agentdock.config.yaml");
    if (existsSync(configPath)) rmSync(configPath);
    const res = await api("POST", "/api/projects/testproj/sessions", { name: "Default" });
    expect(res.status).toBe(200);
    const ports = res.data.session.ports;
    expect(Object.keys(ports)).toHaveLength(5);
    expect(ports.FRONTEND_PORT).toBeGreaterThanOrEqual(20000);
    expect(ports.BACKEND_PORT).toBeGreaterThanOrEqual(20000);
    expect(ports.WS_PORT).toBeGreaterThanOrEqual(20000);
    expect(ports.DEBUG_PORT).toBeGreaterThanOrEqual(20000);
    expect(ports.PREVIEW_PORT).toBeGreaterThanOrEqual(20000);
  });

  it("EP5: 配置 1 个端口变量只分配 1 个端口", async () => {
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), `
version: "1"
env:
  ports:
    - SINGLE_PORT
`);
    const res = await api("POST", "/api/projects/testproj/sessions", { name: "Single" });
    expect(res.status).toBe(200);
    const ports = res.data.session.ports;
    expect(Object.keys(ports)).toHaveLength(1);
    expect(ports.SINGLE_PORT).toBeGreaterThanOrEqual(20000);
  });
});

// ============================================================
// P: port reconciliation and external discovery
// ============================================================
describe("P: port reconciliation and external discovery", () => {
  it("P1: 首次发现外部 session 时立即补登记并返回端口", async () => {
    const foreignId = "foreign123";
    const worktreePath = path.join(projectDir, ".agentdock", "worktrees", foreignId);
    execSync(`git worktree add --detach "${worktreePath}" HEAD`, { cwd: projectDir, stdio: "pipe" });

    const res = await api("GET", "/api/projects");
    expect(res.status).toBe(200);

    const project = res.data.projects.find((p: any) => p.id === "testproj");
    const session = project.sessions.find((s: any) => s.id === foreignId);
    expect(session).toBeDefined();
    expect(session.ports).toBeDefined();
    expect(session.ports.FRONTEND_PORT).toBeGreaterThanOrEqual(20000);

    const row = db.select().from(sessions).where(eq(sessions.id, foreignId)).get();
    expect(row?.ports).not.toBeNull();

    const envContent = readFileSync(path.join(worktreePath, ".env"), "utf-8");
    expect(envContent).toContain(`FRONTEND_PORT=${session.ports.FRONTEND_PORT}`);
  });

  it("P2: /api/projects 用 daemon ports 覆盖 DB 中的旧非空 ports", async () => {
    const createRes = await api("POST", "/api/projects/testproj/sessions", { name: "Reconcile" });
    expect(createRes.status).toBe(200);
    const sid = createRes.data.session.id;

    await daemonClient!.declareSessions(testClientId, [{
      sessionId: sid,
      worktreePath: createRes.data.session.worktreePath,
      projectPath: projectDir,
      ports: createRes.data.session.ports,
    }]);
    const daemonPorts = await daemonClient!.reassignSession(testClientId, sid);
    db.update(sessions).set({ ports: JSON.stringify({
      FRONTEND_PORT: 11111,
      BACKEND_PORT: 11112,
      WS_PORT: 11113,
      DEBUG_PORT: 11114,
      PREVIEW_PORT: 11115,
    }) }).where(eq(sessions.id, sid)).run();

    const res = await api("GET", "/api/projects");
    expect(res.status).toBe(200);

    const project = res.data.projects.find((p: any) => p.id === "testproj");
    const session = project.sessions.find((s: any) => s.id === sid);
    expect(session.ports).toEqual(daemonPorts);

    const row = db.select().from(sessions).where(eq(sessions.id, sid)).get();
    expect(row?.ports ? JSON.parse(row.ports) : null).toEqual(daemonPorts);

    const envContent = readFileSync(path.join(createRes.data.session.worktreePath, ".env"), "utf-8");
    expect(envContent).toContain(`FRONTEND_PORT=${daemonPorts.FRONTEND_PORT}`);
  });
});

describe("S: backgroundHookStatus restart recovery", () => {
  it("S2: 重启后 auto-sync 重置卡死的 backgroundHookStatus", async () => {
    // 创建一个正常的 session
    const createRes = await api("POST", "/api/projects/testproj/sessions", { name: "Test" });
    expect(createRes.status).toBe(200);
    const sid = createRes.data.session.id;

    // 模拟服务器在 async hook 运行中被杀：
    // 直接在 DB 中将 backgroundHookStatus 设为 "running"
    db.update(sessions).set({ backgroundHookStatus: "running" }).where(eq(sessions.id, sid)).run();

    // 验证当前状态确实是 "running"
    const before = db.select().from(sessions).where(eq(sessions.id, sid)).get();
    expect(before?.backgroundHookStatus).toBe("running");

    // 调用 GET /api/projects（触发 auto-sync）
    const listRes = await api("GET", "/api/projects");
    expect(listRes.status).toBe(200);

    // 验证 backgroundHookStatus 被重置为 null
    const after = db.select().from(sessions).where(eq(sessions.id, sid)).get();
    expect(after?.backgroundHookStatus).toBeNull();
  });

  it("S3: 没有 async hook 的 session 不受影响", async () => {
    const createRes = await api("POST", "/api/projects/testproj/sessions", { name: "Normal" });
    expect(createRes.status).toBe(200);
    const sid = createRes.data.session.id;

    // 验证初始状态为 null
    const before = db.select().from(sessions).where(eq(sessions.id, sid)).get();
    expect(before?.backgroundHookStatus).toBeNull();

    // 调用 GET /api/projects（触发 auto-sync）
    await api("GET", "/api/projects");

    // 状态仍为 null
    const after = db.select().from(sessions).where(eq(sessions.id, sid)).get();
    expect(after?.backgroundHookStatus).toBeNull();
  });

  it("S4: 已完成的 async hook session 不被重置", async () => {
    const createRes = await api("POST", "/api/projects/testproj/sessions", { name: "Done" });
    expect(createRes.status).toBe(200);
    const sid = createRes.data.session.id;

    // 模拟 async hook 已完成
    db.update(sessions).set({ backgroundHookStatus: "completed" }).where(eq(sessions.id, sid)).run();

    // 调用 GET /api/projects（触发 auto-sync）
    await api("GET", "/api/projects");

    // "completed" 不应被重置（只重置 "running"）
    const after = db.select().from(sessions).where(eq(sessions.id, sid)).get();
    expect(after?.backgroundHookStatus).toBe("completed");
  });

  it("S5: 失败的 async hook session 不被重置", async () => {
    const createRes = await api("POST", "/api/projects/testproj/sessions", { name: "Failed" });
    expect(createRes.status).toBe(200);
    const sid = createRes.data.session.id;

    // 模拟 async hook 失败
    db.update(sessions).set({ backgroundHookStatus: "failed" }).where(eq(sessions.id, sid)).run();

    // 调用 GET /api/projects（触发 auto-sync）
    await api("GET", "/api/projects");

    // "failed" 不应被重置
    const after = db.select().from(sessions).where(eq(sessions.id, sid)).get();
    expect(after?.backgroundHookStatus).toBe("failed");
  });
});

// --- R: retry-hooks ---

describe("R: POST /api/sessions/:id/retry-hooks", () => {
  it("R6: 正常重试 failed hook", async () => {
    const createRes = await api("POST", "/api/projects/testproj/sessions", { name: "Retry" });
    expect(createRes.status).toBe(200);
    const sid = createRes.data.session.id;

    // 模拟 hook 失败
    db.update(sessions).set({ backgroundHookStatus: "failed" }).where(eq(sessions.id, sid)).run();

    // 重试
    const retryRes = await api("POST", `/api/sessions/${sid}/retry-hooks`);
    expect(retryRes.status).toBe(200);
    expect(retryRes.data.success).toBe(true);

    // 等待异步 hook 完成（测试项目无 hook，瞬间完成）
    await new Promise((r) => setTimeout(r, 200));

    // 最终状态应为 "completed"（空 hook 报告 success=true）
    const after = db.select().from(sessions).where(eq(sessions.id, sid)).get();
    expect(after?.backgroundHookStatus).toBe("completed");
  });

  it("R7: 非 failed 状态重试返回 400", async () => {
    const createRes = await api("POST", "/api/projects/testproj/sessions", { name: "Normal" });
    expect(createRes.status).toBe(200);
    const sid = createRes.data.session.id;

    // 状态为 null，不是 failed
    const retryRes = await api("POST", `/api/sessions/${sid}/retry-hooks`);
    expect(retryRes.status).toBe(400);
    expect(retryRes.data.error).toContain("not in failed state");
  });

  it("R8: 不存在的 session 重试返回 404", async () => {
    const retryRes = await api("POST", "/api/sessions/nonexistent/retry-hooks");
    expect(retryRes.status).toBe(404);
  });
});
