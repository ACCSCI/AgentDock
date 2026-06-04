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
import { isGitRepo } from "../worktree.js";
import { loadConfig } from "../config.js";
import { createSessionLifecycle } from "../session-lifecycle.js";
import { loadGlobalAllocatedPorts } from "../port-registry.js";
import { nanoid } from "nanoid";

let projectDir: string;
let db: DrizzleDb;
let dbDir: string;
let server: ReturnType<typeof createServer>;
let baseUrl: string;

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
          const allProjectPaths = db.select().from(projects).all().map((proj) => proj.path);
          const globalExcluded = loadGlobalAllocatedPorts(allProjectPaths);
          const config = loadConfig(p.path);
          const lifecycle = createSessionLifecycle({ globalExcludedPorts: globalExcluded });
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
          const config = loadConfig(p.path);
          const lifecycle = createSessionLifecycle();
          await lifecycle.remove({ sessionId: id, projectPath: p.path, worktreePath: s.worktreePath, config });
          db.delete(sessions).where(eq(sessions.id, id)).run();
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

  // Register the project in DB
  const projId = "testproj";
  db.insert(projects).values({ id: projId, name: "Test Project", path: projectDir }).run();

  // Find a free port
  const port = 19000 + Math.floor(Math.random() * 1000);
  baseUrl = `http://127.0.0.1:${port}`;
  await startTestServer(port);
});

afterEach(() => {
  if (server) server.close();
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
