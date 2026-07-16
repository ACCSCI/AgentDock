/**
 * Derived constants — 新架构 §4.1 + §11.3 invariants.
 *
 * Pulled out so they can be imported without triggering plugins/config.ts
 * (which has heavy Zod dependencies and may not be needed for some consumers).
 */
export const SESSION_ID_RE = /^[a-zA-Z0-9-_]+$/;

/** Branch name derived from sessionId — single source of truth for git ops. */
export function branchForSession(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid sessionId: ${sessionId}`);
  }
  return `agentdock/${sessionId}`;
}

/** Worktree path derived from sessionId + projectRoot — §4.1 derived fields. */
export function worktreePathFor(projectRoot: string, sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid sessionId: ${sessionId}`);
  }
  return `${projectRoot}/.agentdock/worktrees/${sessionId}`;
}
