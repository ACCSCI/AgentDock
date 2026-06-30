/**
 * Project-related query and mutation hooks.
 *
 * The backend now provides session status (creating/active/deleting) and
 * lifecycle step progress. The frontend uses these directly — no optimistic
 * inserts or merge logic needed.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "./helpers.js";
import type { ProjectData, SessionRuntimeStatus, SessionStep } from "./types.js";

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
            // Backend provides status directly: "creating" | "active" | "deleting" | null
            // Map "active" to "existing" for backward compatibility
            status: ((): SessionRuntimeStatus | undefined => {
              const backendStatus = (s as { status?: string }).status;
              if (backendStatus === "creating") return "creating";
              if (backendStatus === "deleting") return "deleting";
              if (backendStatus === "active") return "existing";
              // Legacy rows without status field
              return undefined;
            })(),
            // Backend (db:projects:list) already JSON.parses steps into an
            // array, so DON'T parse again here. Double-parsing an array
            // produces "JSON.parse([object Object])" → "Unexpected token 'o'".
            steps: ((s as { steps?: unknown }).steps ?? undefined) as SessionStep[] | undefined,
          })),
      }));
    },
    // staleTime: 0 — make sure newly created/updated projects are visible
    // to consumers (TabBar, Sidebar) on the very next render. The 30s
    // refetchInterval keeps the list reasonably fresh in the background.
    staleTime: 0,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

// POST db:init — initialize the active project DB
export function useInitDb() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (projectPath: string) => {
      await api().db.init(projectPath);
      // The active project DB just changed — invalidate cached projects
      // query so it refetches with the new project's sessions/sync state.
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      return { success: true };
    },
  });
}

// sync:project — 手动触发磁盘扫描. 调 main 进程 syncProject(force=true),
// 完成后 invalidate projects query 让 sidebar 重新拉一次.
export function useSyncProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      return await api().sync.project();
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
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
