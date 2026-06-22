/**
 * Query / Mutation hooks — Phase 5 renderer-side update.
 *
 * All hooks now call `window.api.*` (the Electron IPC bridge exposed by
 * preload.ts) instead of `fetch('/api/...')`. The original Vite-middleware
 * flow (api.ts as a fetch proxy) is gone; everything goes through IPC.
 *
 * Streaming: SSE was previously `fetch + ReadableStream`. Now we use the
 * AsyncIterable-style subscriber exposed by preload: pass a sessionId, get
 * back `{ onStep, onComplete }` event subscribables.
 *
 * F11b: Added v2State integration — useV2Projects combines v2State SSE push
 * with old polling fallback for backward compatibility.
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {} from "../electron"; // pulls in window.api type augmentation (Phase 6)
import { useV2State, isV2StateAvailable } from "../hooks/useV2State";

// Types matching the DB schema
export interface ProjectData {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  sessions: SessionListItem[];
}

export type SessionRuntimeStatus =
  | "existing"
  | "foreign"
  | "creating"
  | "deleting"
  | "takeover";

export type SessionUserStatus = "draft" | "plan" | "working" | "pr" | "done";

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

export interface CreatingSession extends Omit<SessionData, "status"> {
  status: "creating";
  steps: SessionStep[];
}

export type SessionListItem = SessionData | CreatingSession | DeletingSession;

export interface DeletingSession extends Omit<SessionData, "status"> {
  status: "deleting";
  steps: SessionStep[];
}

export function isCreatingSession(s: SessionListItem): s is CreatingSession {
  return "status" in s && (s as CreatingSession).status === "creating";
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

export function isDeletingSession(s: SessionListItem): s is DeletingSession {
  return "status" in s && (s as DeletingSession).status === "deleting";
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

// Query keys
export const queryKeys = {
  projects: ["projects"] as const,
  terminals: (sessionId: string) => ["terminals", sessionId] as const,
};

// Type-safe access to window.api (exposed by preload.ts via contextBridge).
declare global {
  interface Window {
    api: import("../electron/preload").ApiSurface;
  }
}

function api() {
  if (!window.api) {
    throw new Error(
      "window.api is not available. Are you running outside Electron?",
    );
  }
  return window.api;
}

// GET projects
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: async (): Promise<ProjectData[]> => {
      const raw = await api().db.projects.list();
      // §4.3.1: orphan 和 takeover 不进 sidebar，由 OrphanCleanModal 处理
      return raw.map((p: (typeof raw)[number]) => ({
        ...p,
        sessions: p.sessions
          .filter(
            (s: (typeof p.sessions)[number]) => {
              const rt = (s as { runtimeStatus?: string }).runtimeStatus;
              return rt !== "orphan" && rt !== "takeover";
            },
          )
          .map((s: (typeof p.sessions)[number]) => ({
            ...s,
            status: ((s as { runtimeStatus?: string }).runtimeStatus === "active" || (s as { runtimeStatus?: string }).runtimeStatus === "owned"
              ? "existing"
              : (s as { runtimeStatus?: string }).runtimeStatus) as SessionRuntimeStatus | undefined,
          })),
      }));
    },
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

// POST db:init — initialize the active project DB
export function useInitDb() {
  return useMutation({
    mutationFn: async (projectPath: string) => {
      await api().db.init(projectPath);
      return { success: true };
    },
  });
}

// POST projects:create
export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, path }: { name: string; path: string }) => {
      return api().db.projects.create(name, path);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

// DELETE projects:delete
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (projectId: string) => {
      return api().db.projects.delete(projectId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

// IPC-streamed create session with optimistic update.
// Uses the AsyncIterable-style stream exposed by preload's
// sessions.stream() helper — ipcRenderer.on(...) under the hood.
export function useCreateSessionSSE() {
  const queryClient = useQueryClient();
  return useMutation<
    SessionData,
    Error,
    { projectId: string; name: string; baseBranch?: string; tempId: string },
    { prevProjects: ProjectData[] | undefined; tempId: string }
  >({
    mutationFn: async ({ projectId, name, baseBranch, tempId }) => {
      const { sessionId } = await api().sessions.create({
        projectId,
        name,
        baseBranch,
      });

      // Optimistic insert: add a CreatingSession with the tempId.
      queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
        if (!old) return old;
        return old.map((p) => {
          if (p.id !== projectId) return p;
          const temp: CreatingSession = {
            id: tempId,
            projectId,
            name,
            branch: "",
            worktreePath: "",
            ports: null,
            createdAt: new Date().toISOString(),
            status: "creating",
            steps: [],
          };
          return { ...p, sessions: [...p.sessions, temp] };
        });
      });

      // Subscribe to step + complete events.
      const stream = api().sessions.stream(sessionId);
      const offStep = stream.onStep((step) => {
        queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
          if (!old) return old;
          return old.map((p) => {
            if (p.id !== projectId) return p;
            return {
              ...p,
              sessions: (p.sessions ?? []).map((s) => {
                if (s.id !== tempId) return s;
                if (!isCreatingSession(s)) return s;
                const creating = s as CreatingSession;
                const curSteps = creating.steps ?? [];
                const existingIdx = curSteps.findIndex(
                  (st) => st.step === step.step,
                );
                const newSteps = [...curSteps];
                if (existingIdx >= 0) {
                  newSteps[existingIdx] = step;
                } else {
                  newSteps.push(step);
                }
                return { ...creating, steps: newSteps };
              }),
            };
          });
        });
      });

      return new Promise<SessionData>((resolve, reject) => {
        const offComplete = stream.onComplete((result) => {
          offStep();
          offComplete();
          if (!result.success) {
            reject(new Error(result.error ?? "session create failed"));
            return;
          }
          // Replace the tempId placeholder with the real sessionId. We
          // don't get the full SessionData back from the stream — fetch it
          // from the projects list after a brief refresh.
          queryClient.invalidateQueries({ queryKey: queryKeys.projects });
          // For the return value, construct a minimal SessionData.
          resolve({
            id: sessionId,
            projectId,
            name,
            branch: "",
            worktreePath: "",
            ports: null,
            createdAt: new Date().toISOString(),
            status: "existing",
          });
        });
      });
    },
    onError: (_err, _variables, context) => {
      if (context?.prevProjects) {
        queryClient.setQueryData(queryKeys.projects, context.prevProjects);
      }
    },
  });
}

// IPC-streamed delete session
export function useDeleteSessionSSE() {
  const queryClient = useQueryClient();
  return useMutation<
    void,
    Error,
    { sessionId: string; projectId: string },
    { prevProjects: ProjectData[] | undefined }
  >({
    mutationFn: async ({ sessionId, projectId }) => {
      // Optimistic mark: convert to DeletingSession.
      queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
        if (!old) return old;
        return old.map((p) => {
          if (p.id !== projectId) return p;
          return {
            ...p,
            sessions: (p.sessions ?? []).map((s) => {
              if (s.id !== sessionId) return s;
              if (isCreatingSession(s) || isDeletingSession(s)) return s;
              const deleting: DeletingSession = { ...s, status: "deleting", steps: [] };
              return deleting;
            }),
          };
        });
      });

      // Subscribe to step + complete events BEFORE firing the delete
      // IPC — otherwise main can emit `session:<id>:step` /
      // `session:<id>:complete` before the renderer registers a
      // listener and the events are silently dropped.
      const stream = api().sessions.stream(sessionId);
      const offStep = stream.onStep((step) => {
        queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
          if (!old) return old;
          return old.map((p) => {
            if (p.id !== projectId) return p;
            return {
              ...p,
              sessions: (p.sessions ?? []).map((s) => {
                if (s.id !== sessionId) return s;
                if (!isDeletingSession(s)) return s;
                const deleting = s as DeletingSession;
                const curSteps = deleting.steps ?? [];
                const existingIdx = curSteps.findIndex(
                  (st) => st.step === step.step,
                );
                const newSteps = [...curSteps];
                if (existingIdx >= 0) newSteps[existingIdx] = step;
                else newSteps.push(step);
                return { ...deleting, steps: newSteps };
              }),
            };
          });
        });
      });

      return new Promise<void>((resolve, reject) => {
        const offComplete = stream.onComplete((result) => {
          offStep();
          offComplete();
          if (!result.success) {
            reject(new Error(result.error ?? "delete failed"));
            return;
          }
          queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
            if (!old) return old;
            return old.map((p) => {
              if (p.id !== projectId) return p;
              return {
                ...p,
                sessions: (p.sessions ?? []).filter((s) => s.id !== sessionId),
              };
            });
          });
          resolve();
        });

        // Fire the IPC — main schedules the lifecycle on setImmediate
        // so this resolves immediately with the synchronous result,
        // while step/complete events stream in via the listeners above.
        api()
          .sessions.delete(sessionId)
          .then((res) => {
            if (!res.success) {
              offStep();
              offComplete();
              reject(new Error(res.error ?? "delete failed"));
            }
            // Successful resolve waits for the `complete` event so the
            // optimistic cache update happens uniformly through one
            // code path (the onComplete handler above).
          })
          .catch((err) => {
            offStep();
            offComplete();
            reject(err);
          });
      });
    },
    onError: (_err, _variables, context) => {
      if (context?.prevProjects) {
        queryClient.setQueryData(queryKeys.projects, context.prevProjects);
      }
    },
  });
}

// PATCH sessions:rename
export function useRenameSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, name }: { sessionId: string; name: string }) => {
      return api().sessions.rename(sessionId, name);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

// PUT sessions:reorder
export function useReorderSessions() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, sessionIds }: { projectId: string; sessionIds: string[] }) => {
      await api().db.sessions.reorder(projectId, sessionIds);
      return { success: true };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

// POST sessions:reassignPorts
export function useReassignPorts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      return api().sessions.reassignPorts(sessionId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

// GET terminals
export async function fetchSessionTerminals(sessionId: string): Promise<TerminalData[]> {
  return api().terminals.list(sessionId);
}

export function useSessionTerminals(sessionId: string) {
  return useQuery({
    queryKey: queryKeys.terminals(sessionId),
    queryFn: () => fetchSessionTerminals(sessionId),
    enabled: !!sessionId,
    refetchInterval: 3000,
    staleTime: 5000,
  });
}

// POST terminals:create
export function useCreateTerminal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, shell }: { sessionId: string; shell?: string }) => {
      return api().terminals.create(sessionId, shell);
    },
    onSuccess: (_data, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.terminals(sessionId) });
    },
  });
}

// DELETE terminals
export function useDeleteTerminal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (terminalId: string) => {
      return api().terminals.delete(terminalId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["terminals"] });
    },
  });
}

// PATCH terminals:rename
export function useRenameTerminal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ terminalId, name }: { terminalId: string; name: string }) => {
      return api().terminals.rename(terminalId, name);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["terminals"] });
    },
  });
}

// GET bgHookStatus — polled while the session's background hooks run
export function useBackgroundHookStatus(sessionId: string | null, enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["backgroundHookStatus", sessionId] as const,
    queryFn: async (): Promise<string | null> => {
      if (!sessionId) return null;
      return api().sessions.bgHookStatus(sessionId);
    },
    enabled: enabled && !!sessionId,
    refetchInterval: (q) => {
      const status = q.state.data;
      if (status === "completed" || status === "failed" || status === null) return false;
      return 2000;
    },
  });

  // When bg hook reaches terminal state, write to projects cache.
  const status = query.data;
  if (sessionId && (status === "completed" || status === "failed")) {
    queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
      if (!old) return old;
      let changed = false;
      const next = old.map((p) => ({
        ...p,
        sessions: p.sessions.map((s) => {
          if (s.id !== sessionId || s.backgroundHookStatus === status) return s;
          changed = true;
          return { ...s, backgroundHookStatus: status };
        }),
      }));
      return changed ? next : old;
    });
    queryClient.invalidateQueries({ queryKey: ["hookErrors", sessionId] });
  }
  return query;
}

export function isBackgroundHookRunning(s: SessionListItem): boolean {
  return "backgroundHookStatus" in s && (s as SessionData).backgroundHookStatus === "running";
}

export function isBackgroundHookFailed(s: SessionListItem): boolean {
  return "backgroundHookStatus" in s && (s as SessionData).backgroundHookStatus === "failed";
}

// GET hookErrors
export function useHookErrors(sessionId: string | null) {
  return useQuery({
    queryKey: ["hookErrors", sessionId],
    queryFn: async (): Promise<HookError[]> => {
      if (!sessionId) return [];
      return api().sessions.hookErrors(sessionId);
    },
    enabled: !!sessionId,
    staleTime: 5_000,
  });
}

// POST retryHooks
export function useRetryHook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      return api().sessions.retryHooks(sessionId);
    },
    onSuccess: (_data, sessionId) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      queryClient.invalidateQueries({ queryKey: ["hookErrors", sessionId] });
    },
  });
}

// PATCH sessions:setUserStatus
export function useSetSessionUserStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, status }: { sessionId: string; status: SessionUserStatus | null }) => {
      return api().sessions.setUserStatus(sessionId, status);
    },
    onMutate: async ({ sessionId, status }) => {
      // Optimistic update
      await queryClient.cancelQueries({ queryKey: queryKeys.projects });
      const prev = queryClient.getQueryData<ProjectData[]>(queryKeys.projects);
      queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
        if (!old) return old;
        return old.map((p) => ({
          ...p,
          sessions: p.sessions.map((s) =>
            s.id === sessionId ? { ...s, userStatus: status } : s,
          ),
        }));
      });
      return { prev };
    },
    onError: (_err, _vars, context) => {
      if (context?.prev) {
        queryClient.setQueryData(queryKeys.projects, context.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

// PATCH sessions:activate
export function useActivateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      return api().sessions.activate(sessionId);
    },
    onMutate: async (sessionId) => {
      // Optimistic update: set lastActivatedAt to now
      await queryClient.cancelQueries({ queryKey: queryKeys.projects });
      const prev = queryClient.getQueryData<ProjectData[]>(queryKeys.projects);
      const now = new Date().toISOString();
      queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
        if (!old) return old;
        return old.map((p) => ({
          ...p,
          sessions: p.sessions.map((s) =>
            s.id === sessionId ? { ...s, lastActivatedAt: now } : s,
          ),
        }));
      });
      return { prev };
    },
    onError: (_err, _sessionId, context) => {
      if (context?.prev) {
        queryClient.setQueryData(queryKeys.projects, context.prev);
      }
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

// GET orphans
export function useOrphans(projectId: string | null) {
  return useQuery({
    queryKey: ["orphans", projectId],
    queryFn: async (): Promise<OrphanDir[]> => {
      if (!projectId) return [];
      return api().worktree.orphans(projectId);
    },
    enabled: !!projectId,
  });
}

// POST orphans/delete — accepts dirs (`paths`), branches, or both. The
// renderer used to pass a flat `string[]` which silently dropped every
// orphan-branch entry (their worktreePath is "" — useless as a path).
export function useDeleteOrphans() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      paths?: string[];
      branches?: string[];
      projectId?: string;
    }) => {
      return api().worktree.deleteOrphans(body);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orphans"] });
    },
  });
}

// GET fs:files
export function useProjectFiles(projectId: string, relPath: string, enabled = true) {
  return useQuery({
    queryKey: ["projectFiles", projectId, relPath],
    queryFn: async (): Promise<FileEntry[]> => {
      return api().fs.files(relPath);
    },
    enabled: enabled && !!projectId,
    staleTime: 5_000,
  });
}

// GET config — pass projectId so the handler looks up the project root
// from DB rather than using the process-wide activeProjectPath (which
// may point at a worktree whose .env contains allocated ports, not the
// user's own port variable names).
export function useProjectConfig(projectId: string) {
  return useQuery({
    queryKey: ["projectConfig", projectId],
    queryFn: async (): Promise<ProjectConfigData> => {
      return api().config.get(projectId);
    },
    enabled: !!projectId,
    staleTime: 10_000,
  });
}

// POST config:save — pass projectId for same reason
export function useSaveConfig(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (config: ProjectConfigData["config"]) => {
      return api().config.save(config, projectId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projectConfig", projectId] });
    },
  });
}

/**
 * F11b: Hook that combines v2State SSE push with old polling fallback.
 *
 * Priority:
 * 1. v2State SSE push (real-time, from main process SyncApplier)
 * 2. 30s v2 sync loop (fallback if v2State not available)
 * 3. Old query (initial load fallback)
 *
 * Returns the same ProjectData[] format as useProjects() for backward
 * compatibility with existing components.
 */
export function useV2Projects() {
  const v2State = isV2StateAvailable() ? useV2State() : null;
  const oldQuery = useProjects();

  // Transform v2State data to ProjectData[] format
  const v2Projects = useMemo(() => {
    if (!v2State?.ready) return null;

    // Group sessions by projectRoot
    const projectMap = new Map<string, ProjectData>();
    const myClientId = v2State.clientId;

    for (const [sessionId, session] of v2State.sessions) {
      const projectRoot = session.projectRoot || "";

      // §4.3: 判定有主/无主
      const ownerClientId = v2State.owners.get(sessionId)?.clientId;
      const hasOwner = ownerClientId != null && ownerClientId !== "";

      // 无主 session 不进 sidebar（由 OrphanCleanModal 处理）
      if (!hasOwner) continue;

      if (!projectMap.has(projectRoot)) {
        projectMap.set(projectRoot, {
          id: projectRoot,
          name: projectRoot.split("/").pop() || projectRoot,
          path: projectRoot,
          createdAt: new Date(session.createdAt).toISOString(),
          sessions: [],
        });
      }

      // §4.3: 有主 → 判定"我的"还是"别人的"
      const isForeign = myClientId != null && ownerClientId !== myClientId;

      const project = projectMap.get(projectRoot)!;
      project.sessions.push({
        id: session.sessionId,
        projectId: projectRoot,
        name: session.displayName,
        branch: "",
        worktreePath: projectRoot,
        ports: session.ports && Object.keys(session.ports).length > 0 ? {
          FRONTEND_PORT: session.ports.FRONTEND_PORT || 0,
          BACKEND_PORT: session.ports.BACKEND_PORT || 0,
          WS_PORT: session.ports.WS_PORT || 0,
          DEBUG_PORT: session.ports.DEBUG_PORT || 0,
          PREVIEW_PORT: session.ports.PREVIEW_PORT || 0,
        } : null,
        createdAt: new Date(session.createdAt).toISOString(),
        status: (isForeign ? "foreign" : session.status === "active" ? "existing" : session.status) as SessionRuntimeStatus,
        ownerClientId,
      });
    }

    return Array.from(projectMap.values());
  }, [v2State]);

  // Return v2State data if available, otherwise fall back to old query
  if (v2Projects) {
    return {
      ...oldQuery,
      data: v2Projects,
      // Mark that we're using v2State data
      isV2: true as const,
    };
  }

  return {
    ...oldQuery,
    isV2: false as const,
  };
}

/**
 * Hook to get sessions for a specific project, using v2State when available.
 */
export function useV2ProjectSessions(projectId: string | null) {
  const v2State = isV2StateAvailable() ? useV2State() : null;
  const oldQuery = useProjects();

  const sessions = useMemo(() => {
    if (!projectId) return [];

    // Try v2State first
    if (v2State?.ready) {
      const myClientId = v2State.clientId;
      return Array.from(v2State.sessions.values())
        .filter((s) => s.projectRoot === projectId)
        .filter((s) => {
          // 无主 session 不进 sidebar
          const ownerClientId = v2State.owners.get(s.sessionId)?.clientId;
          return ownerClientId != null && ownerClientId !== "";
        })
        .map((s) => {
          const ownerClientId = v2State.owners.get(s.sessionId)?.clientId ?? null;
          const isForeign = myClientId != null && ownerClientId !== null && ownerClientId !== myClientId;
          return {
            id: s.sessionId,
            projectId: s.projectRoot,
            name: s.displayName,
            branch: "",
            worktreePath: s.projectRoot,
            ports: s.ports && Object.keys(s.ports).length > 0 ? {
              FRONTEND_PORT: s.ports.FRONTEND_PORT || 0,
              BACKEND_PORT: s.ports.BACKEND_PORT || 0,
              WS_PORT: s.ports.WS_PORT || 0,
              DEBUG_PORT: s.ports.DEBUG_PORT || 0,
              PREVIEW_PORT: s.ports.PREVIEW_PORT || 0,
            } : null,
            createdAt: new Date(s.createdAt).toISOString(),
            status: (isForeign ? "foreign" : s.status === "active" ? "existing" : s.status) as SessionRuntimeStatus,
            ownerClientId,
          };
        }) as SessionData[];
    }

    // Fall back to old query
    const project = oldQuery.data?.find((p) => p.id === projectId);
    return project?.sessions ?? [];
  }, [v2State, oldQuery.data, projectId]);

  return {
    sessions,
    isV2: v2State?.ready ?? false,
  };
}

// ─── Todo hooks ────────────────────────────────────────────────────

export type TodoStatus = "pending" | "in_progress" | "done";

export interface TodoItem {
  id: string;
  projectId: string;
  content: string;
  status: TodoStatus;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// GET todos for a project
export function useTodos(projectId: string | null) {
  return useQuery({
    queryKey: ["todos", projectId] as const,
    queryFn: async (): Promise<TodoItem[]> => {
      if (!projectId) return [];
      return api().todos.list(projectId);
    },
    enabled: !!projectId,
  });
}

// POST todos:create
export function useCreateTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ projectId, content }: { projectId: string; content: string }) => {
      return api().todos.create(projectId, content);
    },
    onSuccess: (_data, { projectId }) => {
      queryClient.invalidateQueries({ queryKey: ["todos", projectId] });
    },
  });
}

// PATCH todos:cycleStatus (pending → in_progress → done → pending)
export function useCycleStatusTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, currentStatus }: { id: string; currentStatus: TodoStatus }) => {
      await api().todos.cycleStatus(id, currentStatus);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["todos"] });
    },
  });
}

// PATCH todos:update (edit content)
export function useUpdateTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, content }: { id: string; content: string }) => {
      await api().todos.update(id, content);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["todos"] });
    },
  });
}

// DELETE todos:delete
export function useDeleteTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api().todos.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["todos"] });
    },
  });
}

// PATCH todos:reorder
export function useReorderTodo() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (todoIds: string[]) => {
      await api().todos.reorder(todoIds);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["todos"] });
    },
  });
}
