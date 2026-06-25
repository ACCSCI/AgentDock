/**
 * Orphan detection and project file browsing hooks.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./helpers.js";
import type { FileEntry, OrphanDir } from "./types.js";

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
