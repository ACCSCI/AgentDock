/**
 * Shared types and interfaces for React Query hooks.
 */

export interface ProjectData {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  sessions: SessionListItem[];
}

export type SessionRuntimeStatus =
  | "existing"
  | "creating"
  | "deleting";

export type SessionUserStatus = "draft" | "plan" | "working" | "pr" | "verifying" | "done";

export interface SessionPorts {
  FRONTEND_PORT: number;
  BACKEND_PORT: number;
  WS_PORT: number;
  DEBUG_PORT: number;
  PREVIEW_PORT: number;
}

export type SessionViewStatus = SessionRuntimeStatus | "creating" | "deleting";

export interface SessionData {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  worktreePath: string;
  ports: SessionPorts | null;
  createdAt: string;
  backgroundHookStatus?: string | null;
  status?: SessionRuntimeStatus;
  steps?: SessionStep[] | null;  // lifecycle step progress from backend
  ownerClientId?: string | null;
  canSelect?: boolean;
  canDelete?: boolean;
  canReassign?: boolean;
  canRename?: boolean;
  userStatus?: SessionUserStatus | null;
  lastActivatedAt?: string | null;
}

export interface SessionStep {
  step: string;
  status: "running" | "done" | "error";
  duration?: number;
  error?: string;
}

// CreatingSession/DeletingSession are now just SessionData with specific status values.
// The backend provides status and steps — no separate types needed.
export type CreatingSession = SessionData & { status: "creating"; steps: SessionStep[] };
export type DeletingSession = SessionData & { status: "deleting"; steps: SessionStep[] };

export type SessionListItem = SessionData | CreatingSession | DeletingSession;

export function isCreatingSession(s: SessionListItem): s is CreatingSession {
  return s.status === "creating";
}

export function isDeletingSession(s: SessionListItem): s is DeletingSession {
  return s.status === "deleting";
}

export interface TerminalData {
  terminalId: string;
  sessionId: string;
  shell: string;
  name: string;
  status: string;
  pid: number | null;
  createdAt: string;
}

export interface HookError {
  run: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
}

export interface OrphanDir {
  sessionId: string;
  /**
   * Filesystem path of the orphan directory. EMPTY STRING when the
   * entry is a `reason: "orphan-branch"` (no on-disk worktree) — code
   * that keys by this MUST treat empty as "not a path", or multiple
   * orphan-branch entries collapse into the same key.
   */
  worktreePath: string;
  reason: "no-git-file" | "empty-dir" | "orphan-branch";
  /** Populated for orphan-branch; the `agentdock/<id>` branch name. */
  branch?: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
}

export interface ProjectConfigData {
  config: {
    version: string;
    resources: { sync: Array<{ source: string; strategy: string; skipIfMissing: boolean }> };
    hooks: Record<string, Array<{ run: string; required: boolean; timeout: number; cwd: string; async: boolean }>>;
    env?: { ports?: string[] };
  };
  exists: boolean;
  yaml: string;
  envPorts?: string[];
}

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  id: string;
  projectId: string;
  content: string;
  status: TodoStatus;
  order: number;
  createdAt: string;
}
