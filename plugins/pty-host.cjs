#!/usr/bin/env node
/**
 * PTY 宿主进程
 *
 * 独立于 Vite 的 Node.js 子进程，负责：
 * - 加载 node-pty 原生模块
 * - 管理所有 PTY 进程
 * - 通过 stdin/stdout JSON IPC 与主进程通信
 *
 * 协议（每行一个 JSON）：
 *   Parent → Child:
 *     { type: "spawn", terminalId, sessionId, shell, worktreePath, cols?, rows? }
 *     { type: "write", terminalId, data }
 *     { type: "resize", terminalId, cols, rows }
 *     { type: "kill", terminalId }
 *     { type: "killAll" }
 *
 *   Child → Parent:
 *     { type: "spawned", terminalId, sessionId, pid }
 *     { type: "output", terminalId, data }
 *     { type: "exit", terminalId, sessionId, code, signal? }
 *     { type: "error", terminalId, message }
 *     { type: "ready" }
 */

const { existsSync, readFileSync } = require("node:fs");
const { execSync } = require("node:child_process");
const path = require("node:path");

const FALLBACK_STRIP_KEYS = new Set([
  "FRONTEND_PORT",
  "BACKEND_PORT",
  "WS_PORT",
  "DEBUG_PORT",
  "PREVIEW_PORT",
  "PORT",
  // Electron sets these for its internal use; child PTY shells must not
  // inherit them or `electron` CLI will run in Node-only mode (no GUI).
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ELECTRON_ENABLE_LOGGING",
  "ELECTRON_ENABLE_STACK_DUMPING",
]);

function parseEnv(content) {
  const result = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIdx = value.indexOf(" #");
      if (commentIdx !== -1) value = value.slice(0, commentIdx).trim();
    } else {
      const quote = value[0];
      const closingIdx = value.indexOf(quote, 1);
      if (closingIdx !== -1) value = value.slice(1, closingIdx);
    }
    result[key] = value;
  }
  return result;
}

function readWorkspaceEnv(workspacePath) {
  const envPath = path.join(workspacePath, ".env");
  if (!existsSync(envPath)) return {};
  return parseEnv(readFileSync(envPath, "utf-8"));
}

function buildScopedChildEnv(workspacePath, runtimeEnv = {}, parentEnv = process.env) {
  const workspaceEnv = readWorkspaceEnv(workspacePath);
  const env = { ...parentEnv };
  for (const key of FALLBACK_STRIP_KEYS) delete env[key];
  for (const key of Object.keys(workspaceEnv)) delete env[key];
  return {
    ...env,
    ...workspaceEnv,
    ...runtimeEnv,
  };
}

let ptySpawn = null;
try {
  ptySpawn = require("node-pty").spawn;
} catch (err) {
  // 将在 spawn 时延迟重试
}

/** @type {Map<string, import("node-pty").IPty>} */
const ptySessions = new Map(); // key = terminalId

// ---- Shell 检测 ----
function resolveShell(requestedShell) {
  if (requestedShell && requestedShell !== "default") {
    return requestedShell;
  }

  if (process.platform === "win32") {
    // Windows: pwsh.exe → powershell.exe → cmd.exe
    for (const shell of ["pwsh.exe", "powershell.exe", process.env.COMSPEC || "cmd.exe"]) {
      try {
        execSync(`where ${shell}`, { stdio: "pipe" });
        return shell;
      } catch { /* not found, try next */ }
    }
    return process.env.COMSPEC || "cmd.exe";
  }

  // Unix: user's shell → /bin/bash
  return process.env.SHELL || "/bin/bash";
}

// ---- IPC 通信 ----
const rl = require("node:readline").createInterface({ input: process.stdin });

rl.on("line", (raw) => {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    send({ type: "error", message: "Invalid JSON" });
    return;
  }

  try {
    handleMessage(msg);
  } catch (err) {
    send({
      type: "error",
      terminalId: msg.terminalId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

function send(data) {
  process.stdout.write(JSON.stringify(data) + "\n");
}

function handleMessage(msg) {
  switch (msg.type) {
    case "spawn":
      return handleSpawn(msg);
    case "write":
      return handleWrite(msg);
    case "resize":
      return handleResize(msg);
    case "kill":
      return handleKill(msg);
    case "killAll":
      return handleKillAll();
    default:
      send({ type: "error", message: `Unknown type: ${msg.type}` });
  }
}

function ensurePty() {
  if (ptySpawn) return ptySpawn;
  ptySpawn = require("node-pty").spawn;
  if (!ptySpawn) throw new Error("node-pty module failed to load");
  return ptySpawn;
}

function handleSpawn(msg) {
  const { terminalId, sessionId, shell: requestedShell, worktreePath, cols, rows } = msg;

  if (!terminalId) {
    send({ type: "error", message: "terminalId is required" });
    return;
  }

  if (ptySessions.has(terminalId)) {
    send({ type: "spawned", terminalId, sessionId, pid: ptySessions.get(terminalId).pid });
    return;
  }

  if (!existsSync(worktreePath)) {
    send({
      type: "error",
      terminalId,
      message: `Worktree path not found: ${worktreePath}`,
    });
    return;
  }

  const spawn = ensurePty();
  const shell = resolveShell(requestedShell);

  const pty = spawn(shell, [], {
    name: "xterm-256color",
    cols: cols ?? 80,
    rows: rows ?? 24,
    cwd: worktreePath,
    env: buildScopedChildEnv(worktreePath, {
      TERM: "xterm-256color",
      AGENTDOCK_SESSION_ID: sessionId,
      AGENTDOCK_TERMINAL_ID: terminalId,
      AGENTDOCK_WORKTREE_PATH: worktreePath,
    }),
  });

  ptySessions.set(terminalId, pty);

  send({ type: "spawned", terminalId, sessionId, pid: pty.pid });

  pty.onData((data) => {
    send({ type: "output", terminalId, data });
  });

  pty.onExit((event) => {
    ptySessions.delete(terminalId);
    send({
      type: "exit",
      terminalId,
      sessionId,
      code: event.exitCode,
      signal: event.signal,
    });
  });
}

function handleWrite(msg) {
  const pty = ptySessions.get(msg.terminalId);
  if (!pty) {
    send({ type: "error", terminalId: msg.terminalId, message: "PTY not found" });
    return;
  }
  pty.write(msg.data);
}

function handleResize(msg) {
  const pty = ptySessions.get(msg.terminalId);
  if (!pty) return;
  pty.resize(msg.cols, msg.rows);
}

function handleKill(msg) {
  const pty = ptySessions.get(msg.terminalId);
  if (!pty) return;
  try {
    pty.kill();
  } catch { /* ignore */ }
  ptySessions.delete(msg.terminalId);
}

function handleKillAll() {
  for (const [id, pty] of ptySessions) {
    try { pty.kill(); } catch { /* ignore */ }
  }
  ptySessions.clear();
}

// 通知父进程就绪
process.stdout.write(JSON.stringify({ type: "ready" }) + "\n");

// 父进程退出信号
process.on("SIGTERM", () => {
  handleKillAll();
  process.exit(0);
});

process.on("SIGINT", () => {
  handleKillAll();
  process.exit(0);
});
