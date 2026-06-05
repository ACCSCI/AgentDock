import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

// Types matching the DB schema
export interface ProjectData {
  id: string;
  name: string;
  path: string;
  createdAt: string;
  sessions: SessionData[];
}

export interface SessionPorts {
  FRONTEND_PORT: number;
  BACKEND_PORT: number;
  WS_PORT: number;
  DEBUG_PORT: number;
  PREVIEW_PORT: number;
}

export interface SessionData {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  worktreePath: string;
  ports: SessionPorts | null;
  createdAt: string;
}

// --- SSE step event types ---
export interface SessionStep {
  step: string;
  status: "running" | "done" | "error";
  duration?: number;
  error?: string;
}

export interface CreatingSession extends SessionData {
  status: "creating";
  steps: SessionStep[];
}

export function isCreatingSession(s: SessionData | CreatingSession | DeletingSession): s is CreatingSession {
  return "status" in s && (s as CreatingSession).status === "creating";
}

export interface DeletingSession extends SessionData {
  status: "deleting";
  steps: SessionStep[];
}

export function isDeletingSession(s: SessionData | CreatingSession | DeletingSession): s is DeletingSession {
  return "status" in s && (s as DeletingSession).status === "deleting";
}

// Query keys
export const queryKeys = {
  projects: ["projects"] as const,
  terminals: (sessionId: string) => ["terminals", sessionId] as const,
};

// GET /api/projects
export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects,
    queryFn: async (): Promise<ProjectData[]> => {
      const res = await fetch("/api/projects");
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data.projects;
    },
  });
}

// POST /api/init
export function useInitDb() {
  return useMutation({
    mutationFn: async (projectPath: string) => {
      const res = await fetch("/api/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectPath }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data;
    },
  });
}

// POST /api/projects
export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ name, path }: { name: string; path: string }) => {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, path }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data.project as ProjectData;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

// DELETE /api/projects/:id
export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (projectId: string) => {
      const res = await fetch(`/api/projects/${projectId}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

// SSE-based create session with optimistic update
export function useCreateSessionSSE() {
  const queryClient = useQueryClient();
  return useMutation<SessionData, Error, { projectId: string; name: string; baseBranch?: string; tempId?: string }, { prevProjects: ProjectData[] | undefined; tempId: string }>({
    mutationFn: async ({ projectId, name, baseBranch, tempId }) => {
      if (!tempId) throw new Error("tempId is required");
      const res = await fetch(`/api/projects/${projectId}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
        body: JSON.stringify({ name, baseBranch }),
      });

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        return data.session as SessionData;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";
      let result: SessionData | null = null;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (currentEvent === "step") {
              queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
                if (!old) return old;
                return old.map((p) => {
                  if (p.id !== projectId) return p;
                  return {
                    ...p,
                    sessions: p.sessions.map((s) => {
                      if (s.id !== tempId) return s;
                      if (!isCreatingSession(s)) return s;
                      const creating = s as CreatingSession;
                      const existingIdx = creating.steps.findIndex((st) => st.step === data.step);
                      const newSteps = [...creating.steps];
                      if (existingIdx >= 0) {
                        newSteps[existingIdx] = data;
                      } else {
                        newSteps.push(data);
                      }
                      return { ...creating, steps: newSteps };
                    }),
                  };
                });
              });
            } else if (currentEvent === "complete") {
              result = data.session;
            } else if (currentEvent === "error") {
              throw new Error(data.error);
            }
          }
        }
      }

      if (!result) throw new Error("No complete event received");
      return result;
    },
    onMutate: async ({ projectId, name, tempId: inputTempId }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.projects });
      const prevProjects = queryClient.getQueryData<ProjectData[]>(queryKeys.projects);
      const tempId = inputTempId ?? `temp-${Date.now()}`;

      queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
        if (!old) return old;
        return old.map((p) => {
          if (p.id !== projectId) return p;
          const tempSession: CreatingSession = {
            id: tempId, projectId, name, branch: "", worktreePath: "", ports: null,
            createdAt: new Date().toISOString(), status: "creating", steps: [],
          };
          return { ...p, sessions: [...p.sessions, tempSession] };
        });
      });

      return { prevProjects, tempId };
    },
    onError: (_err, _variables, context) => {
      if (context?.prevProjects) {
        queryClient.setQueryData(queryKeys.projects, context.prevProjects);
      }
    },
    onSuccess: (session, { projectId, tempId }) => {
      queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
        if (!old) return old;
        return old.map((p) => {
          if (p.id !== projectId) return p;
          return {
            ...p,
            sessions: p.sessions.map((s) =>
              s.id === tempId ? { ...session } : s,
            ),
          };
        });
      });
    },
  });
}

// DELETE /api/sessions/:id
export function useDeleteSessionSSE() {
  const queryClient = useQueryClient();
  return useMutation<void, Error, { sessionId: string; projectId: string }, { prevProjects: ProjectData[] | undefined }>({
    mutationFn: async ({ sessionId, projectId }) => {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "DELETE",
        headers: { "Accept": "text/event-stream" },
      });

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream")) {
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let currentEvent = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
          } else if (line.startsWith("data: ")) {
            const data = JSON.parse(line.slice(6));
            if (currentEvent === "step") {
              queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
                if (!old) return old;
                return old.map((p) => {
                  if (p.id !== projectId) return p;
                  return {
                    ...p,
                    sessions: p.sessions.map((s) => {
                      if (s.id !== sessionId) return s;
                      if (!isDeletingSession(s)) return s;
                      const deleting = s as DeletingSession;
                      const existingIdx = deleting.steps.findIndex((st) => st.step === data.step);
                      const newSteps = [...deleting.steps];
                      if (existingIdx >= 0) {
                        newSteps[existingIdx] = data;
                      } else {
                        newSteps.push(data);
                      }
                      return { ...deleting, steps: newSteps };
                    }),
                  };
                });
              });
            } else if (currentEvent === "complete") {
              return;
            } else if (currentEvent === "error") {
              throw new Error(data.error);
            }
          }
        }
      }
    },
    onMutate: async ({ sessionId, projectId }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.projects });
      const prevProjects = queryClient.getQueryData<ProjectData[]>(queryKeys.projects);

      queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
        if (!old) return old;
        return old.map((p) => {
          if (p.id !== projectId) return p;
          return {
            ...p,
            sessions: p.sessions.map((s) => {
              if (s.id !== sessionId) return s;
              // Don't overwrite if already in a transitional state
              if (isCreatingSession(s) || isDeletingSession(s)) return s;
              const deleting: DeletingSession = { ...s, status: "deleting", steps: [] };
              return deleting;
            }),
          };
        });
      });

      return { prevProjects };
    },
    onError: (_err, _variables, context) => {
      if (context?.prevProjects) {
        queryClient.setQueryData(queryKeys.projects, context.prevProjects);
      }
    },
    onSuccess: (_data, { sessionId, projectId }) => {
      queryClient.setQueryData<ProjectData[]>(queryKeys.projects, (old) => {
        if (!old) return old;
        return old.map((p) => {
          if (p.id !== projectId) return p;
          return {
            ...p,
            sessions: p.sessions.filter((s) => s.id !== sessionId),
          };
        });
      });
    },
  });
}

// PATCH /api/sessions/:id
export function useRenameSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, name }: { sessionId: string; name: string }) => {
      const res = await fetch(`/api/sessions/${sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data.session as SessionData;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

// POST /api/sessions/:id/reassign-ports
export function useReassignPorts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await fetch(`/api/sessions/${sessionId}/reassign-ports`, {
        method: "POST",
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data.session as SessionData;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    },
  });
}

// ---- Terminal API ----

export interface TerminalData {
  terminalId: string;
  sessionId: string;
  shell: string;
  status: "spawning" | "running" | "exited";
  pid: number | null;
  createdAt: string;
}

export async function fetchSessionTerminals(sessionId: string): Promise<TerminalData[]> {
  const res = await fetch(`/api/sessions/${sessionId}/terminals`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error);
  return data.terminals;
}

// GET /api/sessions/:id/terminals
export function useSessionTerminals(sessionId: string) {
  return useQuery({
    queryKey: queryKeys.terminals(sessionId),
    queryFn: () => fetchSessionTerminals(sessionId),
    enabled: !!sessionId,
    refetchInterval: 3000,
    staleTime: 5000,
  });
}

// POST /api/sessions/:id/terminals
export function useCreateTerminal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sessionId, shell }: { sessionId: string; shell?: string }) => {
      const res = await fetch(`/api/sessions/${sessionId}/terminals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shell }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data.terminal as TerminalData;
    },
    onSuccess: (_data, { sessionId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.terminals(sessionId) });
    },
  });
}

// DELETE /api/terminals/:terminalId
export function useDeleteTerminal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (terminalId: string) => {
      const res = await fetch(`/api/terminals/${terminalId}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["terminals"] });
    },
  });
}
