/**
 * Background hook status and hook error hooks.
 *
 * NOTE: useBackgroundHookStatus is commented out with [COMPENSATION-LOGIC]
 * markers. This polling pattern is a workaround for backend not pushing
 * background hook status updates. Once the backend pushes these via IPC/SSE,
 * the polling can be removed.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "./helpers.js";
import type { HookError, SessionData, SessionListItem } from "./types.js";

// GET bgHookStatus — polled while the session's background hooks run
// [COMPENSATION-LOGIC] Polling every 2s for background hook status
// WHY THIS EXISTS: Backend doesn't push background hook status updates.
// The frontend polls to detect when hooks complete.
// WHAT SHOULD REPLACE IT: Backend pushes IPC event when background hooks
// complete (already has session:${id}:step for afterCreateSession).
// Frontend subscribes to the event instead of polling.
//
// export function useBackgroundHookStatus(sessionId: string | null, enabled = true) {
//   const queryClient = useQueryClient();
//   const query = useQuery({
//     queryKey: ["backgroundHookStatus", sessionId] as const,
//     queryFn: async (): Promise<string | null> => {
//       if (!sessionId) return null;
//       return api().sessions.bgHookStatus(sessionId);
//     },
//     enabled: enabled && !!sessionId,
//     refetchInterval: (q) => {
//       const status = q.state.data;
//       if (status === "completed" || status === "failed" || status === null) return false;
//       return 2000;
//     },
//   });
//   const status = query.data;
//   if (sessionId && (status === "completed" || status === "failed")) {
//     queryClient.setQueryData(queryKeys.projects, (old) => {
//       if (!old) return old;
//       let changed = false;
//       const next = old.map((p) => ({
//         ...p,
//         sessions: p.sessions.map((s) => {
//           if (s.id !== sessionId || s.backgroundHookStatus === status) return s;
//           changed = true;
//           return { ...s, backgroundHookStatus: status };
//         }),
//       }));
//       return changed ? next : old;
//     });
//     queryClient.invalidateQueries({ queryKey: ["hookErrors", sessionId] });
//   }
//   return query;
// }

// Placeholder that always returns idle — keeps callers compiling
export function useBackgroundHookStatus(_sessionId: string | null, _enabled = true) {
  return { data: null as string | null, isLoading: false, isFetching: false };
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
      return (await api().sessions.hookErrors(sessionId)) as HookError[];
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
