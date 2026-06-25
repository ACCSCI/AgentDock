/**
 * Terminal-related query and mutation hooks.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "./helpers.js";
import type { TerminalData } from "./types.js";

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
