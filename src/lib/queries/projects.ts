/**
 * Project-related query and mutation hooks.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "./helpers.js";
import type { ProjectData, SessionRuntimeStatus } from "./types.js";

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
