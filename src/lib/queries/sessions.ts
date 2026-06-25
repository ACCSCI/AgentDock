/**
 * Session-related query and mutation hooks.
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
            realSessionId: sessionId,
          };
          return { ...p, sessions: [...p.sessions, temp] };
        });
      });

      // Subscribe to step + complete events.
      const stream = api().sessions.stream(sessionId);
      const offStep = stream.onStep((step: { step: string; status: string; duration?: number; error?: string }) => {
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
        const offComplete = stream.onComplete((result: { success: boolean; error?: string; sessionId?: string }) => {
          offStep();
          offComplete();
          if (!result.success) {
            // Roll back the optimistic insert before the failure reaches
            // the caller's catch — otherwise the temp card would linger
            // alongside the rolled-back DB row and confuse the user
            // (and break tests that count cards).
            queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
              if (!old) return old;
              return old.map((p) => {
                if (p.id !== projectId) return p;
                return {
                  ...p,
                  sessions: (p.sessions ?? []).filter((s) => s.id !== tempId),
                };
              });
            });
            reject(new Error(result.error ?? "session create failed"));
            return;
          }
          // Replace the tempId placeholder with the real sessionId. The
          // backend inserted a real DB row under the real sessionId, so
          // we have to remove our temp placeholder before invalidating,
          // otherwise the refetch returns BOTH the temp and the real
          // card (same display name, different IDs) and the sidebar
          // shows duplicates.
          queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
            if (!old) return old;
            return old.map((p) => {
              if (p.id !== projectId) return p;
              return {
                ...p,
                sessions: (p.sessions ?? []).filter((s) => s.id !== tempId),
              };
            });
          });
          // Now invalidate so the cache refetches with the real session
          // (DB row) populated under the real sessionId.
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
      } else {
        // No onMutate snapshot available (e.g. mutationFn threw before
        // it could set context). Fall back to removing any temp card
        // we may have inserted for this mutation. We don't have the
        // tempId here, so we rely on the more robust onSuccess-path
        // cleanup to have already removed it. (Failure path: the
        // stream's onComplete handler removes the temp card before
        // rejecting, so by the time onError runs, the card is gone.)
        // This branch is a no-op safety net.
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
      const offStep = stream.onStep((step: { step: string; status: string; duration?: number; error?: string }) => {
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
