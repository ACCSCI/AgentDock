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

// Query keys
export const queryKeys = {
  projects: ["projects"] as const,
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

// POST /api/projects/:id/sessions
export function useCreateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      projectId,
      name,
      baseBranch,
    }: { projectId: string; name: string; baseBranch?: string }) => {
      const res = await fetch(`/api/projects/${projectId}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, baseBranch }),
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

// DELETE /api/sessions/:id
export function useDeleteSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sessionId: string) => {
      const res = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects });
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
