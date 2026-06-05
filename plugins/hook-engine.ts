import { exec } from "node:child_process";
import type { HookDefinition, HookLifecycleEvent } from "./config.js";
import { buildScopedChildEnv } from "./env.js";

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
          resolve({
            hook,
            event: context.event,
            success: !error,
            exitCode: error == null ? 0 : ((error as unknown as { status?: number }).status ?? 1),
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            duration: Date.now() - start,
            timedOut: false,
          });
        },
      );

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
