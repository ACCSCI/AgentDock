/**
 * Project configuration hooks.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./helpers.js";
import type { ProjectConfigData } from "./types.js";

// GET config — pass projectId so the handler looks up the project root
// from DB rather than using the process-wide activeProjectPath (which
// may point at a worktree whose .env contains allocated ports, not the
// user's own port variable names).
export function useProjectConfig(projectId: string) {
  return useQuery({
    queryKey: ["projectConfig", projectId],
    queryFn: async (): Promise<ProjectConfigData> => {
      return (await api().config.get(projectId)) as ProjectConfigData;
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
