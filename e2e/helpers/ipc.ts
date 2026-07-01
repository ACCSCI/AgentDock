// @ts-nocheck
/**
 * High-level IPC helpers for e2e specs.
 *
 * Every helper takes a Playwright `Page` (the renderer) and drives it
 * through `window.evaluate` against the real `window.api.*` surface.
 * No mocks — these are the same calls the renderer makes.
 *
 * Streaming twist: `sessions:create` returns immediately with `{sessionId}`
 * but the real result arrives over `session:<id>:step` (per-step) and
 * `session:<id>:complete` (terminal). The renderer's `useCreateSessionSSE`
 * subscribes via `window.api.sessions.stream(id).on{Step,Complete}`. We
 * can't subscribe before the id exists, so we install a one-time wrapper
 * around `window.api.sessions.create` that stashes events on
 * `window.__e2eSessionEvents[id]` and `await`s those from the test side.
 */
import type { Page } from "@playwright/test";

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface ProjectWithSessions extends ProjectSummary {
  sessions: SessionSummary[];
}

export interface SessionSummary {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  worktreePath: string;
  ports: Record<string, number> | null;
  backgroundHookStatus: string | null;
  createdAt: string;
}

export interface StepEvent {
  step: string;
  status: "running" | "done" | "error";
  duration?: number;
  error?: string;
}

export interface SessionCompleteEvent {
  success: boolean;
  error?: string;
}

export interface CreateSessionHandle {
  sessionId: string;
  /**
   * Snapshot of streamed step events captured so far. Mutated by the
   * page-side wrapper; read with `getSessionSteps(window, id)` to take a
   * fresh copy.
   */
  steps: StepEvent[];
}

/**
 * Page-side stash:
 *   window.__e2eSessionEvents[sessionId] = { steps: StepEvent[], complete?: SessionCompleteEvent }
 *
 * Cannot wrap `window.api.sessions.create` directly — `contextBridge.exposeInMainWorld`
 * deep-freezes the exposed surface, so a `w.api.sessions.create = ...` assignment is
 * silently dropped. Instead, `createSession` performs the call AND attaches the
 * stream subscription inside a single `page.evaluate` block, so the listener is
 * registered in the same microtask the create promise resolves (before main's
 * async block has time to emit its first `session:<id>:step` event — those
 * involve git/disk work that's many ms away).
 */

// ============================================================
// bootstrap
// ============================================================

export async function bootstrapHealth(window: Page): Promise<{
  daemon: string;
  vite: string;
  ipc: number;
}> {
  return await window.evaluate(() =>
    (
      window as unknown as {
        api: { bootstrap: { health: () => Promise<{ daemon: string; vite: string; ipc: number }> } };
      }
    ).api.bootstrap.health(),
  );
}

/**
 * Wait for the daemon to reach "ready" state. Essential before session
 * creation in tests — the daemon needs to be fully initialized to handle
 * `/sessions/allocate` and other v2 endpoints.
 */
export async function waitForDaemonReady(
  window: Page,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await window.evaluate(async () => {
      try {
        const health = await (
          window as unknown as {
            api: { daemon: { health: () => Promise<{ state?: string; lifecycleState?: string }> } };
          }
        ).api.daemon.health();
        const state = health.lifecycleState ?? health.state ?? "";
        return state === "ready" || state === "READY";
      } catch {
        return false;
      }
    });
    if (ready) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForDaemonReady: daemon not READY after ${timeoutMs}ms`);
}

// ============================================================
// projects (db:* channels)
// ============================================================

export async function initDb(window: Page, projectPath: string): Promise<void> {
  await window.evaluate(
    (p: string) =>
      (window as unknown as { api: { db: { init: (p: string) => Promise<unknown> } } }).api.db.init(p),
    projectPath,
  );
}

export async function createProject(
  window: Page,
  params: { name: string; path: string },
): Promise<ProjectSummary> {
  return await window.evaluate(
    (args: { name: string; path: string }) =>
      (
        window as unknown as {
          api: { db: { projects: { create: (n: string, p: string) => Promise<unknown> } } };
        }
      ).api.db.projects.create(args.name, args.path),
    params,
  ) as ProjectSummary;
}

export async function listProjects(window: Page): Promise<ProjectWithSessions[]> {
  return (await window.evaluate(() =>
    (
      window as unknown as {
        api: { db: { projects: { list: () => Promise<unknown[]> } } };
      }
    ).api.db.projects.list(),
  )) as ProjectWithSessions[];
}

export async function deleteProject(
  window: Page,
  projectId: string,
): Promise<{ deleted: number; sessionIds: string[] }> {
  return (await window.evaluate(
    (id: string) =>
      (
        window as unknown as {
          api: { db: { projects: { delete: (id: string) => Promise<unknown> } } };
        }
      ).api.db.projects.delete(id),
    projectId,
  )) as { deleted: number; sessionIds: string[] };
}

export async function syncProject(window: Page): Promise<{ synced: number }> {
  return (await window.evaluate(() =>
    (
      window as unknown as { api: { sync: { project: () => Promise<unknown> } } }
    ).api.sync.project(),
  )) as { synced: number };
}

// ============================================================
// sessions
// ============================================================

/**
 * Kick off `sessions:create` and start capturing streamed step events.
 * Returns a handle with `{sessionId, steps}`; use
 * `awaitSessionComplete` for the terminal result.
 */
export async function createSession(
  window: Page,
  params: { projectId: string; name: string; baseBranch?: string },
): Promise<CreateSessionHandle> {
  // Subscribe + create in one evaluate so the listener is registered
  // in the same microtask the promise resolves. Subscribing in a
  // *separate* evaluate would race main's async step emissions.
  const { sessionId } = (await window.evaluate(
    (p: typeof params) => {
      interface ApiLike {
        sessions: {
          create: (p: unknown) => Promise<{ sessionId: string }>;
          stream: (id: string) => {
            onStep: (cb: (e: unknown) => void) => () => void;
            onComplete: (cb: (e: unknown) => void) => () => void;
          };
        };
      }
      const w = window as unknown as {
        api: ApiLike;
        __e2eSessionEvents?: Record<string, { steps: unknown[]; complete?: unknown }>;
      };
      const store = (w.__e2eSessionEvents ??= {});
      return w.api.sessions.create(p).then((r) => {
        const slot: { steps: unknown[]; complete?: unknown } = { steps: [] };
        store[r.sessionId] = slot;
        const stream = w.api.sessions.stream(r.sessionId);
        stream.onStep((step: unknown) => {
          slot.steps.push(step);
        });
        stream.onComplete((complete: unknown) => {
          slot.complete = complete;
        });
        return r;
      });
    },
    params,
  )) as { sessionId: string };
  return { sessionId, steps: [] };
}

/**
 * Take a snapshot of the steps streamed for a given session so far.
 * Returns a fresh array each call (so a test can diff between polls).
 */
export async function getSessionSteps(
  window: Page,
  sessionId: string,
): Promise<StepEvent[]> {
  return (await window.evaluate(
    (id: string) =>
      ((window as unknown as { __e2eSessionEvents?: Record<string, { steps: unknown[] }> })
        .__e2eSessionEvents?.[id]?.steps ?? []) as unknown[],
    sessionId,
  )) as StepEvent[];
}

export interface AwaitCompleteResult {
  steps: StepEvent[];
  result: SessionCompleteEvent;
}

/**
 * Poll for the `complete` event with a deadline. Polling > waiting on
 * an `await window.evaluate(() => new Promise(...))` because Playwright
 * tears the eval down if anything else navigates the page; polling is
 * crash-tolerant.
 */
export async function awaitSessionComplete(
  window: Page,
  sessionId: string,
  timeoutMs = 60_000,
): Promise<AwaitCompleteResult> {
  const deadline = Date.now() + timeoutMs;
  let pollMs = 100;
  while (Date.now() < deadline) {
    const snap = (await window.evaluate(
      (id: string) =>
        ((window as unknown as { __e2eSessionEvents?: Record<string, { steps: unknown[]; complete?: unknown }> })
          .__e2eSessionEvents?.[id] ?? null) as {
          steps: unknown[];
          complete?: unknown;
        } | null,
      sessionId,
    )) as { steps: StepEvent[]; complete?: SessionCompleteEvent } | null;
    if (snap && snap.complete) {
      return { steps: snap.steps, result: snap.complete };
    }
    await new Promise((r) => setTimeout(r, pollMs));
    // Back off slowly so we don't burn CPU on long lifecycles.
    pollMs = Math.min(pollMs * 1.5, 750);
  }
  // Timed out — fetch whatever's been streamed for the failure attachment.
  const tail = await getSessionSteps(window, sessionId);
  throw new Error(
    `awaitSessionComplete(${sessionId}) timed out after ${timeoutMs}ms; steps captured: ${JSON.stringify(tail)}`,
  );
}

export async function deleteSession(
  window: Page,
  sessionId: string,
): Promise<{ success: boolean; error?: string }> {
  return (await window.evaluate(
    (id: string) =>
      (
        window as unknown as {
          api: { sessions: { delete: (id: string) => Promise<unknown> } };
        }
      ).api.sessions.delete(id),
    sessionId,
  )) as { success: boolean; error?: string };
}

export async function renameSession(
  window: Page,
  sessionId: string,
  name: string,
): Promise<{ success: boolean; branch: string }> {
  return (await window.evaluate(
    (args: { sessionId: string; name: string }) =>
      (
        window as unknown as {
          api: { sessions: { rename: (id: string, n: string) => Promise<unknown> } };
        }
      ).api.sessions.rename(args.sessionId, args.name),
    { sessionId, name },
  )) as { success: boolean; branch: string };
}

export async function reorderSessions(
  window: Page,
  projectId: string,
  sessionIds: string[],
): Promise<void> {
  await window.evaluate(
    (args: { projectId: string; sessionIds: string[] }) =>
      (
        window as unknown as {
          api: {
            db: { sessions: { reorder: (pid: string, ids: string[]) => Promise<unknown> } };
          };
        }
      ).api.db.sessions.reorder(args.projectId, args.sessionIds),
    { projectId, sessionIds },
  );
}

export async function bgHookStatus(
  window: Page,
  sessionId: string,
): Promise<string | null> {
  return (await window.evaluate(
    (id: string) =>
      (
        window as unknown as {
          api: { sessions: { bgHookStatus: (id: string) => Promise<unknown> } };
        }
      ).api.sessions.bgHookStatus(id),
    sessionId,
  )) as string | null;
}

// ============================================================
// worktree orphans
// ============================================================

export interface OrphanEntry {
  sessionId: string;
  worktreePath: string;
  reason: "no-git-file" | "empty-dir" | "orphan-branch";
  branch: string | null;
}

export async function listOrphans(window: Page, projectId?: string): Promise<OrphanEntry[]> {
  return (await window.evaluate(
    (id: string | undefined) =>
      (
        window as unknown as { api: { worktree: { orphans: (id?: string) => Promise<unknown[]> } } }
      ).api.worktree.orphans(id),
    projectId,
  )) as OrphanEntry[];
}

export async function deleteOrphans(
  window: Page,
  body: { paths?: string[]; branches?: string[]; projectId?: string },
): Promise<{
  deleted: string[];
  failed: Array<{ path?: string; branch?: string; error: string }>;
}> {
  return (await window.evaluate(
    (b: { paths?: string[]; branches?: string[]; projectId?: string }) =>
      (
        window as unknown as {
          api: { worktree: { deleteOrphans: (b: unknown) => Promise<unknown> } };
        }
      ).api.worktree.deleteOrphans(b),
    body,
  )) as {
    deleted: string[];
    failed: Array<{ path?: string; branch?: string; error: string }>;
  };
}
