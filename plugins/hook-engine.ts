import { exec } from "node:child_process";
import { promisify } from "node:util";
import process from "node:process";
import type { HookDefinition, HookLifecycleEvent } from "./config.js";
import { buildScopedChildEnv } from "./env.js";

const execAsync = promisify(exec);

// --- 异步 hook 子进程追踪 ---
// 用于 session 删除时 kill 仍在运行的 hook 子进程，防止 EBUSY
const sessionHookPids = new Map<string, Set<number>>();

export function trackHookPid(sessionId: string, pid: number): void {
  let set = sessionHookPids.get(sessionId);
  if (!set) { set = new Set(); sessionHookPids.set(sessionId, set); }
  set.add(pid);
}

export function killSessionHookProcesses(sessionId: string): void {
  const pids = sessionHookPids.get(sessionId);
  if (!pids || pids.size === 0) return;

  for (const pid of pids) {
    try {
      if (process.platform === "win32") {
        // /T 杀整棵进程树, /F 强制
        exec(`taskkill /PID ${pid} /T /F 2>nul`, () => {});
      } else {
        process.kill(pid, "SIGKILL");
      }
    } catch {
      // 进程可能已退出
    }
  }
  sessionHookPids.delete(sessionId);
}

/**
 * Kill tracked hook processes and wait for OS to release directory handles.
 * On Windows, cmd.exe may take >300ms after receiving SIGTERM to release its CWD handle.
 * We poll up to ~5s, verifying processes are actually gone before returning.
 */
export async function killSessionHookProcessesAndWait(sessionId: string, dirPath: string): Promise<void> {
  const pids = sessionHookPids.get(sessionId);
  if (!pids || pids.size === 0) {
    sessionHookPids.delete(sessionId);
    return;
  }

  // Strategy 1: taskkill on tracked PIDs (await to ensure completion)
  if (process.platform === "win32") {
    for (const pid of pids) {
      await execAsync(`taskkill /PID ${pid} /T /F`).catch(() => {});
    }
  } else {
    for (const pid of pids) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }

  sessionHookPids.delete(sessionId);

  // 二次防线：WMI 杀进程（捕获 taskkill 可能遗漏的子进程）
  try {
    const { killProcessesUnderPath } = await import("./worktree.js");
    await killProcessesUnderPath(dirPath);
  } catch {
    // best-effort
  }

  // Wait for OS to release handles (up to ~10s on Windows)
  if (process.platform === "win32") {
    // If directory already gone, no need to wait
    const { existsSync } = await import("node:fs");
    if (!existsSync(dirPath)) return;

    const { opendir } = await import("node:fs/promises");
    await new Promise((r) => setTimeout(r, 500));
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const handle = await opendir(dirPath);
        await handle.close();
        return;
      } catch (e) {
        // EBUSY/EPERM — still locked, retry
        // ENOENT — directory already removed, stop waiting
        // Use optional chaining in case e is not an Error instance
        const code = (e as NodeJS.ErrnoException | undefined)?.code;
        if (code === "ENOENT") return;
      }
    }
  }
}

// --- Hook 执行上下文 ---
export interface HookContext {
  event: HookLifecycleEvent;
  sessionId: string;
  projectId: string;
  projectPath: string;
  worktreePath: string;
  payload: Record<string, unknown>;
}

// --- Hook 执行结果 ---
export interface HookResult {
  hook: HookDefinition;
  event: HookLifecycleEvent;
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  duration: number;
  timedOut: boolean;
  error?: string;
}

// --- 聚合结果 ---
export interface HookReport {
  event: HookLifecycleEvent;
  results: HookResult[];
  success: boolean;
  duration: number;
}

// --- HookRegistry ---
export interface HookRegistry {
  register(event: HookLifecycleEvent, hook: HookDefinition): void;
  getHooks(event: HookLifecycleEvent): HookDefinition[];
  loadFromConfig(config: Record<string, HookDefinition[]>): void;
  clear(event?: HookLifecycleEvent): void;
}

// --- HookEngine ---
export interface HookEngine {
  execute(event: HookLifecycleEvent, context: HookContext): Promise<HookReport>;
  executeOne(hook: HookDefinition, context: HookContext): Promise<HookResult>;
}

/**
 * On Windows, exec uses cmd.exe by default and wraps the command in `cmd /d /s /c "command"`.
 * On Unix, exec uses /bin/sh.
 * We just need to pass the raw command string — exec handles the shell.
 */


/**
 * Create a HookRegistry instance.
 */
export function createHookRegistry(): HookRegistry {
  const hooks = new Map<HookLifecycleEvent, HookDefinition[]>();

  function register(event: HookLifecycleEvent, hook: HookDefinition): void {
    const existing = hooks.get(event) ?? [];
    existing.push(hook);
    hooks.set(event, existing);
  }

  function getHooks(event: HookLifecycleEvent): HookDefinition[] {
    return hooks.get(event) ?? [];
  }

  function loadFromConfig(config: Record<string, HookDefinition[]>): void {
    hooks.clear();
    for (const [event, defs] of Object.entries(config)) {
      if (Array.isArray(defs)) {
        hooks.set(event as HookLifecycleEvent, [...defs]);
      }
    }
  }

  function clear(event?: HookLifecycleEvent): void {
    if (event) {
      hooks.delete(event);
    } else {
      hooks.clear();
    }
  }

  return { register, getHooks, loadFromConfig, clear };
}

/**
 * Create a HookEngine instance.
 */
export function createHookEngine(registry: HookRegistry): HookEngine {
  async function executeOne(hook: HookDefinition, context: HookContext): Promise<HookResult> {
    const cwd = hook.cwd === "project" ? context.projectPath : context.worktreePath;
    const start = Date.now();

    return new Promise((resolve) => {
      let timedOut = false;
      let settled = false;

      const child = exec(
        hook.run,
        {
          cwd,
          env: buildScopedChildEnv(cwd, {
            AGENTDOCK_SESSION_ID: context.sessionId,
            AGENTDOCK_PROJECT_ID: context.projectId,
            AGENTDOCK_EVENT: context.event,
          }),
        },
        (error, stdout, stderr) => {
          if (settled) return;

          if (timedOut) {
            settled = true;
            resolve({
              hook,
              event: context.event,
              success: false,
              exitCode: null,
              stdout: stdout ?? "",
              stderr: stderr ?? "",
              duration: Date.now() - start,
              timedOut: true,
              error: `Hook timed out after ${hook.timeout}ms`,
            });
            return;
          }

          settled = true;
          // Node's `exec` callback gives a child_process.ExecException
          // whose `.code` carries the exit code (or signal name on a
          // forced kill). Some Node major versions exposed `.status`
          // instead, hence the fallback. Without this we lose the real
          // exit code and report `1` for every non-zero failure.
          const codeRaw =
            error == null
              ? 0
              : (((error as { code?: number | string }).code ??
                  (error as { status?: number }).status ??
                  1) as number | string);
          const exitCode = typeof codeRaw === "number" ? codeRaw : 1;
          resolve({
            hook,
            event: context.event,
            success: !error,
            exitCode,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            duration: Date.now() - start,
            timedOut: false,
          });
        },
      );

      // Track child PID so session deletion can kill lingering hook processes
      if (child.pid) {
        trackHookPid(context.sessionId, child.pid);
      }

      // Handle timeout
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          if (process.platform === "win32") {
            // On Windows, kill the process tree
            exec(`taskkill /pid ${child.pid} /T /F`, () => {});
          } else {
            child.kill("SIGTERM");
          }
        } catch {}
      }, hook.timeout);

      child.on("exit", () => {
        clearTimeout(timer);
      });
    });
  }

  async function execute(event: HookLifecycleEvent, context: HookContext): Promise<HookReport> {
    const hooks = registry.getHooks(event);
    const results: HookResult[] = [];
    const start = Date.now();

    for (const hook of hooks) {
      const result = await executeOne(hook, { ...context, event });
      results.push(result);

      // If a required hook fails (including timeout), stop executing further hooks
      if (hook.required && !result.success) {
        break;
      }
    }

    return {
      event,
      results,
      // success = no required hooks failed
      success: results.every((r) => r.success || !r.hook.required),
      duration: Date.now() - start,
    };
  }

  return { execute, executeOne };
}
