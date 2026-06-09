/**
 * API 调试脚本 — 验证 session 删除与孤儿目录清理流程
 *
 * 用法:
 *   # 启动 debug-headless 服务器后，运行本脚本
 *   bun run scripts/debug-headless.ts 3000
 *   # 另开终端:
 *   bun run scripts/api-test-runner.ts http://localhost:3000
 *
 *   # 指定 projectId（默认: testproj）
 *   bun run scripts/api-test-runner.ts http://localhost:3000 myproject
 *
 * 测试内容:
 *   T1. 创建带异步 hook 的 session → 不等 hook 完成 → 删除 → 验证目录清理
 *   T2. 孤儿目录创建 → 通过 API 删除 → 验证成功
 *   T3. 快速创建→删除→再创建同一 session → 验证端口重新分配
 */

import path from "node:path";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

const BASE = process.argv[2] || "http://localhost:20016";
const PROJECT_ID = process.argv[3] || "testproj";

const isWin = process.platform === "win32";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(msg: string) {
  console.log(`\n[api-test-runner] ${msg}`);
}

function check(label: string, cond: boolean) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  return cond;
}

async function api(method: string, pathname: string, body?: Record<string, unknown>) {
  const url = new URL(pathname, BASE);
  const res = await fetch(url.toString(), {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function run() {
  let passed = 0;
  let failed = 0;

  // 创建临时项目目录
  const projectDir = mkdtempSync(path.join(tmpdir(), "ad-api-test-"));
  execSync("git init", { cwd: projectDir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: projectDir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: projectDir, stdio: "pipe" });
  writeFileSync(path.join(projectDir, "README.md"), "# test\n");
  execSync("git add .", { cwd: projectDir, stdio: "pipe" });
  execSync('git commit -m init', { cwd: projectDir, stdio: "pipe" });

  const sleepCmd = (seconds: number) =>
    isWin ? `ping -n ${seconds + 1} 127.0.0.1 >nul` : `sleep ${seconds}`;

  const configYaml = `version: "1"
resources: { sync: [] }
hooks:
  afterCreateSession:
    - run: "${sleepCmd(5)}"
      required: false
      timeout: 30000
      cwd: worktree
      async: true
env:
  ports: [FRONTEND_PORT, BACKEND_PORT, WS_PORT, DEBUG_PORT, PREVIEW_PORT]
`;
  writeFileSync(path.join(projectDir, "agentdock.config.yaml"), configYaml);

  // 注册 project
  log("注册 project...");
  const regRes = await api("POST", "/api/projects", { id: PROJECT_ID, name: "API Test", path: projectDir });
  if (check(`project registered (status=${regRes.status})`, regRes.status === 200 || regRes.status === 409)) passed++; else failed++;

  // ---- T1: 异步 hook 运行中删除 ----
  log("\n══ T1: 异步 hook 运行中删除 session ══");
  const createRes = await api("POST", `/api/projects/${PROJECT_ID}/sessions`, { name: "Async Hook Test" });
  const createOk = createRes.status === 200 && createRes.data.success;
  if (check(`create → 200`, createOk)) passed++; else failed++;

  if (createOk) {
    const wtPath = createRes.data.session.worktreePath;
    const sid = createRes.data.session.id;
    if (check("worktree on disk", existsSync(wtPath))) passed++; else failed++;

    log("等待异步 hook 启动 (2s)...");
    await sleep(2000);

    log("立即删除 session...");
    const delRes = await api("DELETE", `/api/sessions/${sid}`);
    if (check(`delete → 200 (status=${delRes.status})`, delRes.status === 200)) passed++; else failed++;

    await sleep(1500);
    if (check("worktree removed", !existsSync(wtPath))) passed++; else failed++;
  }

  // ---- T2: 孤儿目录清理 ----
  log("\n══ T2: 孤儿目录清理 ══");
  const worktreesDir = path.join(projectDir, ".agentdock", "worktrees");
  mkdirSync(worktreesDir, { recursive: true });
  const orphanDir = path.join(worktreesDir, "orphan-t2");
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(path.join(orphanDir, "data.txt"), "orphan data");

  const orphanRes = await api("POST", "/api/orphans/delete", { paths: [orphanDir] });
  const orphanOk = orphanRes.status === 200 && orphanRes.data.deleted?.includes(orphanDir);
  if (check(`orphan delete → 200 (status=${orphanRes.status})`, orphanOk)) passed++; else failed++;
  if (check("orphan dir removed", !existsSync(orphanDir))) passed++; else failed++;

  // ---- T3: 快速创建→删除→再创建 ----
  log("\n══ T3: 创建→删除→再创建循环 ══");
  const c1 = await api("POST", `/api/projects/${PROJECT_ID}/sessions`, { name: "Cycle 1" });
  if (check("create #1 → 200", c1.status === 200)) passed++; else failed++;

  if (c1.status === 200) {
    const d1 = await api("DELETE", `/api/sessions/${c1.data.session.id}`);
    if (check("delete → 200", d1.status === 200)) passed++; else failed++;

    await sleep(500);
    const c2 = await api("POST", `/api/projects/${PROJECT_ID}/sessions`, { name: "Cycle 2" });
    if (check("recreate → 200", c2.status === 200)) passed++; else failed++;
  }

  // 清理
  log("\n清理临时目录...");
  try { rmSync(projectDir, { recursive: true, force: true }); } catch {}

  // 汇总
  log("═══════════════════════════════════");
  log(`结果: ${passed} passed, ${failed} failed`);
  log("═══════════════════════════════════");

  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error("[api-test-runner] FATAL:", err);
  process.exit(1);
});
