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
import { isGitRepo, renameWorktree } from "../worktree.js";
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
    expect(row.name).toBe("NewName");
    expect(row.branch).toBe("agentdock/NewName");
    expect(row.branch).not.toBe(oldBranch);
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
    expect(row.branch).toBe("agentdock/测试会话");
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
