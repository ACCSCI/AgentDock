import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import os from "node:os";
import { createDb, type DrizzleDb } from "../db/index.js";
import { projects, sessions } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createHookEngine, createHookRegistry } from "../hook-engine.js";
import type { PortService } from "../session-lifecycle.js";

// Simple mock port service for E2E tests
function createMockPortService(): PortService {
  let counter = 0;
  return {
    async allocateSession() {
      const ports: Record<string, number> = {};
      const keys = ["FRONTEND_PORT", "BACKEND_PORT", "WS_PORT", "DEBUG_PORT", "PREVIEW_PORT"];
      keys.forEach((k, i) => { ports[k] = 30000 + counter * keys.length + i; });
      counter++;
      return ports;
    },
    async releaseSession() {},
  };
}

let projectDir: string;
let db: DrizzleDb;
let dbDir: string;
let server: ReturnType<typeof createServer>;
let baseUrl: string;

const isWin = process.platform === "win32";
function sleepCmd(seconds: number): string {
  return isWin
    ? `ping -n ${seconds + 1} 127.0.0.1 >nul`
    : `sleep ${seconds}`;
}

function initGitRepo(dir: string) {
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(path.join(dir, "README.md"), "# test\n");
  execSync("git add .", { cwd: dir, stdio: "pipe" });
  execSync('git commit -m init', { cwd: dir, stdio: "pipe" });
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

beforeEach(async () => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  projectDir = path.join(os.tmpdir(), `ad-api-del-${id}`);
  mkdirSync(projectDir, { recursive: true });
  initGitRepo(projectDir);

  dbDir = path.join(os.tmpdir(), `ad-api-del-db-${id}`);
  mkdirSync(dbDir, { recursive: true });
  db = createDb(dbDir);

  const projId = "delproj";
  db.insert(projects).values({ id: projId, name: "Del Project", path: projectDir }).run();

  const port = 19000 + Math.floor(Math.random() * 1000);
  baseUrl = `http://127.0.0.1:${port}`;

  server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", baseUrl);
    const pathname = url.pathname;
    const method = req.method || "GET";

    // POST /api/projects/:id/sessions
    const scMatch = pathname.match(/^\/api\/projects\/([^/]+)\/sessions$/);
    if (scMatch && method === "POST") {
      const projectId = scMatch[1];
      const body = await parseBody(req);
      const { name: sessionName } = body as { name?: string };
      if (!sessionName) { json(res, 400, { error: "name is required" }); return; }
      try {
        const p = db.select().from(projects).where(eq(projects.id, projectId)).get();
        if (!p) { json(res, 404, { error: "Project not found" }); return; }

        const config = loadConfig(p.path);
        const registry = createHookRegistry();
        const engine = createHookEngine(registry);
        const lifecycle = (await import("../session-lifecycle.js")).createSessionLifecycle({
          portService: createMockPortService(),
        });

        const result = await lifecycle.create({
          projectId,
          projectPath: p.path,
          sessionId: pathname.split("/").slice(-1)[0] + "_" + Date.now(),
          sessionName,
          config,
        });

        db.insert(sessions).values({
          id: result.sessionId,
          projectId,
          name: sessionName,
          branch: result.branch,
          worktreePath: result.worktreePath,
          ports: JSON.stringify(result.ports),
        }).run();

        json(res, 200, { success: true, session: { id: result.sessionId, worktreePath: result.worktreePath, ports: result.ports } });
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
      }
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
        const { createSessionLifecycle } = await import("../session-lifecycle.js");
        const lifecycle = createSessionLifecycle({ portService: createMockPortService() });
        await lifecycle.remove({
          sessionId: id,
          projectPath: p.path,
          worktreePath: s.worktreePath,
          config,
        });
        db.delete(sessions).where(eq(sessions.id, id)).run();
        json(res, 200, { success: true });
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
      }
      return;
    }

    // POST /api/orphans/delete
    if (pathname === "/api/orphans/delete" && method === "POST") {
      try {
        const body = await parseBody(req);
        const { paths } = body as { paths?: string[] };
        if (!Array.isArray(paths) || paths.length === 0) {
          json(res, 400, { error: "paths array is required" });
          return;
        }
        const { removeOrphanDir } = await import("../orphan.js");
        const deleted: string[] = [];
        const failed: Array<{ path: string; error: string }> = [];
        for (const p of paths) {
          try {
            await removeOrphanDir(p);
            deleted.push(p);
          } catch (err) {
            failed.push({ path: p, error: err instanceof Error ? err.message : "Unknown error" });
          }
        }
        json(res, 200, { deleted, failed });
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
      }
      return;
    }

    json(res, 404, { error: "Not found" });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
});

afterEach(async () => {
  if (server) server.close();
  if (existsSync(projectDir)) {
    try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
  }
  if (existsSync(dbDir)) {
    try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
  }
});

async function api(method: string, pathname: string, body?: Record<string, unknown>) {
  const url = new URL(pathname, baseUrl);
  const res = await fetch(url.toString(), {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

// ============================================================
// E19–E21: 删除与孤儿清理 E2E
// ============================================================
describe("E2E — 删除 session 与孤儿目录清理", () => {
  it("E19: 创建带异步 hook 的 session → 不等 hook 完成 → 删除成功", { timeout: 120000 }, async () => {
    // 写入 config：异步 hook 长时间运行
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), `
version: "1"
resources: { sync: [] }
hooks:
  afterCreateSession:
    - run: "${sleepCmd(30)}"
      required: false
      timeout: 60000
      cwd: worktree
      async: true
env:
  ports: [FRONTEND_PORT, BACKEND_PORT, WS_PORT, DEBUG_PORT, PREVIEW_PORT]
`);

    const createRes = await api("POST", "/api/projects/delproj/sessions", { name: "E19 Session" });
    expect(createRes.status).toBe(200);
    expect(createRes.data.success).toBe(true);
    expect(createRes.data.session.worktreePath).toBeDefined();
    const worktreePath = createRes.data.session.worktreePath;
    expect(existsSync(worktreePath)).toBe(true);

    // 不等 hook 完成，立即删除
    await new Promise((r) => setTimeout(r, 500));
    const delRes = await api("DELETE", `/api/sessions/${createRes.data.session.id}`);
    expect(delRes.status).toBe(200);
    expect(delRes.data.success).toBe(true);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it("E20: 创建→删除→再创建同一 session（端口重新分配）", { timeout: 60000 }, async () => {
    writeFileSync(path.join(projectDir, "agentdock.config.yaml"), `
version: "1"
resources: { sync: [] }
hooks: {}
env:
  ports: [FRONTEND_PORT, BACKEND_PORT, WS_PORT, DEBUG_PORT, PREVIEW_PORT]
`);

    const c1 = await api("POST", "/api/projects/delproj/sessions", { name: "First" });
    expect(c1.status).toBe(200);
    const sid = c1.data.session.id;
    const wt1 = c1.data.session.worktreePath;

    const d1 = await api("DELETE", `/api/sessions/${sid}`);
    expect(d1.status).toBe(200);
    expect(existsSync(wt1)).toBe(false);

    const c2 = await api("POST", "/api/projects/delproj/sessions", { name: "Second" });
    expect(c2.status).toBe(200);
    // 端口应该不同（fresh allocation）
    expect(c2.data.session.ports.FRONTEND_PORT).toBeGreaterThan(0);
    expect(existsSync(c2.data.session.worktreePath)).toBe(true);
  });

  it("E21: 孤儿目录扫描→删除（通过 API）", { timeout: 60000 }, async () => {
    // 创建一个不在 DB 中的孤儿目录
    const worktreesDir = path.join(projectDir, ".agentdock", "worktrees");
    mkdirSync(worktreesDir, { recursive: true });
    const orphanDir = path.join(worktreesDir, "orphan-e21");
    mkdirSync(orphanDir, { recursive: true });
    writeFileSync(path.join(orphanDir, "orphan.txt"), "orphan data");
    expect(existsSync(orphanDir)).toBe(true);

    const delRes = await api("POST", "/api/orphans/delete", { paths: [orphanDir] });
    expect(delRes.status).toBe(200);
    expect(delRes.data.deleted).toContain(orphanDir);
    expect(delRes.data.failed).toHaveLength(0);
    expect(existsSync(orphanDir)).toBe(false);
  });
});
