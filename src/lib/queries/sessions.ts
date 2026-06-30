/**
 * Session-related query and mutation hooks.
 *
 * NOTE: Several "compensation logic" blocks are commented out with
 * [COMPENSATION-LOGIC] markers. These are frontend workarounds for
 * backend state that doesn't exist yet (session creation/deletion
 * progress, runtime status). Once the backend provides these states,
 * the compensation logic can be permanently removed.
 *
 * See: docs/backend-state-refactor.md for the full plan.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, queryKeys } from "./helpers.js";
import type { ProjectData, CreatingSession, DeletingSession, SessionData, SessionUserStatus } from "./types.js";
import { isCreatingSession, isDeletingSession } from "./types.js";

// sessions.stream() helper — ipcRenderer.on(...) under the hood.
export function useCreateSessionSSE() {
  const queryClient = useQueryClient();
  return useMutation<
    SessionData,
    Error,
    { projectId: string; name: string; baseBranch?: string; tempId: string },
    { prevProjects: ProjectData[] | undefined; tempId: string }
  >({
    // [COMPENSATION-LOGIC] onMutate: optimistic insert of CreatingSession
    // BEFORE the IPC call. This ensures the CreatingSession entry is in the
    // cache even if the user switches tabs before mutationFn completes.
    //
    // WHY THIS EXISTS: The backend doesn't persist "creating" status in the DB.
    // When the user switches tabs, invalidateQueries refetches from DB, which
    // returns no "creating" session. This optimistic insert prevents that loss.
    //
    // WHAT SHOULD REPLACE IT: Backend should insert a session row with
    // status="creating" immediately, and db:projects:list should return it.
    // onMutate: async ({ projectId, name, tempId }) => {
    //   await queryClient.cancelQueries({ queryKey: queryKeys.projects });
    //   const prevProjects = queryClient.getQueryData<ProjectData[]>(queryKeys.projects);
    //   queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
    //     if (!old) return old;
    //     return old.map((p) => {
    //       if (p.id !== projectId) return p;
    //       const temp: CreatingSession = {
    //         id: tempId, projectId, name, branch: "", worktreePath: "",
    //         ports: null, createdAt: new Date().toISOString(),
    //         status: "creating", steps: [],
    //       };
    //       return { ...p, sessions: [...p.sessions, temp] };
    //     });
    //   });
    //   return { prevProjects, tempId };
    // },

    mutationFn: async ({ projectId, name, baseBranch, tempId }) => {
      const { sessionId } = await api().sessions.create({
        projectId,
        name,
        baseBranch,
      });

      // Backend has inserted session with status="creating" + steps.
      // Invalidate now so the UI refetches and shows the creating spinner.
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });

      // [COMPENSATION-LOGIC] Update optimistic entry with real sessionId
      // WHY THIS EXISTS: The tempId→realSessionId indirection is needed so
      // SSE step events can be matched to the correct cache entry.
      // WHAT SHOULD REPLACE IT: Backend returns sessionId synchronously,
      // no tempId needed.
      // queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
      //   if (!old) return old;
      //   return old.map((p) => {
      //     if (p.id !== projectId) return p;
      //     return {
      //       ...p,
      //       sessions: (p.sessions ?? []).map((s) => {
      //         if (s.id !== tempId || !isCreatingSession(s)) return s;
      //         return { ...s, realSessionId: sessionId };
      //       }),
      //     };
      //   });
      // });

      // [COMPENSATION-LOGIC] SSE step events accumulate into frontend cache
      // WHY THIS EXISTS: Backend doesn't persist lifecycle step progress.
      // The frontend builds the steps array from IPC events in memory.
      // WHAT SHOULD REPLACE IT: Backend persists steps in DB (or SessionManager).
      // Frontend queries backend for current steps, doesn't accumulate.
      // const stream = api().sessions.stream(sessionId);
      // const offStep = stream.onStep((step) => {
      //   queryClient.setQueryData(queryKeys.projects, (old) => {
      //     // ... accumulate step into CreatingSession.steps
      //   });
      // });

      // Subscribe to step events and refetch so the UI shows progress.
      // Backend writes steps to DB; we invalidate on each step (throttled).
      const stream = api().sessions.stream(sessionId);
      let lastInvalidateAt = 0;
      const offStep = stream.onStep((_step: { step: string; status: string; duration?: number; error?: string }) => {
        // Throttle: avoid hammering on rapid step events
        const now = Date.now();
        if (now - lastInvalidateAt < 200) return;
        lastInvalidateAt = now;
        queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      });

      return new Promise<SessionData>((resolve, reject) => {
        const offComplete = stream.onComplete((result: { success: boolean; error?: string; sessionId?: string }) => {
          offStep();
          offComplete();
          if (!result.success) {
            // [COMPENSATION-LOGIC] Rollback optimistic insert on failure
            // WHY THIS EXISTS: Without onMutate, there's no optimistic entry to roll back.
            // This was the original rollback for the onMutate-based optimistic insert.
            // queryClient.setQueryData(queryKeys.projects, (old) => {
            //   if (!old) return old;
            //   return old.map((p) => {
            //     if (p.id !== projectId) return p;
            //     return { ...p, sessions: (p.sessions ?? []).filter((s) => s.id !== tempId) };
            //   });
            // });
            reject(new Error(result.error ?? "session create failed"));
            return;
          }
          // [COMPENSATION-LOGIC] In-place replacement of temp→real
          // WHY THIS EXISTS: Prevents race condition where user switches tabs,
          // refetch returns server data without temp entry, creation progress lost.
          // WHAT SHOULD REPLACE IT: Backend provides status in DB, no temp entry needed.
          // queryClient.setQueryData(queryKeys.projects, (old) => {
          //   if (!old) return old;
          //   return old.map((p) => {
          //     if (p.id !== projectId) return p;
          //     return {
          //       ...p,
          //       sessions: (p.sessions ?? []).map((s) => {
          //         if (s.id !== tempId) return s;
          //         return { id: sessionId, projectId, name, branch: "", worktreePath: "",
          //                  ports: null, createdAt: new Date().toISOString(), status: "existing" };
          //       }),
          //     };
          //   });
          // });
          queryClient.invalidateQueries({ queryKey: queryKeys.projects });
          resolve({
            id: sessionId, projectId, name, branch: "", worktreePath: "",
            ports: null, createdAt: new Date().toISOString(), status: "existing",
          });
        });
      });
    },
    onError: (_err, _variables, context) => {
      // [COMPENSATION-LOGIC] Rollback to prevProjects snapshot
      // WHY THIS EXISTS: Rolls back the onMutate optimistic insert.
      // Without onMutate, this is a no-op.
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
      // [COMPENSATION-LOGIC] Optimistic mark: convert to DeletingSession
      // Backend now sets status="deleting" in DB. Invalidate to refetch so
      // the UI sees the deleting spinner immediately.

      // Subscribe to step + complete events BEFORE firing the delete
      const stream = api().sessions.stream(sessionId);
      const offStep = stream.onStep((_step) => {
        // [COMPENSATION-LOGIC] step accumulation disabled — backend provides steps in DB.
        // Instead, invalidate the cache so the UI refetches status + steps.
        // Throttle: only invalidate on first step to avoid hammering.
      });

      // Fire the IPC — returns immediately in async hook mode
      await api().sessions.delete(sessionId);

      // Backend has set status="deleting" — invalidate now to show spinner
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });

      return new Promise<void>((resolve, reject) => {
        const offComplete = stream.onComplete((result: { success: boolean; error?: string; sessionId?: string }) => {
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
          .then((res: { success: boolean; error?: string }) => {
            if (!res.success) {
              offStep();
              offComplete();
              reject(new Error(res.error ?? "delete failed"));
            }
            // Successful resolve waits for the `complete` event so the
            // optimistic cache update happens uniformly through one
            // code path (the onComplete handler above).
          })
          .catch((err: Error) => {
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
